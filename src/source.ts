import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { digest, safePath } from "./files.ts";
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
  let path = realpathSync(cwd);
  while (true) {
    if (existsSync(join(path, ".git")) || existsSync(join(path, ".svn")))
      return path;
    if (dirname(path) === path) return realpathSync(cwd);
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
export function snapshot(root: string): SourceSnapshot {
  const vcs = existsSync(join(root, ".git"))
    ? "git"
    : existsSync(join(root, ".svn"))
      ? "svn"
      : "none";
  let paths: string[] = [];
  let revision: string | null = null;
  let vcsState: string | undefined;
  const tracked = new Set<string>();
  const omit = (path: string): boolean =>
    /^\.pi\/pi-waicc(?:\/|$)/i.test(path) ||
    (excluded(path) && !tracked.has(path));
  if (vcs === "git") {
    const output = command(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      root,
    );
    ensure(
      output !== null,
      "Cannot enumerate Git source files; refusing incomplete source evidence",
    );
    paths = output.split("\0").filter(Boolean);
    revision =
      command("git", ["rev-parse", "--verify", "HEAD"], root)?.trim() ?? null;
    const index = command("git", ["ls-files", "--stage", "-z"], root);
    ensure(index !== null, "Cannot fingerprint the Git index");
    index
      .split("\0")
      .filter(Boolean)
      .forEach((entry) =>
        tracked.add(entry.slice(entry.indexOf("\t") + 1).replaceAll("\\", "/")),
      );
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
          paths.length <= 10_000,
          "Source exceeds 10,000 files; use a smaller project root",
        );
      }
    };
    walk("");
  }
  paths = [...new Set(paths.map((path) => path.replaceAll("\\", "/")))]
    .filter((path) => !omit(path))
    .sort();
  ensure(paths.length <= 10_000, "Source exceeds 10,000 files");
  const files: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const path of paths) {
    const full = safePath(root, path);
    if (!existsSync(full)) {
      files[path] = "DELETED";
      continue;
    }
    const stat = lstatSync(full);
    ensure(
      stat.isFile() && !stat.isSymbolicLink(),
      `Unsupported source entry: ${path}`,
    );
    bytes += stat.size;
    ensure(
      bytes <= 128_000_000,
      "Source fingerprint exceeds 128 MB; use a smaller project root",
    );
    files[path] = digest(readFileSync(full));
  }
  return {
    vcs,
    revision,
    vcsState,
    fingerprint: digest(JSON.stringify({ vcs, revision, vcsState, files })),
    files,
  };
}
