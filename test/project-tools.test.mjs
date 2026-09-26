import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Project tools against a fake Ludo API: .ludo.json, the spending guard, the
// asset log, init, batch, variations, and the version and notice headers.

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const SPEC = new URL("../spec/openapi.json", import.meta.url).pathname;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(100, 7)]);

let server;
let base;
let seen = [];
const jobs = new Map();
let seq = 0;
// Per-test server behaviour.
const headers = { latest: undefined, min: undefined, notice: undefined };

function json(res, status, body) {
  const h = { "Content-Type": "application/json" };
  if (headers.latest) h["x-ludo-cli-latest"] = headers.latest;
  if (headers.min) h["x-ludo-cli-min"] = headers.min;
  if (headers.notice) h["x-ludo-notice"] = headers.notice;
  res.writeHead(status, h);
  res.end(JSON.stringify(body));
}

const encodeNotice = n => Buffer.from(JSON.stringify(n)).toString("base64url");

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url, base);
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw; // an upload's bytes
    }
    seen.push({ method: req.method, path: url.pathname, body, headers: req.headers });

    if (headers.min && url.pathname.startsWith("/api/") && req.headers["x-ludo-cli-version"] === "0.1.0") {
      return json(res, 426, { message: "Update required", min_version: headers.min, latest_version: headers.latest });
    }
    if (req.method === "GET" && url.pathname === "/api/docs/search") {
      return json(res, 200, { query: url.searchParams.get("query"), n: url.searchParams.get("n"), results: [] });
    }
    if (req.method === "POST" && url.pathname === "/api/audio/sound-effect") {
      const id = `job-sfx-${++seq}`;
      const body = JSON.parse(raw);
      if (body.description === "broke") return json(res, 402, { message: "Error: Not enough credits" });
      if (body.description === "invalid") return json(res, 400, { message: "Error: description is not allowed" });
      jobs.set(id, body.description === "fail"
        ? { id, status: "failed", task_type: "createSoundEffect", error: { message: "could not make that", retriable: false } }
        : { id, status: "succeeded", task_type: "createSoundEffect", credits_charged: 2, result: { url: `${base}/files/${id}.mp3` } });
      return json(res, 202, { id, status: "queued", task_type: "createSoundEffect", poll_after_ms: 5 });
    }
    if (req.method === "POST" && url.pathname === "/api/assets/image/style") {
      const id = `job-img-${++seq}`;
      const n = JSON.parse(raw).n || 1;
      jobs.set(id, { id, status: "succeeded", task_type: "generateWithStyle", credits_charged: 0.5 * n, result: Array.from({ length: n }, (_, i) => ({ url: `${base}/files/${id}-${i}.png` })) });
      return json(res, 202, { id, status: "queued", task_type: "generateWithStyle", poll_after_ms: 5 });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/assets/jobs/")) {
      const job = jobs.get(decodeURIComponent(url.pathname.split("/").pop()));
      return job ? json(res, 200, job) : json(res, 404, { message: "no such job" });
    }
    if (req.method === "POST" && url.pathname === "/api/assets/uploads") {
      return json(res, 200, { upload_url: `${base}/upload/u1`, file_url: `${base}/files/uploaded.png` });
    }
    if (req.method === "PUT" && url.pathname === "/upload/u1") {
      res.writeHead(200);
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/api/assets/account") {
      return json(res, 200, { credits: { available: 100 } });
    }
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      res.writeHead(200);
      return res.end(url.pathname.endsWith(".mp3") ? MP3 : PNG);
    }
    json(res, 404, { message: "not found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const tmp = (name = "ludo-proj-") => fs.mkdtempSync(path.join(os.tmpdir(), name));

function run(args, { cwd = tmp(), env = {}, input } = {}) {
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
        LUDO_MAX_CREDITS: "",
        CLAUDECODE: "",
        CLAUDE_CODE_ENTRYPOINT: "",
        ...env
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr, cwd }));
    child.stdin.end(input);
  });
}

const posts = (from, p) => seen.slice(from).filter(s => s.method === "POST" && s.path === p);
const reset = () => Object.assign(headers, { latest: undefined, min: undefined, notice: undefined });

