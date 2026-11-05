import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// `ludo batch` against a fake API with a job queue: a full queue (429
// PENDING_JOBS_LIMIT), jobs that take a few polls, rate-limited reads, and
// request_ids that bring the same job back on a re-run.

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const SPEC = new URL("../spec/openapi.json", import.meta.url).pathname;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200, 7)]);
const WEBP = fs.readFileSync(new URL("./corpus/webp/made-sheet-lossless.webp", import.meta.url));

let server;
let base;
let seen = [];
// Server state, reset before each test.
let state;
function reset() {
  state = {
    jobs: new Map(), // id -> { job, readsLeft }
    byRequestId: new Map(),
    next: 1,
    queueFullFor: 0, // submissions answered 429 PENDING_JOBS_LIMIT before one is accepted
    readsToFinish: 0, // listing reads before a queued job succeeds
    listRateLimited: 0 // listing reads answered 429 first
  };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function finished(id, taskType) {
  if (taskType === "animateSprite") {
    return { id, status: "succeeded", task_type: taskType, credits_charged: 9, result: { spritesheet_url: `${base}/files/${id}/sheet.webp`, num_frames: 4, num_cols: 2, num_rows: 2, duration: 0.5 } };
  }
  return { id, status: "succeeded", task_type: taskType, credits_charged: 0.5, result: { url: `${base}/files/${id}/out.png`, audio_b64: MP3.toString("base64") } };
}

// A read of a job: queued until it has been read readsToFinish times.
function read(id) {
  const entry = state.jobs.get(id);
  if (!entry) return undefined;
  if (entry.readsLeft > 0) {
    entry.readsLeft--;
    return { id, status: "queued", task_type: entry.taskType, poll_after_ms: 1 };
  }
  return finished(id, entry.taskType);
}

before(async () => {
  reset();
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    seen.push({ method: req.method, path: url.pathname, query: url.search });

    const submit = { "/api/assets/image/remove-background": "removeBackground", "/api/assets/sprite/animate": "animateSprite" }[url.pathname];
    if (req.method === "POST" && submit) {
      const body = JSON.parse(raw);
      // The server checks the queue before it dedupes a request_id.
      if (state.queueFullFor > 0) {
        state.queueFullFor--;
        return json(res, 429, { message: "Error: Your generation queue is full: up to 50 generations can be waiting or running at once.", code: "PENDING_JOBS_LIMIT" }, { "Retry-After": "0" });
      }
      const known = body.request_id && state.byRequestId.get(body.request_id);
      if (known) return json(res, 202, read(known));
      const id = `job-${String(state.next++).padStart(4, "0")}abcd`;
      state.jobs.set(id, { taskType: submit, readsLeft: state.readsToFinish });
      if (body.request_id) state.byRequestId.set(body.request_id, id);
      return json(res, 202, { id, status: "queued", task_type: submit, poll_after_ms: 1 });
    }
    if (req.method === "GET" && url.pathname === "/api/assets/jobs") {
      if (state.listRateLimited > 0) {
        state.listRateLimited--;
        return json(res, 429, { message: "Error: Rate limit reached: 150 requests per 5 min on GET /api/assets/jobs.", code: "RATE_LIMITED", retry_after: 0 }, { "Retry-After": "0" });
      }
      return json(res, 200, [...state.jobs.keys()].reverse().map(read));
    }
    const one = /^\/api\/assets\/jobs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && one) {
      const job = read(decodeURIComponent(one[1]));
      return job ? json(res, 200, job) : json(res, 404, { message: "Job not found" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/files/") && url.pathname.endsWith("/out.png")) {
      res.writeHead(200);
      return res.end(PNG);
    }
    if (req.method === "GET" && url.pathname.endsWith("/sheet.webp")) {
      res.writeHead(200);
      return res.end(WEBP);
    }
    if (req.method === "POST" && url.pathname === "/api/cli/events") return json(res, 200, { ok: true });
    json(res, 404, { message: "not found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  reset();
  seen = [];
});

function run(args, cwd, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        LUDO_SPEC: SPEC,
        LUDO_API_URL: base,
        LUDO_API_KEY: "test-key",
        LUDO_CONFIG_DIR: path.join(cwd, ".config"),
        LUDO_CACHE_DIR: path.join(cwd, ".cache"),
        LUDO_TELEMETRY: "0",
        LUDO_QUEUE_RETRY_MS: "20",
        LUDO_BATCH_POLL_MS: "20",
        CLAUDECODE: "",
        CLAUDE_CODE_ENTRYPOINT: "",
        ...extraEnv
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

function jobsDir(jobs) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-batch-"));
  fs.writeFileSync(path.join(cwd, "jobs.json"), JSON.stringify(jobs));
  return cwd;
}

const removeBg = (n, extra = {}) => ({ command: "image remove-background", image: `https://example.com/${n}.png`, ...extra });

test("a full queue is waited out, and every job is submitted", async () => {
  const cwd = jobsDir([removeBg(1), removeBg(2), removeBg(3)]);
  state.queueFullFor = 4;
  const { code, stdout, stderr } = await run(["batch", "jobs.json", "--json", "--concurrency", "2"], cwd);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.equal(out.summary.succeeded, 3);
  assert.match(stderr, /Queue full \(50 generations queued or running on this account\): \d jobs? still to submit; trying again in/);
  assert.equal(seen.filter(s => s.method === "POST").length, 3 + 4);
});

test("a queue that stays full gives up after --timeout and reports every job", async () => {
  const cwd = jobsDir([removeBg(1), removeBg(2), removeBg(3)]);
  state.queueFullFor = Infinity;
  const { code, stdout, stderr } = await run(["batch", "jobs.json", "--json", "--timeout", "0.3"], cwd);
  assert.equal(code, 8, stderr);
  const out = JSON.parse(stdout);
  assert.equal(out.results.length, 3, "no job is left out of the report");
  for (const r of out.results) {
    assert.equal(r.status, "error");
    assert.equal(r.error.exit_code, 8);
    assert.match(r.error.message, /queue stayed full/);
  }
});

test("one listing read covers every job of the batch", async () => {
  const cwd = jobsDir([removeBg(1), removeBg(2), removeBg(3), removeBg(4)]);
  state.readsToFinish = 3;
  const { code, stdout, stderr } = await run(["batch", "jobs.json", "--json"], cwd);
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).summary.succeeded, 4);
  const lists = seen.filter(s => s.method === "GET" && s.path === "/api/assets/jobs");
  const perJob = seen.filter(s => s.method === "GET" && s.path.startsWith("/api/assets/jobs/"));
  assert.ok(lists.length >= 1 && lists.length <= 6, `${lists.length} listing reads`);
  assert.ok(lists.every(s => /limit=100/.test(s.query)));
  assert.equal(perJob.length, 0, "no job was polled on its own");
});

test("a rate-limited listing read waits and carries on", async () => {
  const cwd = jobsDir([removeBg(1), removeBg(2)]);
  state.readsToFinish = 1;
  state.listRateLimited = 2;
  const { code, stdout, stderr } = await run(["batch", "jobs.json", "--json"], cwd);
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).summary.succeeded, 2);
  assert.match(stderr, /rate limited/);
});

