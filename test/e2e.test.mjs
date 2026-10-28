import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { encodePng, readPng } from "../dist/tty/png.js";
import { readWebp } from "../dist/tty/webp.js";
import { readGrid } from "../dist/tty/preview.js";

// Drives the built CLI against a fake Ludo API: upload, submit, long-poll and
// download, the way a real generation runs.

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const SPEC = new URL("../spec/openapi.json", import.meta.url).pathname;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200, 7)]);

let server;
let base;
const seen = [];
const blobs = new Map();
let polls = 0;
const SHEET = encodePng({ width: 4, height: 4, rgba: new Uint8Array(64).fill(200) });
let loginPolls = 0;
let loginOutcome = "approved";
let flakyPolls = 0;
let flakyUploads = 0;
let flakyJobGets = 0;
let rateLimitedUploads = false;
let slowSpecMs = 0;
// When set, the spec the server answers with instead of spec/openapi.json.
let servedSpec = null;
const ACCOUNT = {
  credits: { available: 1840.5, plan_credits: 2000, used: 460, extra: 300.5, resets_at: 1790000000, team_pool: false, paused: false, grace_until: null },
  plan: { name: "Pro", api_access: true },
  auto_topup: { enabled: true, threshold: 200, credits: 1000 },
  billing_url: "http://web.test/account/billing"
};

const PRICING = {
  currency: "usd",
  summary: "Ludo generates game assets.",
  plans: [
    { id: "free-trial", name: "Free Trial", api_access: false, credits_per_month: null, credits_at_signup: 30, seats: 1, active_projects: "1", queue_concurrency: 1, prices: [], included: ["1 seat"], not_included: [] },
    { id: "pro", name: "Pro", api_access: true, credits_per_month: 1000, credits_at_signup: null, seats: 1, active_projects: "unlimited", queue_concurrency: 2, prices: [{ interval: "month", amount: 50, credits_granted: 1000 }, { interval: "year", amount: 420, per_month: 35, credits_granted: 12000 }], included: ["API, MCP and CLI access"], not_included: [] }
  ],
  top_ups: { currency: "usd", min_credits: 250, max_credits: 17000, step_credits: 50, brackets: [{ credits: 250, cents: 1500 }], eligible: "any active paid plan" },
  rules: [{ id: "api_always_pays", text: "Every generation through the API, MCP or CLI costs credits." }],
  costs: [{ operation: "createImage", credits: "0.5 credits per result" }],
  links: { pricing: "https://ludo.ai/pricing", billing: "http://web.test/account/billing" }
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    seen.push({ method: req.method, path: url.pathname, headers: req.headers, raw });

    if (req.method === "GET" && url.pathname === "/api-documentation/openapi.json") {
      if (slowSpecMs) await new Promise(r => setTimeout(r, slowSpecMs));
      if (req.headers["if-none-match"] === '"v2"') {
        res.writeHead(304);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json", ETag: '"v2"' });
      return res.end(servedSpec || fs.readFileSync(SPEC));
    }
    if (req.method === "POST" && url.pathname === "/api/assets/sprite/animate") {
      // "webp" in the prompt: answer like hydra, whose sheets come as WebP.
      const webp = JSON.parse(raw).motion_prompt === "webp";
      return json(res, 200, {
        id: "job-sheet001",
        status: "succeeded",
        task_type: "animateSprite",
        credits_charged: 9,
        result: { spritesheet_url: `${base}/files/sheet.${webp ? "webp" : "png"}`, audio_url: `${base}/files/sfx.mp3`, num_frames: 4, num_cols: 2, num_rows: 2, duration: 0.5 }
      });
    }
    if (req.method === "GET" && url.pathname === "/files/sfx.mp3") {
      res.writeHead(200);
      return res.end(MP3);
    }
    if (req.method === "GET" && url.pathname === "/files/sheet.webp") {
      res.writeHead(200);
      return res.end(fs.readFileSync(new URL("./corpus/webp/made-sheet-lossless.webp", import.meta.url)));
    }
    if (req.method === "GET" && url.pathname === "/files/sheet.png") {
      res.writeHead(200);
      return res.end(SHEET);
    }
    if (req.method === "POST" && url.pathname === "/api/assets/sprite/directional") {
      // Directional Sprites: one sheet per direction, each with its fps.
      const sheet = d => ({ direction: d, spritesheet_url: `${base}/files/dir-${d}.png`, num_frames: 4, num_cols: 2, num_rows: 2, fps: 8, render_3d: { style_id: "cel_anime", direction: d } });
      return json(res, 200, { id: "job-direct01", status: "succeeded", task_type: "createDirectionalSprites", credits_charged: 2, result: { sheets: [sheet("SW"), sheet("N")] } });
    }
    if (req.method === "POST" && url.pathname === "/api/assets/sprite/directional-preview") {
      // A newer preview of the same account replaced this one.
      if (JSON.parse(raw).style_id === "replaced") {
        res.writeHead(204);
        return res.end();
      }
      const preview = d => ({ direction: d, frame_urls: [1, 2].map(n => `${base}/files/pv-${d}-${n}.png`), num_frames: 2, fps: 1.6, render_3d: { style_id: "cel_anime", direction: d } });
      return json(res, 200, { previews: [preview("SW"), preview("N")] });
    }
    if (req.method === "GET" && /^\/files\/(dir|pv)-/.test(url.pathname)) {
      res.writeHead(200);
      return res.end(SHEET);
    }
    if (req.method === "POST" && url.pathname === "/api/cli/auth/start") {
      const body = JSON.parse(raw);
      loginPolls = 0;
      return json(res, 200, {
        device_code: `dev-${body.platform}`,
        user_code: "WDJB-MJHT",
        verification_url: "http://web.test/cli",
        verification_url_complete: "http://web.test/cli?code=WDJB-MJHT",
        expires_in: 600,
        interval: 0.01
      });
    }
    if (req.method === "POST" && url.pathname === "/api/cli/auth/token") {
      if (flakyPolls > 0) {
        flakyPolls--;
        return req.socket.destroy();
      }
      loginPolls++;
      if (loginOutcome === "denied") return json(res, 200, { status: "denied" });
      if (loginPolls < 2) return json(res, 200, { status: "pending" });
      return json(res, 200, { status: "approved", api_key: "ludo_minted" });
    }
    if (req.method === "GET" && url.pathname === "/api/pricing") {
      // Open with or without a key, like the server.
      return json(res, 200, PRICING);
    }
    if (req.method === "GET" && url.pathname === "/api/assets/account") {
      if (!["ApiKey ludo_minted", "ApiKey test-key"].includes(req.headers.authorization)) return json(res, 403, { message: "Unauthorized" });
      return json(res, 200, ACCOUNT);
    }
    if (req.method === "POST" && url.pathname === "/api/cli/events") {
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/assets/feedback") {
      return json(res, 200, { ok: true, id: "fb-1" });
    }
    if (req.method === "DELETE" && url.pathname === "/api/assets/cli-key") {
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/auth/validate-api-key") {
      if (req.headers.authorization === "ApiKey no-plan") return json(res, 402, { message: "Error: API access is unavailable" });
      if (req.headers.authorization !== "ApiKey test-key") return json(res, 403, { message: "Unauthorized" });
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/api/42/envelope/") {
      res.writeHead(200);
      return res.end("{}");
    }
    if (req.method === "POST" && url.pathname === "/api/assets/uploads" && rateLimitedUploads) {
      return json(res, 429, {
        message: "Error: Rate limit reached: 500 requests per 1 day on POST /api/assets/uploads. Try again in 5 h. Contact us if you need more volume.",
        code: "RATE_LIMITED",
        limit: 500,
        window_seconds: 86400,
        retry_after: 18000,
        reset_at: "2026-10-07T01:00:00.000Z"
      });
    }
    if (req.method === "POST" && url.pathname === "/api/assets/uploads" && flakyUploads > 0) {
      flakyUploads--;
      return json(res, 502, { message: "backend_connection_closed_before_data_sent_to_client" });
    }
    if (req.method === "POST" && url.pathname === "/api/assets/uploads") {
      const body = JSON.parse(raw);
      return json(res, 200, {
        upload_url: `${base}/upload/u1`,
        file_url: `${base}/files/u1.png`,
        mime_type: body.mime_type,
        size: body.size
      });
    }
    if (req.method === "PUT" && url.pathname === "/upload/u1") {
      blobs.set("/files/u1.png", raw);
      res.writeHead(200);
      return res.end();
    }
    if (req.method === "HEAD" && url.pathname.startsWith("/files/")) {
      const blob = blobs.get(url.pathname);
      res.writeHead(blob ? 200 : 404, blob ? { "content-length": blob.length } : {});
      return res.end();
    }
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      res.writeHead(200);
      return res.end(url.pathname === "/files/out.png" ? PNG : blobs.get(url.pathname));
    }
    if (req.method === "POST" && url.pathname === "/api/assets/image/remove-background" && JSON.parse(raw).image === "https://example.com/502.png") {
      return json(res, 502, { message: "bad gateway" });
    }
    if (req.method === "GET" && url.pathname === "/api/assets/jobs/job-forever") {
      return json(res, 200, { id: "job-forever", status: "running", task_type: "removeBackground", poll_after_ms: 20 });
    }
    if (req.method === "GET" && url.pathname === "/api/assets/jobs/job-flaky" && flakyJobGets > 0) {
      flakyJobGets--;
      return json(res, 503, { message: "unavailable" });
    }
    if (req.method === "GET" && url.pathname === "/api/assets/jobs/job-flaky") {
      return json(res, 200, { id: "job-flaky", status: "canceled", task_type: "removeBackground" });
    }
    if (req.method === "POST" && url.pathname === "/api/assets/image/remove-background") {
      if (req.headers.authorization !== "ApiKey test-key") return json(res, 403, { message: "Invalid API key" });
      return json(res, 202, { id: "job-12345678", status: "queued", task_type: "removeBackground", poll_after_ms: 10 });
    }
    if (req.method === "POST" && url.pathname === "/api/assets/image") {
      // "variations" in the prompt: one finished job holding one image per n.
      const body = JSON.parse(raw);
      if (body.prompt === "variations") {
        const result = Array.from({ length: body.n || 1 }, (_, i) => ({ url: `${base}/files/out.png?i=${i}` }));
        return json(res, 200, { id: `job-imgs${body.n}000`, status: "succeeded", task_type: "createImage", credits_charged: body.n, result });
      }
      return json(res, 402, { message: "Error: Not enough credits" });
    }
    if (req.method === "GET" && url.pathname === "/api/assets/jobs/job-12345678") {
      polls++;
      if (polls < 2) return json(res, 200, { id: "job-12345678", status: "running", task_type: "removeBackground", poll_after_ms: 10 });
      return json(res, 200, {
        id: "job-12345678",
        status: "succeeded",
        task_type: "removeBackground",
        credits_charged: 0.5,
        result: { url: `${base}/files/out.png`, audio_b64: MP3.toString("base64") }
      });
    }
    json(res, 404, { message: "not found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function run(args, extraEnv = {}, cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-")), input) {
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
        // The suite may itself run under a coding agent; the CLI must not see that.
        CLAUDECODE: "",
        CLAUDE_CODE_ENTRYPOINT: "",
        ...extraEnv
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr, cwd }));
    if (input !== undefined) child.stdin.end(input);
  });
}