test("an update notice shows once a day, on stderr only, and never with --quiet", async () => {
  headers.latest = "9.0.0";
  const cwd = tmp();
  const first = await run(["audio", "sound-effect", "--description", "boom"], { cwd });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /Update available: ludo 0\.1\.0 → 9\.0\.0/);
  assert.doesNotMatch(first.stdout, /Update available/);
  const second = await run(["audio", "sound-effect", "--description", "boom"], { cwd });
  assert.doesNotMatch(second.stderr, /Update available/);
  const quiet = await run(["audio", "sound-effect", "--description", "boom", "--quiet"]);
  assert.doesNotMatch(quiet.stderr, /Update available/);
  reset();
});

test("service notices print on stderr; critical ones even with --quiet; garbage is ignored", async () => {
  headers.notice = encodeNotice({ id: "n1", level: "warning", message: "Spritesheets are slow today\u001b[31m", url: "https://status.ludo.ai" });
  const cwd = tmp();
  const a = await run(["audio", "sound-effect", "--description", "boom"], { cwd });
  assert.match(a.stderr, /⚠ Ludo: Spritesheets are slow today \[31m https:\/\/status\.ludo\.ai/);
  assert.doesNotMatch(a.stderr, /\u001b\[31m/);
  const again = await run(["audio", "sound-effect", "--description", "boom"], { cwd });
  assert.doesNotMatch(again.stderr, /Spritesheets are slow/);
  headers.notice = encodeNotice({ id: "c1", level: "critical", message: "Generations are paused" });
  const quiet = await run(["audio", "sound-effect", "--description", "boom", "--quiet"]);
  assert.match(quiet.stderr, /⚠ Ludo: Generations are paused/);
  headers.notice = "not-base64-json!!";
  const bad = await run(["audio", "sound-effect", "--description", "boom"]);
  assert.equal(bad.code, 0);
  assert.doesNotMatch(bad.stderr, /Ludo:/);
  reset();
});

test("a version below the API's minimum exits 10 and says how to update", async () => {
  headers.min = "0.2.0";
  headers.latest = "0.3.0";
  const { code, stderr } = await run(["audio", "sound-effect", "--description", "boom"]);
  assert.equal(code, 10);
  assert.match(stderr, /This version of ludo \(0\.1\.0\) is no longer supported; 0\.2\.0 or newer is required/);
  assert.match(stderr, /npm install -g @ludoai\/cli@latest/);
  reset();
});

test("ludo update prints the command for anyone who is not a person at a terminal", async () => {
  const { code, stdout } = await run(["update"]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).command, "npm install -g @ludoai/cli@latest");
});

test(".ludo.json supplies defaults and the output folder; flags win", async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, ".ludo.json"), JSON.stringify({ out: "assets/sfx", defaults: { "audio sound-effect": { duration: 4, loop: true } } }));
  fs.mkdirSync(path.join(cwd, "sub"));
  const from = seen.length;
  const { code, stdout, stderr } = await run(["audio", "sound-effect", "--description", "boom", "--duration", "2"], { cwd: path.join(cwd, "sub") });
  assert.equal(code, 0, stderr);
  assert.deepEqual(posts(from, "/api/audio/sound-effect")[0].body, { description: "boom", duration: 2, loop: true, async: true });
  const file = JSON.parse(stdout).files[0].path;
  assert.ok(fs.existsSync(path.join(cwd, "sub", file)));
  assert.ok(path.resolve(cwd, "sub", file).startsWith(path.join(cwd, "assets", "sfx")));
});

test("a broken .ludo.json is a usage error that names the problem", async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, ".ludo.json"), JSON.stringify({ maxCredits: 5 }));
  const { code, stderr } = await run(["audio", "sound-effect", "--description", "boom"], { cwd });
  assert.equal(code, 2);
  assert.match(stderr, /unknown field "maxCredits"/);
  fs.writeFileSync(path.join(cwd, ".ludo.json"), JSON.stringify({ defaults: { "audio sound-effect": { colour: "red" } } }));
  const bad = await run(["audio", "sound-effect", "--description", "boom"], { cwd });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /has no field "colour"/);
});

