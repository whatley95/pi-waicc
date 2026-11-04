import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Pi's own loader frames and pace (pi-tui's Loader). */
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const frameMs = 80;

type Paint = { fg(color: "accent" | "muted" | "border", text: string): string };
type Screen = { requestRender(): void };

/** Cut to a terminal width; WAICC's own text is one column per character. */
const fit = (text: string, width: number) => ([...text].length > width ? `${[...text].slice(0, Math.max(0, width - 1)).join("")}…` : text);

/**
 * Lines above the editor whose first is a working row like Pi's own (`── ⠇ Working ──`), turning
 * at Pi's pace. Pi draws its row only while the agent's turn streams, so a dispatch, the advisor or
 * a compaction that runs after it would otherwise look idle. The text is read on each frame.
 */
export function workingPanel(title: () => string, lines: () => string[] = () => []) {
  return (screen: Screen, theme: Paint) => {
    const timer = setInterval(() => screen.requestRender(), frameMs);
    timer.unref?.();
    return {
      render(width: number): string[] {
        const frame = frames[Math.floor(Date.now() / frameMs) % frames.length];
        // "── ⠇ " and the space after the text take 6 columns; the border fills the rest.
        const text = fit(title(), Math.max(0, width - 7));
        const rest = Math.max(1, width - 6 - [...text].length);
        return [
          `${theme.fg("border", "──")} ${theme.fg("accent", frame)} ${theme.fg("muted", text)} ${theme.fg("border", "─".repeat(rest))}`,
          ...lines().map((line) => fit(line, width)),
        ];
      },
      invalidate() {},
      dispose() {
        clearInterval(timer);
      },
    };
  };
}

/**
 * Shows the panel: the live row in Pi's terminal UI, plain lines elsewhere (RPC clients take only
 * text, print mode has no UI). Returns a refresh for the plain form; the live one refreshes itself.
 */
export function showWorking(ctx: ExtensionContext, key: string, title: () => string, lines: () => string[] = () => []): () => void {
  const live = ctx.mode === "tui";
  const plain = () => { try { ctx.ui.setWidget?.(key, [title(), ...lines()]); } catch { /* only a hint */ } };
  try {
    if (live) ctx.ui.setWidget?.(key, workingPanel(title, lines) as never);
    else plain();
  } catch { /* only a hint */ }
  return live ? () => {} : plain;
}
