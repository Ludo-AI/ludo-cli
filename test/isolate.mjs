// Loaded with `node --test --import ./test/isolate.mjs`: every CLI the tests
// start inherits this environment. The CLI refreshes an installed Claude Code
// skill after each command, so without it a test run would rewrite the
// developer's own ~/.claude/skills/ludo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-claude-"));