test("uploads a local file, waits for the job and saves every result file", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-src-"));
  const src = path.join(cwd, "photo.png");
  fs.writeFileSync(src, PNG);

  const { code, stdout, stderr, cwd: runDir } = await run(["image", "remove-background", "--image", src, "--json"]);
  assert.equal(code, 0, stderr);

  const upload = seen.find(s => s.path === "/api/assets/uploads");
  assert.deepEqual(JSON.parse(upload.raw), { mime_type: "image/png", size: PNG.length });
  assert.deepEqual(blobs.get("/files/u1.png"), PNG);

  const submit = seen.find(s => s.path === "/api/assets/image/remove-background");
  const body = JSON.parse(submit.raw);
  assert.equal(body.image, `${base}/files/u1.png`, "the local path was replaced by the uploaded URL");
  assert.equal(body.async, true);
  assert.equal(submit.headers["x-ludo-tool"], "cli");

  const out = JSON.parse(stdout);
  assert.equal(out.status, "succeeded");
  assert.equal(out.files.length, 2);
  const image = out.files.find(f => f.path.endsWith(".png"));
  assert.deepEqual(fs.readFileSync(path.join(runDir, image.path)), PNG);
  // absolute_path points at the same file, wherever the caller resolves from.
  for (const f of out.files) assert.equal(fs.realpathSync(f.absolute_path), fs.realpathSync(path.join(runDir, f.path)));
  // The inline base64 was saved as a file and replaced by its path.
  assert.match(out.result.audio_b64, /ludo-output\/removeBackground-job-1234-audio\.mp3$/);
  assert.deepEqual(fs.readFileSync(path.join(runDir, out.result.audio_b64)), MP3);
  assert.ok(!stdout.includes(MP3.toString("base64")));
});

test("--no-wait prints the job and does not poll", async () => {
  const before = seen.length;
  const { code, stdout } = await run(["image", "remove-background", "--image", "https://example.com/a.png", "--no-wait", "--json"]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).id, "job-12345678");
  assert.ok(!seen.slice(before).some(s => s.path.startsWith("/api/assets/jobs/")));
});

test("maps API errors to exit codes with a JSON error on stdout", async () => {
  const { code, stdout } = await run(["image", "create", "--prompt", "x", "--image-type", "sprite", "--json"]);
  assert.equal(code, 5);
  assert.equal(JSON.parse(stdout).error.message, "Not enough credits");
});

test("fails fast on a missing local file", async () => {
  const { code, stderr } = await run(["image", "remove-background", "--image", "./missing.png"]);
  assert.equal(code, 2);
  assert.match(stderr, /file not found: \.\/missing\.png/);
});

