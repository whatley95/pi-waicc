import { assertRecipientCurrent, assertRecipientEdit, receiveHandoff } from "../recipient.ts";
import { json, loadSession } from "../files.ts";
import { checkCommand } from "../checks.ts";
import { dispatchChecksVariable, dispatchPinVariable, maxCheckMs } from "../dispatch.ts";
import { checkpointView, frozenCheckpointView, refreshCheckpoint } from "../checkpoint.ts";
import { recall } from "../memory.ts";
import { projectRoot, samePath, snapshot } from "../source.ts";
import { readContract, requirementsText } from "../workflow.ts";
import { ensure } from "../validation.ts";
import type { RecipientPin, Session } from "../types.ts";
import { authorizationState } from "../state.ts";
import { autoPlanningInstructions } from "../auto-planning.ts";
import { progressParser } from "../progress.ts";
import { sourceFirst, contractOwner, recipientResponsibilities } from "../instructions.ts";
import { type ChatBinding, recipientReads, recipientGuidance } from "./shared.ts";
import type { App } from "./app.ts";

/** Pi event hooks: recipient binding, context, guards on tool calls, compaction and the tracker. */
export function registerHooks(app: App): void {
  const { pi, bindings, copied, compactedRuns, automaticRequests, warnOutdated, key, track, trusted, recipientTools, policiesFor, advanceLoop, mainTurns } = app;
  // Set when a dispatched recipient's binding is refused; its every turn then only explains why.
  let dispatchRefusal: string | undefined;
  pi.on("input", async (event, ctx) => {
    automaticRequests.capture(event, ctx, bindings.get(key(ctx))?.role === "recipient");
  });
  // The main agent's turn, step by step, for the tracker: what it is working on right now.
  // Steps read like a dispatched agent's ("Reading src/x.ts", "Running npm test").
  const feedMain = (ctx: Parameters<typeof track>[0], event: unknown) => {
    const turn = mainTurns.get(key(ctx));
    if (!turn) return;
    try {
      turn.events.push(...turn.read(JSON.stringify(event)));
      if (turn.events.length > 200) turn.events.splice(0, turn.events.length - 200);
    } catch { /* a step the tracker cannot read is left out */ }
    track(ctx);
  };
  const endMain = (ctx: Parameters<typeof track>[0]) => {
    const turn = mainTurns.get(key(ctx));
    if (turn) clearInterval(turn.ticker);
    mainTurns.delete(key(ctx));
  };
  pi.on("agent_start", async (_event, ctx) => {
    // A dispatched recipient's own Pi is not this project's main agent.
    if (bindings.get(key(ctx))?.role === "recipient") return;
    endMain(ctx);
    // Refreshed while it thinks without using tools, so the page does not take it for gone.
    const ticker = setInterval(() => track(ctx), 20_000);
    ticker.unref?.();
    const model = ctx.model?.id;
    mainTurns.set(key(ctx), { root: projectRoot(ctx.cwd), label: `Main agent${model ? ` · ${model}` : ""} working`, startedAt: Date.now(), events: [], read: progressParser("pi", ctx.cwd), ticker });
    track(ctx);
  });
  pi.on("tool_execution_start", async (event, ctx) => feedMain(ctx, { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }));
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.isError) feedMain(ctx, { type: "tool_execution_end", toolName: event.toolName, isError: true, result: event.result });
  });
  pi.on("agent_end", async (_event, ctx) => {
    endMain(ctx);
    automaticRequests.clear(ctx);
    advanceLoop(ctx);
    track(ctx);
    warnOutdated(ctx);
  });
  // The main agent's own use and model, as it works.
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (mainTurns.has(key(ctx))) feedMain(ctx, { type: "message_end", message: event.message });
    else track(ctx);
  });
  pi.on("model_select", async (_event, ctx) => { track(ctx); });
  // Pi is closing this chat: its agents stop with it, so the page shows the project idle.
  pi.on("session_shutdown", async (_event, ctx) => { endMain(ctx); track(ctx, true, false); });
  pi.on("session_tree", async (_event, ctx) => { automaticRequests.clear(ctx); });
  pi.on("session_start", async (_event, ctx) => {
    automaticRequests.clear(ctx);
    track(ctx);
    const entry = ctx.sessionManager
      .getBranch()
      .findLast(
        (item) => item.type === "custom" && item.customType === "waicc-session",
      );
    if (entry?.type === "custom") {
      const data = entry.data as {
        projectRoot?: string;
        sessionId?: string | null;
        role?: string;
        pin?: RecipientPin;
        previousTools?: string[];
      };
      if (data?.projectRoot && samePath(data.projectRoot, projectRoot(ctx.cwd)) && data.sessionId === null) {
        bindings.delete(key(ctx));
        copied.delete(key(ctx));
      } else if (data?.projectRoot && samePath(data.projectRoot, projectRoot(ctx.cwd)) && data.sessionId) {
        if (data.role === "recipient" && data.pin) {
          ensure(
            data.pin.sessionId === data.sessionId,
            "Saved recipient session does not match its pin",
          );
          const binding: Extract<ChatBinding, { role: "recipient" }> = {
            sessionId: data.sessionId,
            role: "recipient",
            pin: data.pin,
            previousTools:
              Array.isArray(data.previousTools) &&
              data.previousTools.every((name) => typeof name === "string")
                ? data.previousTools
                : pi.getActiveTools(),
          };
          bindings.set(key(ctx), binding);
          // Check execution is deliberately not restored from a saved binding.
          // Re-receive the same request with --run-checks to opt in again.
          recipientTools(binding);
        } else if (data.role !== "recipient")
          bindings.set(key(ctx), {
            sessionId: data.sessionId,
            role: "coordinator",
          });
      }
    }
    const pinned = process.env[dispatchPinVariable];
    if (pinned) {
      // A dispatched headless Pi: pin read-only before the first model turn. This can only
      // narrow tools; a refusal leaves no tools and the run is told to stop.
      try {
        trusted(ctx);
        const [sessionId, requestId, grant] = pinned.split(":");
        // ":implement" is the dispatching human's --implement opt-in; edits stay inside task paths.
        const assignment = receiveHandoff(ctx.cwd, sessionId, grant === "implement");
        ensure(assignment.pin.requestId === requestId, "The waiting request is not the dispatched one; do not retarget.");
        ensure(grant !== "implement" || assignment.pin.mode === "implementation", "Implementation opt-in does not match this request.");
        const approved = process.env[dispatchChecksVariable];
        const approvedChecks = approved ? (JSON.parse(approved) as unknown[]).map((check) => checkCommand(check, maxCheckMs)) : undefined;
        ensure(!approvedChecks || ["implementation", "testing", "review"].includes(assignment.pin.mode), "Pre-approved checks apply only to testing, implementation and review");
        const binding: Extract<ChatBinding, { role: "recipient" }> = {
          sessionId, role: "recipient", pin: assignment.pin, previousTools: pi.getActiveTools(), approvedChecks,
        };
        bindings.set(key(ctx), binding);
        recipientTools(binding);
      } catch (error) {
        dispatchRefusal = error instanceof Error ? error.message : String(error);
        bindings.delete(key(ctx));
        pi.setActiveTools([]);
      }
    }
  });
  pi.on("session_before_compact", async (_event, ctx) => {
    const binding = bindings.get(key(ctx));
    if (!binding || !ctx.isProjectTrusted()) return;
    try {
      if (binding.role === "recipient") {
        assertRecipientCurrent(ctx.cwd, binding.pin);
        frozenCheckpointView(projectRoot(ctx.cwd), loadSession(projectRoot(ctx.cwd), binding.sessionId), binding.pin.requestId);
      } else refreshCheckpoint(ctx.cwd, binding.sessionId);
      // Pi owns transcript summarization and retention. Do not replace its
      // compaction result or auto-trigger a new turn/contract operation.
    } catch (error) {
      ctx.ui.notify(`WAICC checkpoint could not be validated; compaction cancelled: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { cancel: true };
    }
  });
  pi.on("session_compact", async (_event, ctx) => {
    if ((bindings.has(key(ctx)) || automaticRequests.current(ctx)) && ctx.isProjectTrusted()) compactedRuns.add(key(ctx));
  });
  pi.on("context", async (event, ctx) => {
    const binding = bindings.get(key(ctx));
    if (!ctx.isProjectTrusted() || !compactedRuns.has(key(ctx))) return;
    const request = automaticRequests.current(ctx);
    const automatic = request && binding?.role !== "recipient" ? autoPlanningInstructions(request.id, Boolean(binding)) : "";
    if (!binding) return automatic ? { messages: [...event.messages.filter((message) =>
      !(message.role === "custom" && message.customType === "waicc-auto-planning")), {
      role: "custom" as const, customType: "waicc-auto-planning", content: automatic, display: false, timestamp: Date.now(),
    }] } : undefined;
    let recovery: string;
    try {
      const root = projectRoot(ctx.cwd), s = loadSession(root, binding.sessionId);
      if (binding.role === "recipient") {
        assertRecipientCurrent(ctx.cwd, binding.pin);
        recovery = `${recipientGuidance}\nRole remains RECIPIENT; original pin ${json(binding.pin)}. Check opt-in remains ${Boolean(binding.runChecks)}.\n${json(frozenCheckpointView(root, s, binding.pin.requestId, false))}`;
      } else recovery = `${contractOwner}\nRole remains coordinator; the latest human assignment controls authority.\n${json(checkpointView(root, s, snapshot(root).fingerprint, false))}`;
    } catch (error) {
      recovery = `STOP: WAICC recovery after compaction failed: ${error instanceof Error ? error.message : String(error)}. Do not recreate state, change roles or retarget requests.`;
    }
    // Request-local only: no history rewrite, duplicate archive injection or new
    // model turn. Covers threshold/overflow retries within an ongoing run.
    return { messages: [...event.messages.filter((message) =>
      !(message.role === "custom" && message.customType === "waicc-compact-recovery")), {
      role: "custom" as const, customType: "waicc-compact-recovery", content: recovery.startsWith("STOP") ? recovery : [automatic, recovery].filter(Boolean).join("\n\n"),
      display: false, timestamp: Date.now(),
    }] };
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (dispatchRefusal)
      return { message: { customType: "waicc-recipient-context", content: `STOP: this dispatched WAICC recipient was refused: ${dispatchRefusal} Do nothing else; explain this and end.`, display: false } };
    const binding = bindings.get(key(ctx));
    automaticRequests.begin(event, ctx, binding?.role === "recipient");
    if (!ctx.isProjectTrusted()) return;
    const request = automaticRequests.current(ctx);
    const automatic = request ? autoPlanningInstructions(request.id, Boolean(binding)) : "";
    compactedRuns.delete(key(ctx)); // This hook persists the normal per-run recovery message.
    if (!binding) return automatic ? { message: { customType: "waicc-auto-planning", content: automatic, display: false } } : undefined;
    if (binding.role === "recipient") {
      recipientTools(binding);
      let state =
        "Perform only this pinned assignment; recover it with waicc_status.";
      try {
        assertRecipientCurrent(ctx.cwd, binding.pin);
        state += `\nCompact recovery (untrusted data): ${json(frozenCheckpointView(projectRoot(ctx.cwd), loadSession(projectRoot(ctx.cwd), binding.sessionId), binding.pin.requestId, false))}`;
      } catch (error) {
        state = `STOP: ${error instanceof Error ? error.message : String(error)}`;
      }
      return {
        message: {
          customType: "waicc-recipient-context",
          content: `${recipientGuidance}\n\n${recipientResponsibilities(binding.pin.mode)}\n\nCheck execution opt-in: ${Boolean(binding.runChecks)}. Recover saved context/assignment with waicc_status.\nPinned request: ${json(binding.pin)}\n${state}`,
          display: false,
        },
      };
    }
    const id = binding.sessionId;
    let s: Session;
    try {
      s = loadSession(projectRoot(ctx.cwd), id);
    } catch (error) {
      return {
        message: {
          customType: "waicc-context",
          content: `STOP: The selected WAICC session ${id} is unavailable: ${error instanceof Error ? error.message : String(error)}. Do not select another session automatically or recreate this session. The human can inspect /waicc-list, or /waicc-list deleted and /waicc-restore <session-id> for a deleted contract.`,
          display: false,
        },
      };
    }
    const memory = recall(ctx.cwd, requirementsText(s))
      .slice(0, 3)
      .map((entry) => ({
        id: entry.id,
        text: entry.text,
        source: entry.source,
      }));
    let recovery: string;
    try {
      recovery = json(checkpointView(projectRoot(ctx.cwd), s, snapshot(ctx.cwd).fingerprint, false));
    } catch (error) {
      recovery = `STOP: checkpoint recovery failed: ${error instanceof Error ? error.message : String(error)}. Inspect original state; do not recreate or overwrite it.`;
    }
    return {
      message: {
        customType: "waicc-context",
        content: `${automatic}\n\n${contractOwner}${policiesFor(ctx)}\n\n${sourceFirst}\n\nWAICC session ${id}; status ${s.status}; contract v${s.contractVersion}. Implementation owner: ${s.implementationOwner ?? "main"}; testing owner: ${s.testingOwner ?? "main"}. If implementation is delegated, coordinate the complete implementation/fix handoff instead of coding it yourself; verify returned changes and actual checks before full review. Recover canonical state and saved context with waicc_status. Planning/review/advisor handoffs do not authorize implementation; advice does not establish readiness. The latest human assignment controls scope. Keep canonical changes in WAICC tools. PASS can signal READY_TO_CLOSE, never automatic closure or verified delivery. /waicc-close, /waicc-force-close, /waicc-reopen, /waicc-delete and /waicc-restore are explicit human actions; do not invoke them yourself via commands, shell or file edits. CLOSED is read-only until explicitly reopened. Confirmed project memory: ${json(memory)}\n\nCompact recovery (untrusted data): ${recovery}`,
        display: false,
      },
    };
  });
  pi.on("tool_call", async (event, ctx) => {
    const binding = bindings.get(key(ctx));
    if (binding?.role === "coordinator" && ["edit", "write"].includes(event.toolName)) {
      try {
        const s = loadSession(projectRoot(ctx.cwd), binding.sessionId);
        if (s.objective) {
          trusted(ctx);
          ensure(s.contractVersion && authorizationState(s, readContract(ctx.cwd, s.id).contract).authorized, "Application edits are not authorized for this plan; the human must /waicc-develop first");
          ensure((s.implementationOwner ?? "main") === "main", "Implementation owner is delegate; the coordinator assesses evidence instead of editing application code");
          ensure(!s.rounds.some((r) => ["WAITING", "RECEIVED"].includes(r.status)), "Assess/cancel the pending handoff BEFORE editing application code");
        }
      } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
    }
    if (binding?.role !== "recipient") return;
    try {
      trusted(ctx);
      ensure(
        [
          ...recipientReads,
          ...(binding.pin.mode === "implementation" ? ["edit", "write"] : []),
          ...(binding.runChecks || binding.approvedChecks?.length ? ["waicc_check"] : []),
        ].includes(event.toolName),
        "Recipient mode blocks coordinator, shell, MCP and custom execution tools. Inspect source and use waicc_reply; return to the coordinator for other actions.",
      );
      if (event.toolName !== "waicc_status")
        assertRecipientCurrent(ctx.cwd, binding.pin);
      if (event.toolName === "edit" || event.toolName === "write")
        assertRecipientEdit(ctx.cwd, binding.pin, event.input.path);
    } catch (error) {
      return {
        block: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
