import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "./files.ts";

/**
 * Which copy of pi-waicc a chat runs. `pi update` replaces the files on disk, but a chat that
 * was already open keeps running the copy it loaded; comparing the two tells it to /reload.
 */
const sourceFolder = fileURLToPath(new URL(".", import.meta.url));
const templateFolder = fileURLToPath(new URL("../templates", import.meta.url));

function files(folder: string, prefix = ""): [string, string][] {
  let names: import("node:fs").Dirent[];
  try {
    names = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return names.flatMap((entry): [string, string][] => {
    const path = join(folder, entry.name), name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return files(path, `${name}/`);
    if (!/\.(ts|js|html|json)$/.test(entry.name)) return [];
    try {
      return [[name, readFileSync(path, "utf8")]];
    } catch {
      return [];
    }
  });
}

/** A short digest of this package's code and templates as they are on disk now. */
export function buildOnDisk(sources = sourceFolder, templates = templateFolder): string {
  const all = [...files(sources, "src/"), ...files(templates, "templates/")].sort(([a], [b]) => a.localeCompare(b));
  return digest(all.map(([name, text]) => `${name}\0${digest(text)}`).join("\n")).slice(0, 12);
}

const version = (() => {
  try {
    return (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
})();
/** The copy this chat loaded, fixed when the module was loaded. */
export const loadedBuild = { version, build: buildOnDisk() };

let checkedAt = 0, outdated = false;
/** Whether the files on disk have changed since this chat loaded them; checked at most once a minute. */
export function buildOutdated(now = Date.now(), onDisk: () => string = buildOnDisk): boolean {
  if (outdated || now - checkedAt < 60_000) return outdated;
  checkedAt = now;
  outdated = onDisk() !== loadedBuild.build;
  return outdated;
}
