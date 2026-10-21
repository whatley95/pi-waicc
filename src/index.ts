import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApp, type App, type Services } from "./pi/app.ts";
import { createRuns } from "./pi/runs.ts";
import { registerCommands } from "./pi/commands.ts";
import { registerDispatchCommands } from "./pi/dispatch-commands.ts";
import { registerTools } from "./pi/tools.ts";
import { registerHooks } from "./pi/hooks.ts";
import { registerMergeRequestCommands } from "./pi/merge-requests.ts";
import { registerWorktreeCommands } from "./pi/worktrees.ts";

/** The Pi extension: one shared app object, then every command, tool and hook. */
export default function waicc(pi: ExtensionAPI, services: Services = {}): void {
  const core = createApp(pi, services);
  const app: App = Object.assign(core, createRuns(core));
  registerCommands(app);
  registerDispatchCommands(app);
  registerMergeRequestCommands(app);
  registerWorktreeCommands(app);
  registerTools(app);
  registerHooks(app);
}