test("rejects a bad key with the auth exit code", async () => {
  const { code } = await run(["image", "remove-background", "--image", "https://example.com/a.png"], { LUDO_API_KEY: "wrong" });
  assert.equal(code, 3);
});

test("usage errors exit 2", async () => {
  const { code, stderr } = await run(["image", "nope"]);
  assert.equal(code, 2);
  assert.match(stderr, /Unknown command: ludo image nope/);
});

test("help is generated for every command", async () => {
  const { code, stdout } = await run(["sprite", "animate", "--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /--initial-image <file\|url>/);
  assert.match(stdout, /Credits:/);
  assert.doesNotMatch(stdout, /--async/);
});

test("agent-help lists every group", async () => {
  const { code, stdout } = await run(["agent-help"]);
  assert.equal(code, 0);
  for (const g of ["image", "sprite", "video", "model", "audio", "jobs", "docs"]) assert.match(stdout, new RegExp(`- ${g}:`));
});

// Seeds a cache holding a spec from before removeBackground existed, fetched
// at fetchedAt (just now by default).
function staleCache(etag, fetchedAt = Date.now()) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"));
  const dir = path.join(cwd, ".cache");
  fs.mkdirSync(dir);
  const key = crypto.createHash("sha1").update(base).digest("hex").slice(0, 12);
  const old = JSON.parse(fs.readFileSync(SPEC, "utf8"));
  delete old.paths["/assets/image/remove-background"];
  fs.writeFileSync(path.join(dir, `openapi-${key}.json`), JSON.stringify(old));
  fs.writeFileSync(path.join(dir, `openapi-${key}.meta.json`), JSON.stringify({ etag, fetched_at: fetchedAt }));
  return cwd;
}

const specFetches = from => seen.slice(from).filter(s => s.path === "/api-documentation/openapi.json");

test("a command the cached spec does not know refreshes the spec and runs", async () => {
  const from = seen.length;
  const args = ["image", "remove-background", "--image", "https://example.com/a.png", "--no-wait", "--json"];
  const { code, stdout, stderr } = await run(args, { LUDO_SPEC: "" }, staleCache('"v1"'));
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).id, "job-12345678");
  assert.equal(specFetches(from).length, 1);
});

test("no retry when the server says the cached spec is current", async () => {
  const from = seen.length;
  const { code, stderr } = await run(["image", "remove-background", "--image", "x.png"], { LUDO_SPEC: "" }, staleCache('"v2"'));
  assert.equal(code, 2);
  assert.match(stderr, /Unknown command: ludo image remove-background/);
  assert.equal(specFetches(from).length, 1);
  assert.ok(!seen.slice(from).some(s => s.path.startsWith("/api/assets/")));
});

test("an hour-old cached spec is used at once and refreshed in the background", async () => {
  const from = seen.length;
  const cwd = staleCache('"v2"', Date.now() - 2 * 60 * 60 * 1000);
  const metaFile = fs.readdirSync(path.join(cwd, ".cache")).find(f => f.endsWith(".meta.json"));
  const meta = () => JSON.parse(fs.readFileSync(path.join(cwd, ".cache", metaFile), "utf8"));
  slowSpecMs = 3000;
  try {
    const started = Date.now();
    const { code, stderr } = await run(["agent-help"], { LUDO_SPEC: "" }, cwd);
    assert.equal(code, 0, stderr);
    assert.ok(Date.now() - started < 2500, "did not wait for the slow server");
    assert.ok(meta().checked_at, "the background refresh was claimed");
    // The detached `ludo spec refresh` asks with the ETag, and gets its 304.
    for (let i = 0; i < 100 && !(meta().fetched_at > started); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(meta().fetched_at > started, "the background refresh stored the server's answer");
    const [fetch] = specFetches(from);
    assert.equal(fetch.headers["if-none-match"], '"v2"');
    assert.doesNotMatch(fetch.headers["cache-control"] || "", /no-cache/);
  } finally {
    slowSpecMs = 0;
  }
});

test("a refresh that did not get through is not retried on every run", async () => {
  const from = seen.length;
  const cwd = staleCache('"v2"', Date.now() - 2 * 60 * 60 * 1000);
  const metaFile = fs.readdirSync(path.join(cwd, ".cache")).find(f => f.endsWith(".meta.json"));
  const metaPath = path.join(cwd, ".cache", metaFile);
  fs.writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaPath, "utf8")), checked_at: Date.now() }));
  const { code, stderr } = await run(["agent-help"], { LUDO_SPEC: "" }, cwd);
  assert.equal(code, 0, stderr);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(specFetches(from).length, 0);
});

test("a fetched spec is used even when the cache cannot be written", async () => {
  // The server's spec has dropped removeBackground; the embedded copy still
  // has it, so running the command tells the two apart.
  const live = JSON.parse(fs.readFileSync(SPEC, "utf8"));
  delete live.paths["/assets/image/remove-background"];
  servedSpec = JSON.stringify(live);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"));
  // A file where the cache directory should be: every cache write throws.
  fs.writeFileSync(path.join(cwd, "blocked"), "");
  try {
    const { code, stderr } = await run(["image", "remove-background", "--image", "https://example.com/a.png", "--no-wait"], { LUDO_SPEC: "", LUDO_CACHE_DIR: path.join(cwd, "blocked", "cache") }, cwd);
    assert.equal(code, 2, stderr);
    assert.match(stderr, /Unknown command: ludo image remove-background/);
  } finally {
    servedSpec = null;
  }
});

test("help on a first run does not wait for the server", async () => {
  slowSpecMs = 3000;
  try {
    const started = Date.now();
    const { code, stdout } = await run([], { LUDO_SPEC: "" });
    assert.equal(code, 2);
    assert.match(stdout, /Groups:/);
    assert.ok(Date.now() - started < 2500, "did not wait for the slow server");
  } finally {
    slowSpecMs = 0;
  }
});

test("--n with --no-download reports each variation's job and URLs", async () => {
  const { code, stdout, stderr, cwd } = await run(["image", "create", "--prompt", "variations", "--image-type", "sprite", "--n", "2", "--no-download", "--json"]);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.deepEqual(
    out.variations.map(v => [v.variation, v.status, v.job_id, v.urls]),
    [
      [1, "succeeded", "job-imgs2000", [`${base}/files/out.png?i=0`]],
      [2, "succeeded", "job-imgs2000", [`${base}/files/out.png?i=1`]]
    ]
  );
  assert.deepEqual(out.files, []);
  assert.equal(out.urls.length, 2);
  assert.ok(!fs.existsSync(path.join(cwd, "ludo-output")), "nothing was downloaded");
});

test("--n saves one file per variation", async () => {
  const { code, stdout, stderr } = await run(["image", "create", "--prompt", "variations", "--image-type", "sprite", "--n", "2", "--json"]);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.variations.map(v => [v.status, v.job_id, v.files.length, v.urls]), [
    ["succeeded", "job-imgs2000", 1, undefined],
    ["succeeded", "job-imgs2000", 1, undefined]
  ]);
  assert.equal(out.urls, undefined);
});

