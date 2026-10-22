import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Personal settings for every project. Pi's own agent directory, honouring PI_CODING_AGENT_DIR. */
export const userConfigPath = (): string =>
  join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "waicc-agents.json");

/**
 * Whether the memory rule may confirm entries: "memory": { "autoApprove": true } in your user
 * file, never a project file. An unreadable file counts as no; loadAgentConfig reports what is wrong.
 */
export function memoryAutoApprove(): boolean {
  try {
    const config = JSON.parse(readFileSync(userConfigPath(), "utf8")) as { memory?: { autoApprove?: unknown } };
    return config.memory?.autoApprove === true;
  } catch {
    return false;
  }
}