test("--dry-run prices the request and submits nothing", async () => {
  const from = seen.length;
  const { code, stdout } = await run(["sprite", "animate", "--initial-image", "https://example.com/k.png", "--motion-prompt", "walk", "--model", "forge", "--duration", "4", "--dry-run", "--json"]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.dry_run, true);
  assert.equal(out.credits, 6);
  assert.equal(out.exact, false);
  assert.equal(seen.slice(from).filter(s => s.method === "POST").length, 0);
});

test("--max-credits refuses a request that costs more, before submitting", async () => {
  const from = seen.length;
  const { code, stderr } = await run(["audio", "sound-effect", "--description", "boom", "--max-credits", "1"]);
  assert.equal(code, 11);
  assert.match(stderr, /This would cost 2 credits, over --max-credits 1/);
  assert.equal(posts(from, "/api/audio/sound-effect").length, 0);
});

test("the spending budget stops a session at its limit, and ludo spend tracks and resets it", async () => {
  const cwd = tmp();
  const env = { LUDO_MAX_CREDITS: "3" };
  assert.equal((await run(["audio", "sound-effect", "--description", "boom"], { cwd, env })).code, 0);
  const over = await run(["audio", "sound-effect", "--description", "boom"], { cwd, env });
  assert.equal(over.code, 11);
  assert.match(over.stderr, /Spending budget reached: 2 credits spent of 3 credits \(LUDO_MAX_CREDITS\)/);
  const s = JSON.parse((await run(["spend", "--json"], { cwd, env })).stdout);
  assert.equal(s.spent, 2);
  assert.equal(s.remaining, 1);
  await run(["spend", "reset"], { cwd, env });
  assert.equal((await run(["audio", "sound-effect", "--description", "boom"], { cwd, env })).code, 0);
});

test("a request whose price is unknown is refused under a limit unless --force", async () => {
  const from = seen.length;
  const { code, stderr } = await run(["video", "upscale", "--video", "https://example.com/v.mp4", "--max-credits", "5"]);
  assert.equal(code, 11);
  assert.match(stderr, /cannot be known before it runs/);
  assert.match(stderr, /--force/);
  assert.equal(seen.slice(from).filter(s => s.method === "POST").length, 0);
});

test("every saved file is logged, and ludo assets redo runs the same request with overrides", async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, ".ludo.json"), "{}");
  fs.writeFileSync(path.join(cwd, "style.png"), PNG);
  const first = await run(["image", "generate-with-style", "--style-image", "style.png", "--prompt", "a knight"], { cwd });
  assert.equal(first.code, 0, first.stderr);
  const log = JSON.parse(fs.readFileSync(path.join(cwd, "ludo-assets.json"), "utf8")).assets;
  assert.equal(log.length, 1);
  assert.equal(log[0].command, "image generate-with-style");
  assert.equal(log[0].operation_id, "generateWithStyle");
  assert.deepEqual(log[0].body, { style_image: "style.png", prompt: "a knight" });
  assert.equal(log[0].credits, 0.5);

  const listed = JSON.parse((await run(["assets", "--json"], { cwd })).stdout);
  assert.equal(listed.assets[0].exists, true);

  const from = seen.length;
  const redo = await run(["assets", "redo", log[0].file, "--prompt", "a blue knight"], { cwd });
  assert.equal(redo.code, 0, redo.stderr);
  const sent = posts(from, "/api/assets/image/style")[0].body;
  assert.equal(sent.prompt, "a blue knight");
  assert.equal(sent.style_image, `${base}/files/uploaded.png`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "ludo-assets.json"), "utf8")).assets.length, 2);
});