test("--n with --no-download on a one-per-job command keeps each job's URLs", async () => {
  const { code, stdout, stderr } = await run(["sprite", "animate", "--initial-image", "https://example.com/a.png", "--motion-prompt", "walk", "--n", "2", "--no-download", "--json"]);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  for (const v of out.variations) {
    assert.equal(v.status, "succeeded");
    assert.equal(v.job_id, "job-sheet001");
    assert.deepEqual(v.urls, [`${base}/files/sheet.png`, `${base}/files/sfx.mp3`]);
  }
});

test("a batch with --no-download lists each job's URLs", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"));
  fs.writeFileSync(path.join(cwd, "jobs.json"), JSON.stringify([{ command: "image create", prompt: "variations", image_type: "sprite" }]));
  const { code, stdout, stderr } = await run(["batch", "jobs.json", "--no-download", "--json"], {}, cwd);
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).results[0].urls, [`${base}/files/out.png?i=0`]);
});

test("a crash in the CLI sends a scrubbed report to Sentry", async () => {
  const from = seen.length;
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-bad-")), "spec.json");
  fs.writeFileSync(bad, "{ not json");
  const { code, stderr } = await run(["image", "create", "--prompt", "secret prompt"], {
    LUDO_SPEC: bad,
    LUDO_TELEMETRY: "",
    DO_NOT_TRACK: "",
    LUDO_API_KEY: "sk-very-secret",
    LUDO_SENTRY_DSN: `http://pubkey@${new URL(base).host}/42`
  });
  assert.equal(code, 1);
  assert.match(stderr, /crash report was sent/);

  const sent = seen.slice(from).find(s => s.path === "/api/42/envelope/");
  assert.ok(sent, "an envelope was posted");
  assert.match(sent.headers["x-sentry-auth"], /sentry_key=pubkey/);
  const raw = sent.raw.toString();
  const event = JSON.parse(raw.split("\n")[2]);
  assert.equal(event.exception.values[0].type, "SyntaxError");
  assert.equal(event.tags.command, "(none)");
  assert.ok(event.exception.values[0].stacktrace.frames.some(f => f.in_app && f.filename === "dist/spec.js"));
  for (const secret of ["sk-very-secret", "secret prompt", os.homedir(), bad]) assert.ok(!raw.includes(secret), `leaked ${secret}`);
});

test("an output folder it may not write to is a plain error, not a crash report", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const from = seen.length;
  const locked = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-locked-"));
  fs.chmodSync(locked, 0o500);
  try {
    const { code, stderr } = await run(["image", "remove-background", "--image", "https://example.com/a.png", "--out", path.join(locked, "out")], {
      LUDO_TELEMETRY: "",
      DO_NOT_TRACK: "",
      LUDO_SENTRY_DSN: `http://pubkey@${new URL(base).host}/42`
    });
    assert.equal(code, 1, stderr);
    assert.match(stderr, /Could not mkdir .*: permission denied\./);
    assert.match(stderr, /--out <dir>/);
    assert.doesNotMatch(stderr, /crash report/);
    assert.ok(!seen.slice(from).some(s => s.path === "/api/42/envelope/"));
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("crash reports honour DO_NOT_TRACK", async () => {
  const from = seen.length;
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-bad-")), "spec.json");
  fs.writeFileSync(bad, "{ not json");
  const { code, stderr } = await run(["image", "--help"], {
    LUDO_SPEC: bad,
    LUDO_TELEMETRY: "",
    DO_NOT_TRACK: "1",
    LUDO_SENTRY_DSN: `http://pubkey@${new URL(base).host}/42`
  });
  assert.equal(code, 1);
  assert.doesNotMatch(stderr, /crash report/);
  assert.ok(!seen.slice(from).some(s => s.path === "/api/42/envelope/"));
});

const configOf = cwd => JSON.parse(fs.readFileSync(path.join(cwd, ".config", "config.json"), "utf8"));

test("login runs the browser flow and saves the CLI key", async () => {
  loginOutcome = "approved";
  const { code, stdout, stderr, cwd } = await run(["login", "--json"], { LUDO_API_KEY: "" });
  assert.equal(code, 0, stderr);
  assert.match(stderr, /http:\/\/web\.test\/cli\?code=WDJB-MJHT/);
  assert.match(stderr, /Code: WDJB-MJHT/);
  assert.match(stderr, /sign up on that page/);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.account.plan.name, "Pro");
  assert.equal(configOf(cwd).api_key, "ludo_minted");
  assert.equal(configOf(cwd).key_source, "login");
  const start = seen.filter(s => s.path === "/api/cli/auth/start").pop();
  assert.equal(JSON.parse(start.raw).platform, process.platform);
});

test("a denied login exits with the auth code and saves nothing", async () => {
  loginOutcome = "denied";
  const { code, stderr, cwd } = await run(["login"], { LUDO_API_KEY: "" });
  loginOutcome = "approved";
  assert.equal(code, 3);
  assert.match(stderr, /denied/);
  assert.ok(!fs.existsSync(path.join(cwd, ".config", "config.json")));
});

test("login --with-key validates and saves a pasted key (a 204 is success)", async () => {
  const { code, cwd, stderr } = await run(["login", "--with-key", "test-key"], { LUDO_API_KEY: "" });
  assert.equal(code, 0, stderr);
  assert.equal(configOf(cwd).api_key, "test-key");
  assert.equal(configOf(cwd).key_source, undefined);
});

test("login --with-key reports a plan without API access", async () => {
  const { code, stderr } = await run(["login", "--with-key", "no-plan"], { LUDO_API_KEY: "" });
  assert.equal(code, 5);
  assert.match(stderr, /no API access/);
});

test("logout revokes a CLI login key and forgets it", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"));
  fs.mkdirSync(path.join(cwd, ".config"));
  fs.writeFileSync(path.join(cwd, ".config", "config.json"), JSON.stringify({ api_key: "ludo_minted", key_source: "login" }));
  const from = seen.length;
  const { code, stdout } = await run(["logout", "--json"], { LUDO_API_KEY: "" }, cwd);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { ok: true, revoked: true });
  const del = seen.slice(from).find(s => s.method === "DELETE" && s.path === "/api/assets/cli-key");
  assert.equal(del.headers.authorization, "ApiKey ludo_minted");
  assert.equal(configOf(cwd).api_key, undefined);
});

test("logout leaves a pasted main key alone on the server", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"));
  fs.mkdirSync(path.join(cwd, ".config"));
  fs.writeFileSync(path.join(cwd, ".config", "config.json"), JSON.stringify({ api_key: "test-key" }));
  const from = seen.length;
  const { code, stdout } = await run(["logout", "--json"], { LUDO_API_KEY: "" }, cwd);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).revoked, false);
  assert.ok(!seen.slice(from).some(s => s.path === "/api/assets/cli-key"));
});

