import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { buildEvent, parseStack, scrub } from "../dist/crash.js";
import { PACKAGE_ROOT } from "../dist/config.js";

test("scrub removes home paths, user paths and URL query strings", () => {
  const home = os.homedir();
  assert.equal(
    scrub(`ENOENT: no such file or directory, open '${home}/game/knight.png'`),
    "ENOENT: no such file or directory, open '<path>'"
  );
  assert.equal(scrub("open /tmp/x/y.json failed"), "open <path> failed");
  assert.equal(scrub("PUT https://storage.googleapis.com/b/o?upload_id=abc failed"), "PUT https://storage.googleapis.com/b/o?<query> failed");
  assert.equal(scrub(`Unexpected token 'h', "hello world" is not valid JSON`), `Unexpected token 'h', "<text>" is not valid JSON`);
  assert.equal(scrub("Cannot read properties of undefined (reading 'id')"), "Cannot read properties of undefined (reading 'id')");
});

test("stack frames keep only the CLI's own files", () => {
  const stack = [
    "TypeError: boom",
    `    at finishJob (file://${PACKAGE_ROOT}/dist/cli.js:10:5)`,
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    `    at /Users/someone/project/node_modules/x/index.js:1:1`
  ].join("\n");
  const frames = parseStack(stack);
  assert.deepEqual(frames.map(f => f.filename), ["<external>", "node:internal/process/task_queues", "dist/cli.js"]);
  assert.equal(frames[2].in_app, true);
  assert.equal(frames[2].function, "finishJob");
});

test("events carry no machine identity", () => {
  const event = buildEvent(new TypeError("boom"), "sprite animate");
  assert.equal(event.tags.command, "sprite animate");
  assert.equal(event.server_name, undefined);
  assert.equal(event.user, undefined);
  assert.match(event.release, /^ludo-cli@/);
});
