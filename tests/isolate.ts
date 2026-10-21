// Loaded before every test file: tests never read the developer's own Pi agent config.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "waicc-agent-dir-"));
// Tests never write the tracker page; tests/tracker.test.ts turns it on where it checks it.
process.env.WAICC_TRACKER = "off";
// Tests never register servers in the developer's own Antigravity config; tests that check the
// registration install their own recorder.
const { agyRegistry } = await import("../src/dispatch.ts");
agyRegistry.register = () => {};
agyRegistry.unregister = () => {};
