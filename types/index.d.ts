// The WAICC mod's state in a Claude Code session (hooks/register.ts).
/** A WAICC session's ID, or none. */
export type WaiccSessionId = string | null;

declare module "claude-code" {
  interface PluginState {
    /** session: the one this chat works on (/waicc-planning, /waicc-use); watched: whose background dispatch the mod watches. */
    waicc: { session: WaiccSessionId; watched: WaiccSessionId };
  }
}
