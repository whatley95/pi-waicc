export type ClipboardWriter = (text: string) => Promise<void>;
export interface ClipboardResult {
  status: "copied" | "unavailable" | "not_attempted" | "already_copied";
  message: string;
}

/** Delegate native OS/WSL/terminal support to the host; never emit OSC 52 into RPC/JSON. */
export async function copyHandoffPrompt(
  text: string,
  mode: string,
  write?: ClipboardWriter,
): Promise<ClipboardResult> {
  if (mode !== "tui")
    return {
      status: "not_attempted",
      message:
        "Automatic clipboard copy is available in interactive Pi. Copy the displayed prompt or STARTER.txt contents manually in RPC/JSON/print mode.",
    };
  try {
    if (write) await write(text);
    else {
      const { copyToClipboard } =
        await import("@earendil-works/pi-coding-agent");
      await copyToClipboard(text);
    }
    return {
      status: "copied",
      message:
        "Handoff prompt copied using Pi clipboard support. Paste into the recipient with Ctrl+V (Cmd+V on macOS). Remote terminal clipboard access depends on terminal permissions.",
    };
  } catch (error) {
    return {
      status: "unavailable",
      message: `Clipboard unavailable: ${error instanceof Error ? error.message : String(error)}. The handoff is still valid; copy the displayed prompt or STARTER.txt contents manually.`,
    };
  }
}
