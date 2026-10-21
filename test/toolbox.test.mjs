import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { parseToolArgv } from "../dist/toolbox/index.js";
import { parseArgv } from "../dist/args.js";
import { EXIT } from "../dist/errors.js";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

// A server that accepts connections and never answers: an API that hangs.
let blackhole;
// One that records the usage events it is sent.
let collector;
const events = [];
before(async () => {
  blackhole = net.createServer(() => {});
  await new Promise(resolve => blackhole.listen(0, "127.0.0.1", resolve));
  collector = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      if (req.url === "/api/cli/events") events.push(...JSON.parse(body).events);
      res.end("{}");
    });
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
});
after(() => {
  blackhole.close();
  collector.close();
});

function run(args, extraEnv = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-toolbox-test-"));
  // A spec file that would crash the CLI if anything tried to load it.
  const badSpec = path.join(cwd, "spec.json");
  fs.writeFileSync(badSpec, "{ not json");
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        LUDO_SPEC: badSpec,
        LUDO_API_URL: `http://127.0.0.1:${blackhole.address().port}`,
        LUDO_API_KEY: "",
        LUDO_CONFIG_DIR: path.join(cwd, ".config"),
        LUDO_CACHE_DIR: path.join(cwd, ".cache"),
        LUDO_TELEMETRY: "0",
        CLAUDECODE: "",
        CLAUDE_CODE_ENTRYPOINT: "",
        ...extraEnv
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr, cwd, ms: Date.now() - started }));
  });
}

test("ludo toolbox runs without the API spec, an API key or the network", async () => {
  const help = await run(["toolbox", "--help"]);
  assert.equal(help.code, EXIT.OK, help.stderr);
  assert.match(help.stdout, /offline, with no account and no credits/);
  const bare = await run(["toolbox"]);
  assert.equal(bare.code, EXIT.USAGE);
});

test("an API that hangs costs a toolbox command at most the telemetry timeout", async () => {
  const quiet = await run(["toolbox", "--help"]);
  const hanging = await run(["toolbox", "--help"], { LUDO_TELEMETRY: "", DO_NOT_TRACK: "" });
  assert.equal(hanging.code, EXIT.OK, hanging.stderr);
  assert.ok(hanging.ms - quiet.ms < 1500, `${hanging.ms} ms vs ${quiet.ms} ms`);
});

test("an unknown group is a usage error that lists the groups", async () => {
  const { code, stderr } = await run(["toolbox", "nope"]);
  assert.equal(code, EXIT.USAGE);
  assert.match(stderr, /Unknown toolbox group: nope/);
});

test("toolbox runs are counted as toolbox in usage telemetry", async () => {
  const from = events.length;
  const { code } = await run(["toolbox", "--help"], { LUDO_TELEMETRY: "", DO_NOT_TRACK: "", LUDO_API_URL: `http://127.0.0.1:${collector.address().port}` });
  assert.equal(code, EXIT.OK);
  assert.equal(events.slice(from)[0]?.command, "toolbox");
});

test("tool flags keep the positionals in order and reject what the tool does not know", () => {
  const tool = {
    group: "sprite",
    name: "join",
    flags: [
      { flag: "--cols", value: "n", description: "" },
      { flag: "--pingpong", description: "" }
    ]
  };
  const argv = ["--json", "toolbox", "sprite", "join", "--pingpong", "a.png", "--out", "dir", "b.png", "--cols=3", "c.png"];
  assert.equal(parseArgv(argv).globals.out, "dir");
  const call = parseToolArgv(argv, tool);
  assert.deepEqual(call.args, ["a.png", "b.png", "c.png"]);
  assert.deepEqual([...call.flags], [["--pingpong", true], ["--cols", "3"]]);
  assert.throws(() => parseToolArgv(["toolbox", "sprite", "join", "--grid", "2x2"], tool), /Unknown flag .*--grid/);
  assert.throws(() => parseToolArgv(["toolbox", "sprite", "join", "--cols"], tool), /--cols needs a value/);
  assert.throws(() => parseToolArgv(["toolbox", "sprite", "join", "--pingpong=yes"], tool), /does not take a value/);
});