test("the last job left is long-polled on its own", async () => {
  const cwd = jobsDir([removeBg(1)]);
  state.readsToFinish = 2;
  const { code, stderr } = await run(["batch", "jobs.json", "--json"], cwd);
  assert.equal(code, 0, stderr);
  const perJob = seen.filter(s => s.method === "GET" && s.path.startsWith("/api/assets/jobs/"));
  assert.ok(perJob.length >= 1 && perJob.every(s => /wait=\d+/.test(s.query)));
});

function assetLog(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, "ludo-output", "ludo-assets.json"), "utf8")).assets;
}

test("running a jobs file again keeps the files it saved and logs nothing twice", async () => {
  const cwd = jobsDir([
    removeBg(1, { request_id: "rb-1" }),
    { command: "sprite animate", initial_image: "https://example.com/k.png", motion_prompt: "walk", request_id: "walk-1", name: "knight-walk" }
  ]);
  const first = await run(["batch", "jobs.json", "--json"], cwd);
  assert.equal(first.code, 0, first.stderr);
  const files = fs.readdirSync(path.join(cwd, "ludo-output")).sort();
  const log = assetLog(cwd);
  assert.ok(files.includes("knight-walk.webp") && files.includes("knight-walk.png"), files.join(" "));
  assert.ok(files.some(f => /-audio\.mp3$/.test(f)), files.join(" "));

  const from = seen.length;
  const again = await run(["batch", "jobs.json", "--json"], cwd);
  assert.equal(again.code, 0, again.stderr);
  const out = JSON.parse(again.stdout);
  assert.deepEqual(out.results.map(r => r.already_saved), [true, true]);
  assert.deepEqual(fs.readdirSync(path.join(cwd, "ludo-output")).sort(), files, "no -2 copies");
  assert.deepEqual(assetLog(cwd), log, "the asset log is unchanged");
  assert.equal(out.results[1].files.length, 2, "the sheet and its PNG are still reported");
  assert.ok(!seen.slice(from).some(s => s.path.startsWith("/files/")), "nothing downloaded again");

  // A saved file deleted since comes back where it was, logged once.
  const image = files.find(f => f.endsWith(".png") && f.startsWith("removeBackground"));
  fs.rmSync(path.join(cwd, "ludo-output", image));
  const third = await run(["batch", "jobs.json", "--json"], cwd);
  assert.equal(third.code, 0, third.stderr);
  assert.deepEqual(fs.readdirSync(path.join(cwd, "ludo-output")).sort(), files);
  assert.equal(assetLog(cwd).length, log.length);
  assert.equal(assetLog(cwd).filter(e => e.file === image).length, 1);
});

test("a re-run recognises files an older CLI duplicated as -2", async () => {
  const cwd = jobsDir([removeBg(1, { request_id: "rb-dup", name: "hero" })]);
  const first = await run(["batch", "jobs.json", "--json"], cwd);
  assert.equal(first.code, 0, first.stderr);
  // What 0.2.2 left after a re-run: a hero-2.png copy, logged as a second entry.
  const out = path.join(cwd, "ludo-output");
  fs.copyFileSync(path.join(out, "hero.png"), path.join(out, "hero-2.png"));
  const logFile = path.join(out, "ludo-assets.json");
  const log = JSON.parse(fs.readFileSync(logFile, "utf8"));
  log.assets.push({ ...log.assets.find(e => e.file === "hero.png"), file: "hero-2.png" });
  fs.writeFileSync(logFile, JSON.stringify(log));
  const before = fs.readdirSync(out).sort();

  const again = await run(["batch", "jobs.json", "--json"], cwd);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).results[0].already_saved, true);
  assert.deepEqual(fs.readdirSync(out).sort(), before, "no hero-3.png");
  assert.equal(assetLog(cwd).length, log.assets.length);
});

test("a new job (no request_id) still saves beside the earlier files", async () => {
  const cwd = jobsDir([removeBg(1, { name: "hero" })]);
  assert.equal((await run(["batch", "jobs.json", "--json"], cwd)).code, 0);
  const again = await run(["batch", "jobs.json", "--json"], cwd);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).results[0].already_saved, undefined);
  assert.ok(fs.existsSync(path.join(cwd, "ludo-output", "hero-2.png")), "a different job's file is not mistaken for this one's");
});
