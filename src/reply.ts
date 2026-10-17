import { ensure, list, record, text } from "./validation.ts";

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
    const extensions = new Map(
      Object.entries(
        f.extensions === undefined
          ? {}
          : record(f.extensions, "Finding extensions"),
      ),
    );
    for (const name of Object.keys(f)) {
      if (
        ["id", "severity", "description", "evidence", "extensions"].includes(
          name,
        )
      )
        continue;
      ensure(
        !extensions.has(name),
        `${label}: extra field ${JSON.stringify(name)} conflicts with extensions; keep both under distinct extension keys`,
      );
      extensions.set(name, f[name]);
      delete f[name];
      changes.push(
        `${label}: extra field ${JSON.stringify(name)} preserved in extensions`,
      );
    }
    if (extensions.size || f.extensions !== undefined)
      f.extensions = Object.fromEntries(extensions);
    return f;
  });
  return { reply, changes };
}