test("ludo init writes the config and agent instructions, and re-running changes nothing", async () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, ".cursor"));
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.writeFileSync(path.join(cwd, "project.godot"), "");
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# My game\n\nUse tabs.\n");
  const first = await run(["init", "--json"], { cwd });
  assert.equal(first.code, 0, first.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(cwd, ".ludo.json"), "utf8"));
  assert.equal(config.engine, "godot");
  const agents = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.match(agents, /^# My game\n\nUse tabs\.\n\n<!-- ludo:start/);
  assert.match(agents, /ludo assets/);
  assert.ok(fs.existsSync(path.join(cwd, ".cursor", "rules", "ludo.mdc")));
  assert.match(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8"), /^\.ludo\/$/m);

  const second = JSON.parse((await run(["init", "--json"], { cwd })).stdout);
  assert.ok(second.actions.every(a => a.action === "unchanged" || a.action.startsWith("kept")), JSON.stringify(second.actions));
  assert.equal(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8"), agents);
});

test("ludo init installs the project skill when the project uses Claude Code", async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "# notes\n");
  const { code } = await run(["init"], { cwd });
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(cwd, ".claude", "skills", "ludo", "SKILL.md")));
});

test("ludo batch runs every job, keeps going past a failure and reports each", async () => {
  const cwd = tmp();
  fs.writeFileSync(
    path.join(cwd, "jobs.json"),
    JSON.stringify([
      { command: "audio sound-effect", description: "sword swing" },
      { command: "createSoundEffect", description: "fail" },
      { command: "audio sound-effect", description: "coin", duration: 1 }
    ])
  );
  const { code, stdout, stderr } = await run(["batch", "jobs.json", "--concurrency", "2"], { cwd });
  assert.equal(code, 6, stderr);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.summary, { total: 3, succeeded: 2, failed: 1, credits_charged: 4 });
  assert.equal(out.results[1].status, "failed");
  assert.equal(out.results[1].error.message, "could not make that");
  assert.equal(out.results[2].files.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "ludo-output", "ludo-assets.json"), "utf8")).assets.length, 2);
});

test("ludo batch checks the total against the guard before running anything", async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, "jobs.json"), JSON.stringify([{ command: "audio sound-effect", description: "a" }, { command: "audio sound-effect", description: "b" }]));
  const from = seen.length;
  const dry = JSON.parse((await run(["batch", "jobs.json", "--dry-run"], { cwd })).stdout);
  assert.equal(dry.credits, 4);
  const { code } = await run(["batch", "jobs.json", "--max-credits", "3"], { cwd });
  assert.equal(code, 11);
  assert.equal(posts(from, "/api/audio/sound-effect").length, 0);
});

test("--n runs identical jobs, numbers the files and logs them as one set", async () => {
  const cwd = tmp();
  const from = seen.length;
  const { code, stdout, stderr } = await run(["audio", "sound-effect", "--description", "boom", "--n", "3"], { cwd });
  assert.equal(code, 0, stderr);
  assert.equal(posts(from, "/api/audio/sound-effect").length, 3);
  const out = JSON.parse(stdout);
  assert.equal(out.n, 3);
  assert.equal(out.credits_charged, 6);
  assert.deepEqual(out.variations.map(v => v.variation), [1, 2, 3]);
  for (const v of out.variations) assert.match(v.files[0], new RegExp(`-v${v.variation}\\.mp3$`));
  const log = JSON.parse(fs.readFileSync(path.join(cwd, "ludo-output", "ludo-assets.json"), "utf8")).assets;
  assert.equal(new Set(log.map(e => e.variation_set)).size, 1);
  assert.deepEqual(log.map(e => e.variation).sort(), [1, 2, 3]);
});

test("--n uses the API's own n where it exists, splitting above its maximum", async () => {
  const cwd = tmp();
  const from = seen.length;
  const { code, stdout, stderr } = await run(["image", "generate-with-style", "--style-image", "https://example.com/s.png", "--prompt", "knight", "--n", "6"], { cwd });
  assert.equal(code, 0, stderr);
  assert.deepEqual(posts(from, "/api/assets/image/style").map(p => p.body.n), [4, 2]);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.files.map(f => f.variation), [1, 2, 3, 4, 5, 6]);
  for (const f of out.files) assert.match(f.path, new RegExp(`-v${f.variation}\\.png$`));
});

