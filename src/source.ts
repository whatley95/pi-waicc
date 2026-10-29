import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalPath, digest, runtimePath, safePath } from "./files.ts";
export { canonicalPath, samePath } from "./files.ts";
import { ensure } from "./validation.ts";
import type { SourceSnapshot } from "./types.ts";

function command(binary: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(binary, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 8_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}
export function projectRoot(cwd: string): string {
  let path = canonicalPath(cwd);
  while (true) {
    // A folder initialized with /waicc-init is its own project, even inside a larger
    // repository (one service in a monorepo); otherwise the repository root is.
    if (existsSync(join(path, runtimePath)) || existsSync(join(path, ".git")) || existsSync(join(path, ".svn")))
      return path;
    if (dirname(path) === path) return canonicalPath(cwd);
    path = dirname(path);
  }
}
const excludedDirectories = new Set([
  ".git",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
]);
function excluded(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  return (
    parts.some((part) => excludedDirectories.has(part)) ||
    /^\.pi\/pi-waicc(?:\/|$)/i.test(path)
  );
}
/** Normalize SVN-generated start tags, not arbitrary XML or property text. */
export function normalizeSvnXml(xml: string): string {
  return xml.replace(
    /<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g,
    (_tag, name: string, attributes: string, slash: string) => {
      const sorted = [
        ...attributes.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g),
      ]
        .map((attribute) => `${attribute[1]}=${attribute[2]}`)
        .sort();
      // Do not trim/normalize element text: property whitespace and binary/base64
      // values are evidence, unlike insignificant start-tag formatting.
      return `<${name}${sorted.length ? ` ${sorted.join(" ")}` : ""}${slash}>`;
    },
  );
}
/** Makes this folder its own WAICC project, for example one service in a monorepo. */
export function initProject(cwd: string, initialize: (root: string) => void) {
  const folder = canonicalPath(cwd), before = projectRoot(folder);
  const already = before === folder && existsSync(join(folder, runtimePath));
  if (!already) initialize(folder);
  const source = snapshot(folder), prefix = gitPrefix(folder);
  return {
    projectRoot: folder,
    created: !already,
    ...(before !== folder ? { previousProjectRoot: before } : {}),
    sourceFiles: Object.keys(source.files).length,
    vcs: source.vcs,
    ...(prefix ? { repositoryPath: prefix } : {}),
    nextAction: already
      ? "This folder is already a WAICC project."
      : `This folder is now its own WAICC project${prefix ? ` inside its repository (${prefix})` : ""}: WAICC fingerprints only its ${Object.keys(source.files).length} files, so changes elsewhere do not affect its handoffs. Sessions you already had at ${before} stay there; start new work here, and run Pi from this folder (or below it).`,
  };
}

/** The project's path inside its Git repository ("" at the top), or null outside Git. */
export function gitPrefix(root: string): string | null {
  if (existsSync(join(root, ".git"))) return "";
  // Ask Git only when a parent folder has a repository: starting git costs far more than this walk.
  for (let dir = dirname(root); !existsSync(join(dir, ".git")); dir = dirname(dir))
    if (dirname(dir) === dir) return null;
  const prefix = command("git", ["rev-parse", "--show-prefix"], root);
  return prefix === null ? null : prefix.trim().replaceAll("\\", "/");
}

/** Files read one by one up to `direct`; a Git project above that uses Git's own fingerprints, up to `git`. */
export const sourceLimits = { direct: 10_000, git: 100_000 };

