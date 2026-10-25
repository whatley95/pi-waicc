import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetWarning } from "../src/state.ts";
import { createSession, status } from "../src/workflow.ts";
import type { Session } from "../src/types.ts";

const session = (codeReviews: number, maxRounds = 20, limit = 8) => ({
  maxRounds,
  roundLimits: { code_review: limit },
  rounds: Array.from({ length: codeReviews }, () => ({ mode: "review", phase: "code_review", review: { kind: "code" } })),
}) as unknown as Session;

test("the human is warned once 2 rounds or fewer are left, in the phase or the session", () => {
  assert.equal(budgetWarning(session(5)), null, "3 left: no warning yet");
  assert.equal(budgetWarning(session(6)), "Round budget: 2 rounds left in code_review (6 of 8 used); /waicc-limit code_review <limit> changes it.");
  assert.equal(budgetWarning(session(7)), "Round budget: 1 round left in code_review (7 of 8 used); /waicc-limit code_review <limit> changes it.");
  assert.equal(budgetWarning(session(8)), "Round budget: 0 rounds left in code_review (8 of 8 used); /waicc-limit code_review <limit> changes it.");
  assert.equal(budgetWarning(session(4, 6, 20)), "Round budget: 2 rounds left in the session (4 of 6 used); /waicc-limit <limit> changes it.");
  assert.match(budgetWarning(session(7, 8))!, /1 round left in code_review .*; 1 round left in the session/);
  assert.equal(budgetWarning(session(0)), null, "no rounds yet");
});

test("status carries the warning for the agent, and none for a new session", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "API.txt"), "api");
  const s = createSession(root, "Add search");
  assert.equal((status(root, s.id) as { budgetWarning: string | null }).budgetWarning, null);
});