// Every command `ludo --help` lists, groups included. `--help` must only
// print: `ludo login --help` used to start a browser login and wait, and
// `ludo logout --help` revoked the saved key.
test("--help on every top-level command prints usage, exits 0 and does nothing else", async () => {
  const main = await run(["--help"]);
  assert.equal(main.code, 0);
  const section = title => {
    const lines = main.stdout.split("\n");
    const start = lines.indexOf(title) + 1;
    const end = lines.findIndex((l, i) => i >= start && !l.startsWith("  "));
    // Rows start two spaces in; deeper lines are wrapped descriptions.
    // The left column, minus <arg> and [option] placeholders: "files upload <path>" -> "files upload".
    return lines
      .slice(start, end)
      .filter(l => /^  \S/.test(l))
      .map(l => l.trim().split(/\s{2,}/)[0].split(" ").filter(w => !/^[<[]/.test(w)).join(" "));
  };
  const commands = [...new Set([...section("Groups:"), ...section("Other commands:")])];
  for (const c of ["login", "logout", "billing", "update", "init", "spec", "preview", "batch", "image", "sprite"]) assert.ok(commands.includes(c), `${c} is listed`);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"));
  fs.mkdirSync(path.join(cwd, ".config"));
  const config = JSON.stringify({ api_key: "ludo_minted", key_source: "login" });
  fs.writeFileSync(path.join(cwd, ".config", "config.json"), config);
  for (const c of commands) {
    const from = seen.length;
    const { code, stdout, stderr } = await run([...c.split(" "), "--help"], { LUDO_API_KEY: "", LUDO_NO_BROWSER: "" }, cwd);
    assert.equal(code, 0, `${c} --help: ${stderr}`);
    if (c !== "agent-help") assert.match(stdout, /Usage:|Commands:/, `${c} --help prints usage`);
    assert.deepEqual(seen.slice(from).map(s => `${s.method} ${s.path}`), [], `${c} --help calls nothing`);
  }
  // The login survived `logout --help`, and nothing was written.
  assert.equal(fs.readFileSync(path.join(cwd, ".config", "config.json"), "utf8"), config);
  assert.deepEqual(fs.readdirSync(cwd).sort(), [".cache", ".config"].filter(d => fs.existsSync(path.join(cwd, d))));
});

test("`ludo account` runs the group's only command and prints JSON for agents", async () => {
  const { code, stdout } = await run(["account"]);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), ACCOUNT);
});

test("feedback posts the message, category and the agent driving the CLI", async () => {
  const from = seen.length;
  const { code, stdout } = await run(
    ["feedback", "Needed", "an", "8-direction", "walk", "--category", "feature-request", "--operation", "animateSprite", "--job", "job-1", "--json"],
    { CURSOR_AGENT: "1" }
  );
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { ok: true, id: "fb-1" });
  const sent = seen.slice(from).find(s => s.path === "/api/assets/feedback");
  assert.deepEqual(JSON.parse(sent.raw), {
    category: "feature_request",
    message: "Needed an 8-direction walk",
    operation: "animateSprite",
    job_id: "job-1",
    agent: "Cursor"
  });
});

test("feedback sends every --job, repeated or comma-separated, as job_ids", async () => {
  const from = seen.length;
  const { code } = await run(["feedback", "Patches", "--category", "bug", "--job", "job-1", "--job", "job-2,job-3", "--job", "job-1"]);
  assert.equal(code, 0);
  const sent = seen.slice(from).find(s => s.path === "/api/assets/feedback");
  const body = JSON.parse(sent.raw);
  assert.equal(body.job_id, "job-1");
  assert.deepEqual(body.job_ids, ["job-1", "job-2", "job-3"]);
});

test("feedback refuses more than 10 jobs", async () => {
  const jobs = Array.from({ length: 11 }, (_, i) => ["--job", `job-${i}`]).flat();
  const { code } = await run(["feedback", "Too many", ...jobs]);
  assert.equal(code, 2);
});

test("feedback reads the message from stdin with -", async () => {
  const from = seen.length;
  const { code } = await run(["feedback", "-", "--category", "praise"], {}, undefined, "Loved the walk cycle\n");
  assert.equal(code, 0);
  const sent = seen.slice(from).find(s => s.path === "/api/assets/feedback");
  assert.deepEqual(JSON.parse(sent.raw), { category: "praise", message: "Loved the walk cycle" });
});

test("feedback rejects an unknown category and needs an account", async () => {
  const bad = await run(["feedback", "hi", "--category", "rant"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--category must be one of/);
  const anon = await run(["feedback", "hi"], { LUDO_API_KEY: "" });
  assert.equal(anon.code, 3);
  assert.match(anon.stderr, /ludo login/);
});

test("the feedback operation stays out of the account group", async () => {
  const { code, stdout } = await run(["account", "--help"]);
  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /feedback/);
});

test("billing prints the billing page without opening a browser for a non-terminal", async () => {
  const { code, stdout } = await run(["billing", "--json"]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).billing_url, "http://web.test/account/billing");
});

test("pricing works logged out and passes the server's guide through", async () => {
  const before = seen.length;
  const { code, stdout, stderr } = await run(["pricing", "--json"], { LUDO_API_KEY: "" });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), PRICING);
  const call = seen.slice(before).find(r => r.path === "/api/pricing");
  assert.equal(call.headers.authorization, undefined);
});

test("no API key points at ludo login and ludo pricing", async () => {
  const { code, stderr } = await run(["image", "create", "--prompt", "x", "--image-type", "sprite"], { LUDO_API_KEY: "" });
  assert.equal(code, 3);
  assert.match(stderr, /ludo login/);
  assert.match(stderr, /ludo pricing/);
});

test("out of credits points at ludo billing", async () => {
  const { code, stderr } = await run(["image", "create", "--prompt", "x", "--image-type", "sprite"]);
  assert.equal(code, 5);
  assert.match(stderr, /ludo billing/);
});

test("a network blip while polling does not end the login", async () => {
  loginOutcome = "approved";
  flakyPolls = 2;
  const { code, stderr, cwd } = await run(["login", "--json"], { LUDO_API_KEY: "" });
  assert.equal(code, 0, stderr);
  assert.equal(configOf(cwd).api_key, "ludo_minted");
});

test("login warns when LUDO_API_KEY will override it", async () => {
  loginOutcome = "approved";
  const { code, stderr } = await run(["login", "--json"], { LUDO_API_KEY: "test-key" });
  assert.equal(code, 0);
  assert.match(stderr, /LUDO_API_KEY is set/);
});

test("a spritesheet is saved with its grid inside, and machine output stays plain", async () => {
  const from = seen.length;
  const { code, stdout, stderr, cwd } = await run(["sprite", "animate", "--initial-image", "https://example.com/k.png", "--motion-prompt", "walk", "--json"]);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  const sheet = out.files.find(f => f.path.endsWith(".png"));
  assert.deepEqual(readGrid(fs.readFileSync(path.join(cwd, sheet.path))), { cols: 2, rows: 2, frames: 4, fps: 8 });
  const audio = out.files.find(f => f.path.endsWith(".mp3"));
  assert.ok(audio, "the sheet's audio_url is downloaded as its .mp3");
  assert.deepEqual(fs.readFileSync(path.join(cwd, audio.path)), MP3);
  assert.ok(!out.files.some(f => f.path.endsWith(".bin")));
  // No escape codes, spinner or preview for a pipe, and no extra account call.
  assert.doesNotMatch(stderr, /\x1b\[/);
  assert.ok(!seen.slice(from).some(s => s.path === "/api/assets/account"));
});

test("--engine rejects engines it does not support", async () => {
  const { code, stderr } = await run(["sprite", "animate", "--initial-image", "x", "--motion-prompt", "y", "--engine", "gamemaker"]);
  assert.equal(code, 2);
  assert.match(stderr, /--engine supports: godot, texturepacker, unity/);
});

test("preview refuses to draw for a non-terminal", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"));
  fs.writeFileSync(path.join(cwd, "s.png"), SHEET);
  const { code, stderr } = await run(["preview", "s.png"], {}, cwd);
  assert.equal(code, 2);
  assert.match(stderr, /interactive terminal/);
});

