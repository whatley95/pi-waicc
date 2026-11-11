import { randomUUID } from "node:crypto";
import type { BeforeAgentStartEvent, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { projectRoot, samePath } from "./source.ts";
export { autoPlanningInstructions } from "./auto-planning-text.ts";

export type AutoPlanningMode = "off" | "on";
type Request = { id: string; text: string };
const key = (ctx: ExtensionContext): string => `${projectRoot(ctx.cwd)}:${ctx.sessionManager.getSessionId()}`;

/** Branch-local human preference, not project configuration or a model-set permission. */
export function autoPlanningMode(ctx: ExtensionContext): AutoPlanningMode {
  const root = projectRoot(ctx.cwd);
  const entry = ctx.sessionManager.getBranch?.().findLast((entry) =>
    entry.type === "custom" && entry.customType === "waicc-auto-planning" &&
    samePath((entry.data as { projectRoot?: string } | undefined)?.projectRoot ?? "", root));
  if (entry?.type !== "custom") return "on";
  const mode = (entry.data as { mode?: string })?.mode;
  // Preserve explicit off; previously enabled complex-only settings use the new policy.
  // An unrecognized saved preference fails closed rather than silently enabling it.
  return mode === "on" || mode === "complex" ? "on" : "off";
}

/** Only a fresh, idle, untransformed human input can authorize planning startup.
 * No transcript scanning, source-file instructions or extension-generated prompts.
 * Planning usefulness is judged by the existing main model, not a second classifier call.
 */
export class AutoPlanningRequests {
  private pending = new Map<string, Request>();
  private active = new Map<string, Request>();
  clear(ctx: ExtensionContext): void {
    this.pending.delete(key(ctx));
    this.active.delete(key(ctx));
  }
  capture(event: InputEvent, ctx: ExtensionContext, recipient: boolean): void {
    this.clear(ctx); // New/queued/extension input invalidates any previous startup token.
    if (!ctx.isProjectTrusted() || recipient || autoPlanningMode(ctx) !== "on" ||
      !["interactive", "rpc"].includes(event.source) || event.streamingBehavior !== undefined ||
      !event.text.trim() || event.text.length > 64_000 || /^\s*(?:\/|\[no-plan\](?:\s|$))/.test(event.text)) return;
    this.pending.set(key(ctx), { id: randomUUID(), text: event.text });
  }
  begin(event: BeforeAgentStartEvent, ctx: ExtensionContext, recipient: boolean): void {
    const request = this.pending.get(key(ctx));
    this.clear(ctx);
    if (!recipient && ctx.isProjectTrusted() && autoPlanningMode(ctx) === "on" && request &&
      event.messageType === "user" && event.prompt === request.text) this.active.set(key(ctx), request);
  }
  current(ctx: ExtensionContext): Request | undefined {
    return ctx.isProjectTrusted() && autoPlanningMode(ctx) === "on" ? this.active.get(key(ctx)) : undefined;
  }
}

