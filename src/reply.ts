import { ensure, list, record, text } from "./validation.ts";

export const replyNormalizerVersion = 2;

const checkOutcomes = new Map([
  ["passed", "passed"],
  ["pass", "passed"],
  ["success", "passed"],
  ["succeeded", "passed"],
  ["failed", "failed"],
  ["fail", "failed"],
  ["failure", "failed"],
  ["not_run", "not_run"],
  ["notrun", "not_run"],
  ["not_executed", "not_run"],
  ["not_attempted", "not_run"],
  ["skipped", "not_run"],
]);
const token = (value: string) =>
  value.trim().toLowerCase().replace(/[\s-]+/g, "_");
function checkOutcome(value: unknown): unknown {
  return typeof value === "string"
    ? checkOutcomes.get(token(value)) ?? value
    : value;
}
function enumWord(
  row: Record<string, unknown>,
  field: string,
  allowed: string[],
  label: string,
  changes: string[],
): void {
  const value = row[field];
  if (typeof value !== "string") return;
  const normalized = token(value);
  if (allowed.includes(normalized) && normalized !== value) {
    row[field] = normalized;
    changes.push(`${label}.${field}: casing/whitespace/separators normalized`);
  }
}
function evidenceText(
  row: Record<string, unknown>,
  label: string,
  changes: string[],
): void {
  if (!Array.isArray(row.evidence)) return;
  row.evidence = list(row.evidence, `${label}.evidence`)
    .map((entry) => text(entry, `${label}.evidence entry`))
    .join("\n");
  changes.push(`${label}: evidence text array joined with newlines`);
}
function fieldAlias(
  row: Record<string, unknown>,
  field: string,
  aliases: string[],
  label: string,
  changes: string[],
): void {
  if (row[field] !== undefined) return;
  const alias = aliases.find((name) => row[name] !== undefined);
  if (!alias) return;
  row[field] = row[alias];
  delete row[alias];
  changes.push(`${label}: ${alias} mapped to ${field}`);
}
function preserveAnnotations(
  row: Record<string, unknown>,
  allowed: string[],
  label: string,
  changes: string[],
): void {
  const extensions = new Map(
    Object.entries(
      row.extensions === undefined
        ? {}
        : record(row.extensions, `${label} extensions`),
    ),
  );
  for (const name of Object.keys(row)) {
    if (allowed.includes(name) || name === "extensions") continue;
    ensure(
      !extensions.has(name),
      `${label}: extra field ${JSON.stringify(name)} conflicts with extensions; keep both under distinct extension keys`,
    );
    extensions.set(name, row[name]);
    delete row[name];
    changes.push(
      `${label}: extra field ${JSON.stringify(name)} preserved in extensions`,
    );
  }
  if (extensions.size || row.extensions !== undefined)
    row.extensions = Object.fromEntries(extensions);
}

/** Compatibility at the transport boundary, never an authority or scope conversion. */
export function normalizeReply(value: unknown): {
  reply: Record<string, unknown>;
  changes: string[];
} {
  const reply = structuredClone(record(value, "Reply"));
  const changes: string[] = [];
  const findings = list(reply.findings, "Findings").map((entry, i) =>
    structuredClone(record(entry, `Finding ${i + 1}`)),
  );
  // Reserve explicit IDs first, including IDs on later findings.
  const used = new Set(
    findings.flatMap((f) =>
      typeof (f.id ?? f.findingId) === "string"
        ? [String(f.id ?? f.findingId)]
        : [],
    ),
  );
  reply.findings = findings.map((f, i) => {
    const label = `findings[${i}]`;
    if (f.findingId !== undefined) {
      ensure(
        f.id === undefined || f.id === f.findingId,
        `${label}: id and findingId disagree; use one explicit finding ID`,
      );
      f.id = f.findingId;
      delete f.findingId;
      changes.push(`${label}: findingId mapped to id`);
    }
    if (f.id === undefined) {
      let next = i + 1;
      while (used.has(`F-${String(next).padStart(3, "0")}`)) next++;
      f.id = `F-${String(next).padStart(3, "0")}`;
      used.add(String(f.id));
      changes.push(`${label}: missing id assigned ${f.id}`);
    }
    if (f.description === undefined) {
      const alias =
        f.title !== undefined
          ? "title"
          : f.message !== undefined
            ? "message"
            : undefined;
      if (alias) {
        f.description = f[alias];
        delete f[alias];
        changes.push(`${label}: ${alias} mapped to description`);
      }
    }
    if (typeof f.severity === "string") {
      const severity = f.severity.trim().toLowerCase();
      if (severity !== f.severity) {
        f.severity = severity;
        changes.push(`${label}: severity casing/whitespace normalized`);
      }
    }
    if (Array.isArray(f.evidence)) {
      f.evidence = list(f.evidence, "Finding evidence")
        .map((entry) => text(entry, "Finding evidence"))
        .join("\n");
      changes.push(`${label}: evidence text array joined with newlines`);
    }
    preserveAnnotations(
      f, ["id", "severity", "description", "evidence"], label, changes,
    );
    return f;
  });
  enumWord(
    reply,
    "outcome",
    ["ready", "planned", "needs_changes", "needs_clarification", "blocked"],
    "reply",
    changes,
  );
  reply.coverage = list(reply.coverage, "Coverage").map((entry, i) => {
    const label = `coverage[${i}]`,
      row = record(entry, label);
    enumWord(row, "status", ["addressed", "missing", "unverified"], label, changes);
    evidenceText(row, label, changes);
    return row;
  });
  reply.checks = list(reply.checks, "Checks").map((entry, i) => {
    const label = `checks[${i}]`,
      check = record(entry, label);
    fieldAlias(check, "description", ["name", "check", "command"], label, changes);
    fieldAlias(check, "evidence", ["details", "output"], label, changes);
    for (const alias of ["status", "result"]) {
      if (check[alias] === undefined) continue;
      ensure(
        check.outcome === undefined ||
          checkOutcome(check.outcome) === checkOutcome(check[alias]),
        `${label}: outcome and ${alias} disagree; provide one explicit check result`,
      );
      if (check.outcome === undefined) check.outcome = check[alias];
      delete check[alias];
      changes.push(`${label}: ${alias} mapped to outcome`);
    }
    const outcome = checkOutcome(check.outcome);
    if (outcome !== check.outcome) {
      changes.push(
        `${label}.outcome: ${JSON.stringify(check.outcome)} mapped to ${JSON.stringify(outcome)}`,
      );
      check.outcome = outcome;
    }
    evidenceText(check, label, changes);
    preserveAnnotations(
      check, ["description", "outcome", "evidence"], label, changes,
    );
    return check;
  });
  if (reply.proposedContract !== undefined) {
    const proposed = record(reply.proposedContract, "Proposed contract");
    if (proposed.decisions !== undefined)
      proposed.decisions = list(
        proposed.decisions, "Proposed contract decisions",
      ).map((entry, i) => {
        const label = `proposedContract.decisions[${i}]`,
          decision = record(entry, label);
        if (typeof decision.evidence === "string") {
          decision.evidence = [text(decision.evidence, `${label}.evidence`)];
          changes.push(`${label}: evidence text wrapped in an array`);
        }
        enumWord(decision, "owner", ["agent", "human", "external"], label, changes);
        enumWord(decision, "status", ["open", "resolved", "deferred"], label, changes);
        return decision;
      });
  }
  return { reply, changes };
}