test("--engine godot writes a SpriteFrames resource next to the sheet and lists it", async () => {
  const { code, stdout, stderr, cwd } = await run(["sprite", "animate", "--initial-image", "https://example.com/k.png", "--motion-prompt", "walk", "--engine", "godot", "--json"]);
  assert.equal(code, 0, stderr);
  const tres = JSON.parse(stdout).files.find(f => f.path.endsWith(".tres"));
  assert.ok(tres, "the .tres is listed in files");
  const text = fs.readFileSync(path.join(cwd, tres.path), "utf8");
  assert.match(text, /\[gd_resource type="SpriteFrames" format=3\]/);
  assert.equal((text.match(/type="AtlasTexture"/g) || []).length, 4);
  assert.match(text, /"speed": 8\.0/);
});

test("--engine texturepacker writes a JSON atlas next to the sheet and lists it", async () => {
  const { code, stdout, stderr, cwd } = await run(["sprite", "animate", "--initial-image", "https://example.com/k.png", "--motion-prompt", "walk", "--engine", "texturepacker", "--json"]);
  assert.equal(code, 0, stderr);
  const files = JSON.parse(stdout).files;
  const atlas = files.find(f => f.path.endsWith(".json"));
  assert.ok(atlas, "the atlas is listed in files");
  const sheet = files.find(f => f.path.endsWith(".png"));
  const json = JSON.parse(fs.readFileSync(path.join(cwd, atlas.path), "utf8"));
  assert.equal(json.meta.image, path.basename(sheet.path));
  assert.deepEqual(Object.keys(json.frames), ["0", "1", "2", "3"]);
  assert.equal(json.frames["0"].duration, 125);
  assert.deepEqual(json.meta.frameTags[0], { name: path.basename(sheet.path, ".png"), from: 0, to: 3, direction: "forward" });
});

test("skill install writes the bundled skill, updates its own copy and protects others", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"));
  const env = { CLAUDE_CONFIG_DIR: path.join(cwd, "claude") };
  const target = path.join(cwd, "claude", "skills", "ludo", "SKILL.md");
  let r = await run(["skill", "install", "--json"], env, cwd);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).action, "installed");
  assert.match(fs.readFileSync(target, "utf8"), /^---\nname: ludo\n/);
  r = await run(["skill", "install", "--json"], env, cwd);
  assert.equal(JSON.parse(r.stdout).action, "unchanged");
  // A skill the user wrote themselves is not clobbered.
  fs.writeFileSync(target, "---\nname: ludo\n---\nmine\n");
  r = await run(["skill", "install"], env, cwd);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--force/);
  r = await run(["skill", "install", "--force", "--json"], env, cwd);
  assert.equal(JSON.parse(r.stdout).action, "updated");
  r = await run(["skill", "install", "--project", "--json"], env, cwd);
  assert.ok(fs.existsSync(path.join(cwd, ".claude", "skills", "ludo", "SKILL.md")));
  r = await run(["skill", "uninstall", "--json"], env, cwd);
  assert.equal(JSON.parse(r.stdout).action, "removed");
  assert.ok(!fs.existsSync(target));
});

test("a skill installed by an older ludo is brought up to date, and a project's copy gets a notice", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"));
  const env = { CLAUDE_CONFIG_DIR: path.join(cwd, "claude") };
  const personal = path.join(cwd, "claude", "skills", "ludo", "SKILL.md");
  const project = path.join(cwd, ".claude", "skills", "ludo", "SKILL.md");
  await run(["skill", "install"], env, cwd);
  await run(["skill", "install", "--project"], env, cwd);
  const current = fs.readFileSync(personal, "utf8");
  const old = current.replace(/<!-- ludo \S+ -->/, "<!-- ludo 0.1.0 -->").replace("## Workflow", "## Old workflow");
  fs.writeFileSync(personal, old);
  fs.writeFileSync(project, old);
  let r = await run(["version"], env, cwd);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(personal, "utf8"), current);
  assert.match(r.stderr, /Updated the Ludo skill for Claude Code from 0\.1\.0/);
  // The project's copy is the repository's: told, not rewritten.
  assert.equal(fs.readFileSync(project, "utf8"), old);
  assert.match(r.stderr, /this project's \.claude\/skills is from 0\.1\.0; `ludo skill install --project`/);
  // Up to date: nothing to say. A skill the user wrote is never touched.
  fs.writeFileSync(project, current);
  fs.writeFileSync(personal, "---\nname: ludo\n---\nmine\n");
  r = await run(["version"], env, cwd);
  assert.doesNotMatch(r.stderr, /skill/i);
  assert.equal(fs.readFileSync(personal, "utf8"), "---\nname: ludo\n---\nmine\n");
});

test("skill install into a config folder that can't be created is a plain error", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"));
  fs.writeFileSync(path.join(cwd, "not-a-folder"), "");
  const r = await run(["skill", "install"], { CLAUDE_CONFIG_DIR: path.join(cwd, "not-a-folder", "claude") }, cwd);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Could not create .*: part of the path is not a folder/);
  assert.match(r.stderr, /CLAUDE_CONFIG_DIR/);
});

// WebP is decoded in-process: no converter on PATH is needed (or used).
test("a WebP spritesheet gets a PNG copy that carries the grid and feeds the Godot export", async () => {
  const { code, stdout, stderr, cwd } = await run(["sprite", "animate", "--initial-image", "https://example.com/k.png", "--motion-prompt", "webp", "--engine", "godot", "--json"], { PATH: "" });
  assert.equal(code, 0, stderr);
  const files = JSON.parse(stdout).files.map(f => f.path);
  const webp = files.find(p => p.endsWith(".webp"));
  const png = files.find(p => p.endsWith(".png"));
  assert.ok(webp && png, `both copies are listed: ${files.join(", ")}`);
  assert.equal(png, webp.replace(/\.webp$/, ".png"), "the PNG sits next to the WebP");
  assert.deepEqual(readGrid(fs.readFileSync(path.join(cwd, png))), { cols: 2, rows: 2, frames: 4, fps: 8 });
  const copy = readPng(fs.readFileSync(path.join(cwd, png))).image;
  // (RGB under fully transparent pixels is written as 0.)
  const want = Buffer.from(readWebp(fs.readFileSync(path.join(cwd, webp))).rgba);
  for (let i = 0; i < want.length; i += 4) if (want[i + 3] === 0) want.fill(0, i, i + 3);
  assert.deepEqual(Buffer.from(copy.rgba), want, "the PNG holds the WebP's pixels");
  const tres = files.find(p => p.endsWith(".tres"));
  assert.ok(tres, "the Godot export was written");
  assert.match(fs.readFileSync(path.join(cwd, tres), "utf8"), new RegExp(`path="${path.basename(png).replace(".", "\\.")}"`));
});