test("--n prices every variation and applies to generations only", async () => {
  const dry = JSON.parse((await run(["audio", "sound-effect", "--description", "boom", "--n", "5", "--dry-run"])).stdout);
  assert.equal(dry.credits, 10);
  const bad = await run(["account", "--n", "2"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--n applies to generations only/);
});

// ─── Review fixes ────────────────────────────────────────────────────────────

test("--n passes straight through to an operation's own n when it is not a generation", async () => {
  const { code, stdout, stderr } = await run(["docs", "search", "--query", "walk cycles", "--n", "3"]);
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).n, "3");
});

test("--n within the API's own n and --no-wait submit one job and print it", async () => {
  const from = seen.length;
  const { code, stdout, stderr } = await run(["image", "generate-with-style", "--style-image", "https://x.test/s.png", "--prompt", "knight", "--n", "3", "--no-wait"]);
  assert.equal(code, 0, stderr);
  assert.deepEqual(posts(from, "/api/assets/image/style").map(p => p.body.n), [3]);
  assert.equal(JSON.parse(stdout).status, "queued");
  const over = await run(["audio", "sound-effect", "--description", "boom", "--n", "3", "--no-wait"]);
  assert.equal(over.code, 2);
});

test("a job left running counts at its estimate, and waiting on it later replaces rather than adds", async () => {
  const cwd = tmp();
  const env = { LUDO_MAX_CREDITS: "100" };
  const queued = await run(["audio", "sound-effect", "--description", "boom", "--no-wait"], { cwd, env });
  const id = JSON.parse(queued.stdout).id;
  let s = JSON.parse((await run(["spend", "--json"], { cwd, env })).stdout);
  assert.deepEqual([s.spent, s.jobs], [2, 1]);
  await run(["jobs", "wait", id], { cwd, env });
  await run(["jobs", "wait", id], { cwd, env });
  s = JSON.parse((await run(["spend", "--json"], { cwd, env })).stdout);
  assert.deepEqual([s.spent, s.jobs], [2, 1]);
  const ledger = fs.readFileSync(s.file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(ledger.map(l => l.kind), ["estimate", "final", "final"]);
});

test("parallel ludo processes lose neither spend nor asset-log entries", async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, ".ludo.json"), "{}");
  const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => run(["audio", "sound-effect", "--description", `boom ${i}`], { cwd })));
  runs.forEach(r => assert.equal(r.code, 0, r.stderr));
  const s = JSON.parse((await run(["spend", "--json"], { cwd })).stdout);
  assert.deepEqual([s.spent, s.jobs], [12, 6]);
  const log = JSON.parse(fs.readFileSync(path.join(cwd, "ludo-assets.json"), "utf8")).assets;
  assert.equal(log.length, 6);
  assert.ok(!fs.existsSync(path.join(cwd, "ludo-assets.json.lock")));
});

test("a batch stops at the first error every item would hit, with that error's exit code", async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, "jobs.json"), JSON.stringify(Array.from({ length: 10 }, () => ({ command: "audio sound-effect", description: "broke" }))));
  const from = seen.length;
  const { code, stderr } = await run(["batch", "jobs.json", "--concurrency", "2"], { cwd });
  assert.equal(code, 5);
  assert.match(stderr, /Not enough credits/);
  assert.ok(posts(from, "/api/audio/sound-effect").length <= 2);
});

test("a batch where no item became a job exits with the commonest reason", async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, "jobs.json"), JSON.stringify([{ command: "audio sound-effect", description: "invalid" }, { command: "audio sound-effect", description: "invalid" }]));
  const { code, stdout } = await run(["batch", "jobs.json"], { cwd });
  assert.equal(code, 4);
  assert.equal(JSON.parse(stdout).summary.failed, 2);
});

