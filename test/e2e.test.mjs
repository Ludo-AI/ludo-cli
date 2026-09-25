import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

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
      if (req.headers["if-none-match"] === '"v2"') {
        res.writeHead(304);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json", ETag: '"v2"' });
      return res.end(fs.readFileSync(SPEC));
    }
    if (req.method === "POST" && url.pathname === "/api/42/envelope/") {
      res.writeHead(200);
      return res.end("{}");
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
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      res.writeHead(200);
      return res.end(url.pathname === "/files/out.png" ? PNG : blobs.get(url.pathname));
    }
    if (req.method === "POST" && url.pathname === "/api/assets/image/remove-background") {
      if (req.headers.authorization !== "ApiKey test-key") return json(res, 403, { message: "Invalid API key" });
      return json(res, 202, { id: "job-12345678", status: "queued", task_type: "removeBackground", poll_after_ms: 10 });
    }
    if (req.method === "POST" && url.pathname === "/api/assets/image") {
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

function run(args, extraEnv = {}, cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"))) {
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
        ...extraEnv
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr, cwd }));
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

// Seeds a fresh cache holding a spec from before removeBackground existed.
function staleCache(etag) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-test-"));
  const dir = path.join(cwd, ".cache");
  fs.mkdirSync(dir);
  const key = crypto.createHash("sha1").update(base).digest("hex").slice(0, 12);
  const old = JSON.parse(fs.readFileSync(SPEC, "utf8"));
  delete old.paths["/assets/image/remove-background"];
  fs.writeFileSync(path.join(dir, `openapi-${key}.json`), JSON.stringify(old));
  fs.writeFileSync(path.join(dir, `openapi-${key}.meta.json`), JSON.stringify({ etag, fetched_at: Date.now() }));
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
