// Loaded before every test file: tests never read the developer's own Pi agent config.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "waicc-agent-dir-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// One per test file and run: removed when the file's process ends, so runs leave no folders behind.
process.on("exit", () => {
  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch { /* a file still held open on Windows; the system's temp clean-up takes it */ }
});
// Tests never write the tracker page; tests/tracker.test.ts turns it on where it checks it.
process.env.WAICC_TRACKER = "off";
// Tests never register servers in the developer's own Antigravity config; tests that check the
// registration install their own recorder.
const { agyRegistry } = await import("../src/dispatch.ts");
agyRegistry.register = () => {};
agyRegistry.unregister = () => {};
