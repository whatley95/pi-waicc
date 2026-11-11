// The WAICC mod's state in a Claude Code session (hooks/register.ts).
/** A WAICC session's ID, or none. */
export type WaiccSessionId = string | null;
/** The human's latest message, which the main agent may turn into a planning session this turn. */
export type WaiccRequest = { id: string; text: string } | null;
/** Commands the main agent offered the human, shown in a picker once its turn ends. */
export type WaiccOffers = { question: string; lines: string[] } | null;
/** A review loop the human started with /waicc-dispatch --loop: what it waits for next. */
/** nudged: the cycle in which the main agent was told once to go on after a turn that requested nothing. */
export type WaiccLoop = { sessionId: string; cycle: number; max: number; args: string[]; waiting: "dispatch" | "turn"; nudged?: number } | null;

declare module "claude-code" {
  interface PluginState {
    /**
     * session: the one this chat works on; watched: whose background dispatch the mod watches;
     * request: the live human request for auto-planning; autoPlanning: whether it is on;
     * offers: the picker to open; loop: the review loop in progress.
     */
    waicc: { session: WaiccSessionId; watched: WaiccSessionId; request: WaiccRequest; autoPlanning: boolean; offers: WaiccOffers; loop: WaiccLoop };
  }
}