const telemetryEvents = from => seen.slice(from).filter(s => s.path === "/api/cli/events");

test("each command sends one usage event: facts and flag names, never values", async () => {
  const from = seen.length;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-telemetry-"));
  const first = await run(["image", "create", "--prompt", "secret knight", "--image-type", "sprite", "--json"], { LUDO_TELEMETRY: "1" }, cwd);
  const [sent] = telemetryEvents(from);
  assert.ok(sent, first.stderr);
  const body = JSON.parse(sent.raw);
  assert.match(body.install_id, /^[A-Za-z0-9_-]{8,64}$/);
  const [event] = body.events;
  assert.equal(event.command, "image create");
  assert.match(event.id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(event.props.exit_code, first.code);
  assert.deepEqual(event.props.flags, ["--prompt", "--image-type", "--json"]);
  assert.equal(event.props.logged_in, true);
  assert.equal(sent.headers.authorization, "ApiKey test-key");
  assert.doesNotMatch(sent.raw.toString(), /secret|knight|sprite/);

  // A second command soon after waits in the queue...
  const from2 = seen.length;
  await run(["account"], { LUDO_TELEMETRY: "1" }, cwd);
  assert.equal(telemetryEvents(from2).length, 0);
  assert.match(fs.readFileSync(path.join(cwd, ".config", "telemetry-queue.jsonl"), "utf8"), /"command":"account show"/);
  // ...and goes with the next one once the last send is old enough, from the
  // same install.
  const stamp = path.join(cwd, ".config", "telemetry-sent");
  fs.utimesSync(stamp, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const from3 = seen.length;
  await run(["version"], { LUDO_TELEMETRY: "1" }, cwd);
  const sends = telemetryEvents(from3);
  assert.equal(sends.length, 1);
  const again = JSON.parse(sends[0].raw);
  assert.equal(again.install_id, body.install_id);
  assert.deepEqual(again.events.map(e => e.command), ["account show", "version"]);
  assert.ok(!fs.existsSync(path.join(cwd, ".config", "telemetry-queue.jsonl")));
});

test("a burst of commands sends a few requests, and nothing is lost", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-burst-"));
  const from = seen.length;
  for (let i = 0; i < 25; i++) await run(["version"], { LUDO_TELEMETRY: "1" }, cwd);
  const sends = telemetryEvents(from).map(s => JSON.parse(s.raw).events.length);
  // The first sends at once; the next 20 queue and go together.
  assert.deepEqual(sends, [1, 20]);
  const left = fs.readFileSync(path.join(cwd, ".config", "telemetry-queue.jsonl"), "utf8").trim().split("\n");
  assert.equal(left.length, 4);
});

test("events the server did not take wait for the next send", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-retry-"));
  // Nothing listens there.
  const closed = await new Promise(resolve => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
  await run(["version"], { LUDO_TELEMETRY: "1", LUDO_API_URL: closed }, cwd);
  const queued = fs.readFileSync(path.join(cwd, ".config", "telemetry-queue.jsonl"), "utf8").trim().split("\n");
  assert.equal(queued.length, 1);
  fs.utimesSync(path.join(cwd, ".config", "telemetry-sent"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const from = seen.length;
  await run(["version"], { LUDO_TELEMETRY: "1" }, cwd);
  const [sent] = telemetryEvents(from);
  const events = JSON.parse(sent.raw).events;
  assert.equal(events.length, 2);
  // The same id as queued, so the server can tell a second try from a new event.
  assert.equal(events[0].id, JSON.parse(queued[0]).id);
  assert.notEqual(events[0].id, events[1].id);
});

test("one run sends at most two requests, the rest waits", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-backlog-"));
  const dir = path.join(cwd, ".config");
  fs.mkdirSync(dir, { recursive: true });
  const at = Math.floor(Date.now() / 1000);
  const backlog = Array.from({ length: 59 }, (_, i) => JSON.stringify({ command: "version", id: `queued-${String(i).padStart(4, "0")}`, at, props: {} }));
  fs.writeFileSync(path.join(dir, "telemetry-queue.jsonl"), backlog.join("\n") + "\n");
  const from = seen.length;
  await run(["version"], { LUDO_TELEMETRY: "1" }, cwd);
  const sends = telemetryEvents(from).map(s => JSON.parse(s.raw).events);
  assert.deepEqual(sends.map(e => e.length), [20, 20]);
  // The oldest go first.
  assert.equal(sends[0][0].id, "queued-0000");
  const left = fs.readFileSync(path.join(dir, "telemetry-queue.jsonl"), "utf8").trim().split("\n");
  assert.equal(left.length, 20);
});

test("usage events honour LUDO_TELEMETRY=0 and DO_NOT_TRACK", async () => {
  const from = seen.length;
  await run(["account"], { LUDO_TELEMETRY: "0" });
  await run(["account"], { LUDO_TELEMETRY: "1", DO_NOT_TRACK: "1" });
  assert.equal(telemetryEvents(from).length, 0);
});

test("a logged-out command is reported without a key", async () => {
  const from = seen.length;
  await run(["version"], { LUDO_TELEMETRY: "1", LUDO_API_KEY: "" });
  const [sent] = telemetryEvents(from);
  assert.ok(sent);
  assert.equal(sent.headers.authorization, undefined);
  assert.equal(JSON.parse(sent.raw).events[0].props.logged_in, false);
});

// ─── Interrupted commands, package scanners, retries ────────────────────────

function spawnCli(args, extraEnv = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-sig-"));
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      LUDO_SPEC: SPEC,
      LUDO_API_URL: base,
      LUDO_API_KEY: "test-key",
      LUDO_CONFIG_DIR: path.join(cwd, ".config"),
      LUDO_CACHE_DIR: path.join(cwd, ".cache"),
      LUDO_TELEMETRY: "1",
      CLAUDECODE: "",
      CLAUDE_CODE_ENTRYPOINT: "",
      ...extraEnv
    }
  });
  let stderr = "";
  child.stderr.on("data", d => (stderr += d));
  const closed = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal, stderr })));
  return { child, closed };
}

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 20));
  }
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`a command stopped with ${signal} still reports its usage event`, async () => {
    const from = seen.length;
    const { child, closed } = spawnCli(["jobs", "wait", "job-forever", "--json"]);
    await until(() => seen.slice(from).some(s => s.path === "/api/assets/jobs/job-forever"));
    child.kill(signal);
    const done = await closed;
    assert.equal(done.code, code, done.stderr);
    const [sent] = telemetryEvents(from);
    assert.ok(sent, "an event was sent before exiting");
    const event = JSON.parse(sent.raw).events[0];
    assert.equal(event.command, "jobs wait");
    assert.equal(event.props.exit_code, code);
    if (signal === "SIGINT") assert.match(done.stderr, /The job keeps running/);
  });
}