test("paths in .ludo.json must stay inside the project, symlinks included; typed flags are free", async () => {
  const outside = tmp("ludo-outside-");
  fs.writeFileSync(path.join(outside, "id_rsa"), "secret");
  fs.writeFileSync(path.join(outside, "ref.png"), PNG);
  const cwd = tmp();
  const cfg = c => fs.writeFileSync(path.join(cwd, ".ludo.json"), JSON.stringify(c));
  const gen = ["image", "generate-with-style", "--prompt", "knight"];

  cfg({ style_image: path.join(outside, "id_rsa") });
  let r = await run(gen, { cwd });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /style_image in .*\.ludo\.json: .*id_rsa is outside the project/);

  fs.symlinkSync(path.join(outside, "id_rsa"), path.join(cwd, "style.png"));
  cfg({ style_image: "style.png" });
  r = await run(gen, { cwd });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /outside the project/);

  cfg({ defaults: { "image generate-with-style": { style_image: "../x.png" } } });
  r = await run(gen, { cwd });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /defaults\.style_image/);

  cfg({ out: "../elsewhere" });
  r = await run(["audio", "sound-effect", "--description", "boom"], { cwd });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /out in .*: \.\.\/elsewhere is outside the project/);

  cfg({});
  const from = seen.length;
  r = await run([...gen, "--style-image", path.join(outside, "ref.png")], { cwd });
  assert.equal(r.code, 0, r.stderr); // a flag the user typed is theirs
  assert.equal(posts(from, "/api/assets/uploads").length, 1);
});

test("ludo assets redo refuses a logged path outside the project", async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, ".ludo.json"), "{}");
  fs.writeFileSync(
    path.join(cwd, "ludo-assets.json"),
    JSON.stringify({ assets: [{ file: "a.png", command: "image generate-with-style", operation_id: "generateWithStyle", body: { style_image: "../../../../etc/hosts", prompt: "x" }, created_at: "2026-01-01" }] })
  );
  const from = seen.length;
  const { code, stderr } = await run(["assets", "redo", "a.png"], { cwd });
  assert.equal(code, 2);
  assert.match(stderr, /style_image in the asset log: .*is outside the project/);
  assert.equal(seen.slice(from).filter(s => s.method === "POST").length, 0);
});

test(".ludo.json defaults are coerced to their field's type and file fields resolve from the config", async () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, "art"));
  fs.mkdirSync(path.join(cwd, "sub"));
  fs.writeFileSync(path.join(cwd, "art", "style.png"), PNG);
  fs.writeFileSync(
    path.join(cwd, ".ludo.json"),
    JSON.stringify({ defaults: { "audio sound-effect": { duration: "4", loop: "true" }, "image generate-with-style": { style_image: "art/style.png" } } })
  );
  const from = seen.length;
  assert.equal((await run(["audio", "sound-effect", "--description", "boom"], { cwd: path.join(cwd, "sub") })).code, 0);
  assert.deepEqual(posts(from, "/api/audio/sound-effect")[0].body, { description: "boom", duration: 4, loop: true, async: true });
  const img = await run(["image", "generate-with-style", "--prompt", "knight"], { cwd: path.join(cwd, "sub") });
  assert.equal(img.code, 0, img.stderr);
  assert.equal(posts(from, "/api/assets/uploads").length, 1);
  fs.writeFileSync(path.join(cwd, ".ludo.json"), JSON.stringify({ defaults: { "audio sound-effect": { duration: "long" } } }));
  const bad = await run(["audio", "sound-effect", "--description", "boom"], { cwd });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /defaults in .*--duration expects a number, got "long"/);
});

test("jobs wait logs its files as not replayable, and assets redo says so", async () => {
  const cwd = tmp();
  const queued = await run(["audio", "sound-effect", "--description", "boom", "--no-wait"], { cwd });
  const id = JSON.parse(queued.stdout).id;
  assert.equal((await run(["jobs", "wait", id], { cwd })).code, 0);
  const log = JSON.parse(fs.readFileSync(path.join(cwd, "ludo-output", "ludo-assets.json"), "utf8")).assets;
  assert.equal(log[0].redo, false);
  const { code, stderr } = await run(["assets", "redo", path.join("ludo-output", log[0].file)], { cwd });
  assert.equal(code, 2);
  assert.match(stderr, /can't be replayed: it was saved by `ludo jobs wait`/);
});
