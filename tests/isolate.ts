// Loaded before every test file: tests never read the developer's own Pi agent config.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "waicc-agent-dir-"));
