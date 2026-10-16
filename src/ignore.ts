import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensure } from "./validation.ts";
import { safePath } from "./files.ts";

/** Explicit user command; never silently change tracked SVN properties. */
export function configureSvnIgnore(root: string): {
  target: string;
  added: string;
} {
  ensure(
    existsSync(join(root, ".svn")),
    "This command applies only to an SVN working copy; Git state is ignored automatically.",
  );
  safePath(root, ".pi/pi-waicc");
  const run = (args: string[]) =>
    execFileSync("svn", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  let target = ".";
  let added = ".pi";
  try {
    run(["info", "--show-item", "kind", ".pi"]);
    target = ".pi";
    added = "pi-waicc";
  } catch {
    /* Unversioned .pi is ignored at its versioned parent. */
  }
  const names = run(["proplist", target]);
  const previous = /svn:ignore/.test(names)
    ? run(["propget", "--strict", "svn:ignore", target])
    : "";
  const rules = previous.split(/\r?\n/).filter(Boolean);
  if (!rules.includes(added))
    run(["propset", "svn:ignore", [...rules, added].join("\n"), target]);
  return { target, added };
}