// A file's digest, kept while its size, times and identity stay the same, so a snapshot
// re-reads only what changed. As in Git's "racy" rule, a file modified in the 2 s before the
// snapshot began is never kept: a second same-size edit within one timestamp tick would look
// unchanged.
const digests = new Map<string, { key: string; digest: string }>();
function fileDigest(full: string, stat: Stats, startedAt: number): string {
  const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}:${stat.dev}`;
  const known = digests.get(full);
  if (known?.key === key) return known.digest;
  const value = digest(readFileSync(full));
  if (stat.mtimeMs < startedAt - 2_000 && stat.ctimeMs < startedAt - 2_000) {
    if (digests.size >= 200_000) digests.clear();
    digests.set(full, { key, digest: value });
  } else digests.delete(full);
  return value;
}

export function snapshot(root: string): SourceSnapshot {
  // A sub-project of a Git repository is fingerprinted as that subtree only.
  const prefix = existsSync(join(root, ".svn")) && !existsSync(join(root, ".git")) ? null : gitPrefix(root);
  const vcs = prefix !== null
    ? "git"
    : existsSync(join(root, ".svn"))
      ? "svn"
      : "none";
  let paths: string[] = [];
  let revision: string | null = null;
  let vcsState: string | undefined;
  const tracked = new Set<string>();
  const blobs = new Map<string, { mode: string; blob: string }>();
  const omit = (path: string): boolean =>
    /^\.pi\/pi-waicc(?:\/|$)/i.test(path) ||
    (excluded(path) && !tracked.has(path));
  if (vcs === "git") {
    // One Git call lists both: untracked files as bare paths, index entries as
    // "mode blob stage\tpath" (starting git costs far more than reading its output).
    const output = command(
      "git",
      ["ls-files", "-z", "--stage", "--cached", "--others", "--exclude-standard"],
      root,
    );
    ensure(
      output !== null,
      "Cannot enumerate Git source files; refusing incomplete source evidence",
    );
    const staged: string[] = [];
    for (const entry of output.split("\0")) {
      if (!entry) continue;
      if (/^\d{6} [0-9a-f]{40,64} \d\t/.test(entry)) {
        staged.push(entry);
        paths.push(entry.slice(entry.indexOf("\t") + 1));
      } else paths.push(entry);
    }
    // A sub-project's own tree, not the repository's commit: other projects' commits
    // in the same monorepo must not look like a change here.
    revision = prefix
      ? command("git", ["rev-parse", "--verify", `HEAD:${prefix.replace(/\/$/, "")}`], root)?.trim() ?? null
      : command("git", ["rev-parse", "--verify", "HEAD"], root)?.trim() ?? null;
    // Exactly what `git ls-files --stage -z` prints, so recorded fingerprints stay valid.
    const index = staged.map((entry) => `${entry}\0`).join("");
    for (const entry of staged) {
      const path = entry.slice(entry.indexOf("\t") + 1).replaceAll("\\", "/");
      tracked.add(path);
      // "mode blob stage\tpath": the blob is Git's own fingerprint of the indexed content.
      const [mode, blob] = entry.slice(0, entry.indexOf("\t")).split(" ");
      blobs.set(path, { mode, blob });
    }
    vcsState = digest(index);
  } else {
    if (vcs === "svn") {
      revision =
        command("svn", ["info", "--show-item", "revision"], root)?.trim() ??
        null;
      ensure(revision !== null, "Cannot read SVN working-copy revision");
      const changes = command(
        "svn",
        ["status", "--xml", "--verbose", "--ignore-externals"],
        root,
      );
      ensure(changes !== null, "Cannot fingerprint SVN working-copy metadata");
      const decode = (value: string) =>
        value
          .replaceAll("&quot;", '"')
          .replaceAll("&apos;", "'")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&");
      const allEntries = [
        ...changes.matchAll(
          /<entry\b[^>]*\bpath="([^"]*)"[^>]*>[\s\S]*?<\/entry>/g,
        ),
      ];
      for (const entry of allEntries) {
        const item = entry[0].match(/<wc-status\b[^>]*\bitem="([^"]*)"/);
        if (item && !["unversioned", "ignored", "external"].includes(item[1]))
          tracked.add(decode(entry[1]).replaceAll("\\", "/"));
      }
      const entries = allEntries
        .filter((entry) => {
          const path = decode(entry[1]).replaceAll("\\", "/");
          return path !== ".pi" && !omit(path);
        })
        .map((entry) => normalizeSvnXml(entry[0]))
        .sort();
      const properties = command(
        "svn",
        ["proplist", "--xml", "--verbose", "--recursive", "."],
        root,
      );
      ensure(properties !== null, "Cannot fingerprint SVN property values");
      vcsState = digest(
        JSON.stringify({ entries, properties: normalizeSvnXml(properties) }),
      );
    }
    const walk = (relative: string): void => {
      for (const item of readdirSync(
        relative ? safePath(root, relative) : root,
        { withFileTypes: true },
      )) {
        const path = relative ? `${relative}/${item.name}` : item.name;
        if (omit(path)) continue;
        ensure(
          !item.isSymbolicLink(),
          `Source symlink/junction needs explicit handling: ${path}`,
        );
        if (item.isDirectory()) walk(path);
        else paths.push(path);
        ensure(
          paths.length <= sourceLimits.direct,
          `Source exceeds ${sourceLimits.direct.toLocaleString("en")} files. In a monorepo, run /waicc-init (CLI: waicc init) inside the service folder to make it its own WAICC project.`,
        );
      }
    };
    walk("");
  }
  paths = [...new Set(paths.map((path) => path.replaceAll("\\", "/")))]
    .filter((path) => !omit(path))
    .sort();
  // A large Git project (a whole monorepo) is fingerprinted with Git's own blob IDs instead of
  // reading every file: only what the working folder changed or Git does not track is hashed,
  // by git itself, so every value means the same thing. Smaller projects keep reading each file.
  const large = vcs === "git" && paths.length > sourceLimits.direct;
  ensure(paths.length <= (vcs === "git" ? sourceLimits.git : sourceLimits.direct),
    `Source exceeds ${(vcs === "git" ? sourceLimits.git : sourceLimits.direct).toLocaleString("en")} files (${paths.length}). In a monorepo, run /waicc-init (CLI: waicc init) inside the service folder to make it its own WAICC project.`);
  const files: Record<string, string> = Object.create(null);
  let bytes = 0;
  if (large) {
    const changed = command("git", ["diff-files", "--name-only", "-z", "--relative"], root);
    ensure(changed !== null, "Cannot list the files changed in the Git working folder");
    const dirty = new Set(changed.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/")));
    const toHash: string[] = [];
    for (const path of paths) {
      const indexed = blobs.get(path);
      // Links and submodules are refused here as when every file is read.
      ensure(!indexed || indexed.mode.startsWith("100"), `Unsupported source entry: ${path}`);
      // Unchanged since the index: Git vouches for it without touching the disk (a deleted
      // tracked file is listed as changed, so it is checked below).
      if (indexed && !dirty.has(path)) {
        files[path] = `git:${indexed.blob}`;
        continue;
      }
      if (!existsSync(safePath(root, path))) files[path] = "DELETED";
      else toHash.push(path);
    }
    for (const path of toHash) {
      const stat = lstatSync(safePath(root, path));
      ensure(stat.isFile() && !stat.isSymbolicLink(), `Unsupported source entry: ${path}`);
      ensure(!path.includes("\n"), `Unsupported file name: ${JSON.stringify(path)}`);
      bytes += stat.size;
      ensure(bytes <= 128_000_000, "Changed and untracked files exceed 128 MB; commit or ignore some, or use a smaller project root");
    }
    if (toHash.length) {
      const hashed = execFileSync("git", ["hash-object", "--stdin-paths"], {
        cwd: root, input: `${toHash.join("\n")}\n`, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 64_000_000, stdio: ["pipe", "pipe", "pipe"],
      }).split(/\r?\n/).filter(Boolean);
      ensure(hashed.length === toHash.length, "Cannot fingerprint the changed Git files");
      toHash.forEach((path, i) => (files[path] = `git:${hashed[i]}`));
    }
    return {
      vcs, revision, vcsState,
      fingerprint: digest(JSON.stringify({ vcs, revision, vcsState, files })),
      files,
    };
  }
  const pass = { folders: new Set<string>() };
  const startedAt = Date.now();
  for (const path of paths) {
    const full = safePath(root, path, pass);
    // This lstat is the file's own link check: a link, broken or not, is refused below.
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (!stat) {
      files[path] = "DELETED";
      continue;
    }
    ensure(
      stat.isFile() && !stat.isSymbolicLink(),
      `Unsupported source entry: ${path}`,
    );
    bytes += stat.size;
    ensure(
      bytes <= 128_000_000,
      "Source fingerprint exceeds 128 MB; use a smaller project root",
    );
    files[path] = fileDigest(full, stat, startedAt);
  }
  return {
    vcs,
    revision,
    vcsState,
    fingerprint: digest(JSON.stringify({ vcs, revision, vcsState, files })),
    files,
  };
}
