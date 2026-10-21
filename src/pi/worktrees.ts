import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addWorktree, here, removeWorktree, worktrees, worktreeState } from "../branches.ts";
import { ensure } from "../validation.ts";
import type { App } from "./app.ts";

/** A new terminal in the folder, running Pi (Windows Terminal, else a PowerShell window); false elsewhere. */
export function openTerminal(path: string): boolean {
  if (process.platform !== "win32") return false;
  const wt = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "wt.exe");
  const [program, args] = existsSync(wt)
    ? [wt, ["-d", path, "powershell", "-NoExit", "-Command", "pi"]]
    : ["cmd.exe", ["/c", "start", "", "/D", path, "powershell", "-NoExit", "-Command", "pi"]];
  try {
    const child = spawn(program, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => { /* the path is shown instead */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** /waicc-worktree: one folder per branch, so switching branch in a monorepo never moves your other work. */
export function registerWorktreeCommands(app: App): void {
  const { pi, services, command } = app;
  command(
    "waicc-worktree",
    "One folder per branch: /waicc-worktree <branch> [--from <base>] creates it, /waicc-worktree lists them, /waicc-worktree remove <branch> removes one",
    async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const at = here(ctx.cwd);

      if (!words.length || words[0] === "list") {
        const rows = worktrees(ctx.cwd).map((w) => {
          if (w.waicc) return `- ${w.path} · WAICC's temporary folder for a delegated coding run`;
          const s = worktreeState(w, at.inside);
          const facts = [
            w.path.toLowerCase() === at.top.toLowerCase() ? "this chat" : "",
            w.main ? "main folder" : "",
            s.openSessions ? plural(s.openSessions, "open WAICC session") : "",
            s.changed ? plural(s.changed, "changed file") : "",
            s.unpushed ? `${s.unpushed} unpushed` : "",
            w.locked ? "locked" : "",
          ].filter(Boolean);
          return `- **${w.branch ?? `detached at ${w.head.slice(0, 10)}`}** · ${w.path}${facts.length ? ` · ${facts.join(" · ")}` : ""}`;
        });
        pi.sendMessage({ customType: "waicc-worktrees", content: [`Branch folders of this repository (${rows.length}):`, ...rows, "", "New: /waicc-worktree <branch> [--from <base>] · Remove: /waicc-worktree remove <branch>"].join("\n"), display: true }, { triggerTurn: false });
        return;
      }

      if (words[0] === "remove") {
        ensure(words[1], "Usage: /waicc-worktree remove <branch or folder>");
        const w = worktrees(ctx.cwd).find((x) => x.branch === words[1] || x.path.toLowerCase() === words[1].toLowerCase());
        ensure(w && !w.waicc && !w.main, w?.main ? "That is the repository's main folder; it is never removed from here" : w?.waicc ? "That is WAICC's temporary folder; it is removed when its run ends" : `No branch folder for ${JSON.stringify(words[1])}; /waicc-worktree lists them`);
        const s = worktreeState(w, at.inside);
        ensure(!s.changed, `${w.path} has ${plural(s.changed ?? 0, "changed or untracked file")}; commit, stash or discard them first. Nothing was removed.`);
        const risks = [
          s.unpushed ? `${plural(s.unpushed, "commit")} not pushed${s.upstream ? ` to ${s.upstream}` : " anywhere"} (they stay on the branch, which is kept)` : "",
          s.openSessions ? `${plural(s.openSessions, "open WAICC session")}, which live in that folder and are removed with it` : "",
        ].filter(Boolean);
        if (risks.length) {
          ensure(ctx.hasUI, `Removing ${w.path} needs your confirmation: ${risks.join("; ")}`);
          if (!(await ctx.ui.confirm(`Remove the folder for ${w.branch}?`, `${w.path} has ${risks.join(", and ")}. Remove the folder anyway? The branch itself is kept.`)))
            return ctx.ui.notify("Nothing was removed.", "info");
        }
        removeWorktree(ctx.cwd, w.path);
        ctx.ui.notify(`Removed ${w.path}. The branch ${w.branch} is kept; /waicc-worktree ${w.branch} brings the folder back.`, "info");
        return;
      }

      if (words[0] === "add" || words[0] === "new") words.shift();
      const flag = (name: string) => {
        const i = words.indexOf(`--${name}`);
        if (i < 0) return undefined;
        const value = words[i + 1];
        ensure(value && !value.startsWith("--"), `--${name} needs a value`);
        words.splice(i, 2);
        return value;
      };
      const from = flag("from"), path = flag("path");
      ensure(words.length === 1, "Usage: /waicc-worktree <branch> [--from <base branch>] [--path <folder>]");
      const made = addWorktree(ctx.cwd, words[0], { from, path });
      const how = made.kind === "existing" ? "your branch" : made.kind === "tracking" ? `a new local branch tracking ${made.base}` : `a new branch from ${made.base}`;
      ctx.ui.notify(`Created ${made.path} on ${how}${made.initialized ? `, with ${made.startIn} set up for WAICC like this service` : ""}. Start Pi in ${made.startIn}.`, "info");
      if (ctx.hasUI && process.platform === "win32"
        && (await ctx.ui.confirm(`Open ${made.branch} in a new terminal?`, `Open a new terminal in ${made.startIn} with Pi running there? Its WAICC sessions and tracker card are separate from this folder's.`)))
        (services.openTerminal ?? openTerminal)(made.startIn);
    },
  );
}