test("importing the CLI's modules sends nothing: only the ludo command reports", async () => {
  const from = seen.length;
  const saved = { ...process.env };
  Object.assign(process.env, { LUDO_API_URL: base, LUDO_API_KEY: "test-key", LUDO_TELEMETRY: "1", DO_NOT_TRACK: "", LUDO_SENTRY_DSN: `http://pubkey@${new URL(base).host}/42`, LUDO_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-scan-")) });
  try {
    const { armTelemetry, sendTelemetry } = await import("../dist/telemetry.js");
    const { armCrashReports, reportCrash } = await import("../dist/crash.js");
    // What a package scanner does: call every export, the arm functions
    // included, with junk.
    armTelemetry();
    armCrashReports();
    await sendTelemetry("junk", 1, Date.now(), []);
    assert.equal(await reportCrash(null, undefined), undefined);
  } finally {
    process.env = saved;
  }
  assert.ok(!seen.slice(from).some(s => s.path === "/api/cli/events" || s.path === "/api/42/envelope/"));
});

test("the same file is uploaded once and its URL reused, until it changes or is gone", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-reuse-"));
  const src = path.join(cwd, "photo.png");
  fs.writeFileSync(src, PNG);
  const uploads = from => seen.slice(from).filter(s => s.path === "/api/assets/uploads").length;
  const submitted = from => JSON.parse(seen.slice(from).filter(s => s.path === "/api/assets/image/remove-background").pop().raw).image;
  const removeBg = () => run(["image", "remove-background", "--image", src, "--json"], {}, cwd);

  let from = seen.length;
  polls = 0;
  assert.equal((await removeBg()).code, 0);
  assert.equal(uploads(from), 1);

  // Same bytes: no createUpload call, the same URL goes in the request.
  from = seen.length;
  polls = 0;
  const again = await removeBg();
  assert.equal(again.code, 0, again.stderr);
  assert.equal(uploads(from), 0);
  assert.equal(submitted(from), `${base}/files/u1.png`);
  assert.ok(seen.slice(from).some(s => s.method === "HEAD" && s.path === "/files/u1.png"), "checked the file is still there");

  // Gone from storage (expired, deleted): uploaded again.
  blobs.delete("/files/u1.png");
  from = seen.length;
  polls = 0;
  assert.equal((await removeBg()).code, 0);
  assert.equal(uploads(from), 1);

  // Different content under the same name: a new upload.
  fs.writeFileSync(src, Buffer.concat([PNG, Buffer.from([0])]));
  from = seen.length;
  polls = 0;
  assert.equal((await removeBg()).code, 0);
  assert.equal(uploads(from), 1);

  // Turned off: always uploads.
  from = seen.length;
  polls = 0;
  assert.equal((await run(["image", "remove-background", "--image", src, "--json"], { LUDO_UPLOAD_CACHE: "0" }, cwd)).code, 0);
  assert.equal(uploads(from), 1);

  // `ludo files upload` promises a fresh 7-day URL, so it never reuses.
  from = seen.length;
  assert.equal((await run(["files", "upload", src], {}, cwd)).code, 0);
  assert.equal(uploads(from), 1);
});

test("a rate-limited upload says when the limit lifts", async () => {
  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-src-")), "photo.png");
  fs.writeFileSync(src, PNG);
  rateLimitedUploads = true;
  try {
    const { code, stderr } = await run(["image", "remove-background", "--image", src]);
    assert.equal(code, 8);
    assert.match(stderr, /500 requests per 1 day on POST \/api\/assets\/uploads/);
    assert.match(stderr, /Rate limited until .+; retrying earlier fails again/);
  } finally {
    rateLimitedUploads = false;
  }
});

test("an upload that meets a 502 is retried once and goes through", async () => {
  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-src-")), "photo.png");
  fs.writeFileSync(src, PNG);
  const from = seen.length;
  flakyUploads = 1;
  polls = 0;
  const { code, stderr } = await run(["image", "remove-background", "--image", src, "--json"], { LUDO_RETRY_DELAY_MS: "1" });
  assert.equal(code, 0, stderr);
  assert.equal(seen.slice(from).filter(s => s.path === "/api/assets/uploads").length, 2);
});

test("a GET that meets a 503 is retried once", async () => {
  const from = seen.length;
  flakyJobGets = 1;
  const { code, stdout } = await run(["jobs", "get", "job-flaky", "--json"], { LUDO_RETRY_DELAY_MS: "1" });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).status, "canceled");
  assert.equal(seen.slice(from).filter(s => s.path === "/api/assets/jobs/job-flaky").length, 2);
});

test("a generation submit is never retried: it could run and charge twice", async () => {
  const from = seen.length;
  const { code } = await run(["image", "remove-background", "--image", "https://example.com/502.png", "--json"], { LUDO_RETRY_DELAY_MS: "1" });
  assert.equal(code, 1);
  assert.equal(seen.slice(from).filter(s => s.path === "/api/assets/image/remove-background").length, 1);
});

test("directional sprites: files named per direction, each sheet with its grid", async () => {
  const { code, stdout, stderr, cwd } = await run(["sprite", "directional", "--model", "https://example.com/hero.glb", "--directions", "SW", "--directions", "N", "--json"]);
  assert.equal(code, 0, stderr);
  const submit = seen.filter(s => s.path === "/api/assets/sprite/directional").pop();
  assert.deepEqual(JSON.parse(submit.raw).directions, ["SW", "N"]);
  const out = JSON.parse(stdout);
  const paths = out.files.map(f => path.basename(f.path)).sort();
  assert.deepEqual(paths, ["createDirectionalSprites-job-dire-N.png", "createDirectionalSprites-job-dire-SW.png"]);
  for (const f of out.files) {
    const grid = readGrid(fs.readFileSync(path.join(cwd, f.path)));
    assert.deepEqual(grid, { cols: 2, rows: 2, frames: 4, fps: 8 });
  }
});

test("directional preview saves each direction's frames, though it is not a job", async () => {
  const { code, stdout, stderr, cwd } = await run(["sprite", "directional-preview", "--model", "https://example.com/hero.glb", "--json"]);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.equal(out.status, "succeeded");
  assert.deepEqual(out.files.map(f => path.basename(f.path)), [
    "directional-preview-SW-f1.png",
    "directional-preview-SW-f2.png",
    "directional-preview-N-f1.png",
    "directional-preview-N-f2.png"
  ]);
  for (const f of out.files) assert.ok(fs.existsSync(path.join(cwd, f.path)));
  const submit = seen.filter(s => s.path === "/api/assets/sprite/directional-preview").pop();
  assert.equal(JSON.parse(submit.raw).async, undefined, "a preview is not submitted as a job");
});

test("a directional preview replaced by a newer one exits as canceled", async () => {
  const { code, stdout } = await run(["sprite", "directional-preview", "--model", "https://example.com/hero.glb", "--style-id", "replaced", "--json"]);
  assert.equal(code, 7);
  assert.equal(JSON.parse(stdout).status, "canceled");
});
