// Result downloads: a transfer that stalls or drops part-way resumes with a
// Range request instead of failing (or starting over).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fetchToFile } from "../dist/jobs.js";

const FILE = crypto.randomBytes(256 * 1024);
const HALF = FILE.length / 2;
let server;
let base;
let requests = [];
// How the next first (Range-less) request misbehaves: "drop", "stall" or none.
let firstRequest = null;
let honourRange = true;

before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ path: req.url, range: req.headers.range });
    if (req.url === "/missing.mp4") {
      res.writeHead(404);
      return res.end();
    }
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || "");
    if (m && honourRange) {
      const from = Number(m[1]);
      res.writeHead(206, { "Content-Range": `bytes ${from}-${FILE.length - 1}/${FILE.length}`, "Content-Length": FILE.length - from });
      return res.end(FILE.subarray(from));
    }
    res.writeHead(200, { "Content-Length": FILE.length });
    const mode = firstRequest;
    firstRequest = null;
    if (mode === "drop") {
      res.write(FILE.subarray(0, HALF));
      return setTimeout(() => res.socket.destroy(), 50);
    }
    if (mode === "stall") {
      res.write(FILE.subarray(0, HALF));
      return; // never finishes; the client gives up on it
    }
    res.end(FILE);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function target() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ludo-cli-dl-")), "video.mp4");
}

function reset(mode, range = true) {
  requests = [];
  firstRequest = mode;
  honourRange = range;
}

test("a dropped connection resumes from the bytes already saved", async () => {
  reset("drop");
  const file = target();
  const logs = [];
  await fetchToFile(`${base}/video.mp4`, file, m => logs.push(m), 2000);
  assert.deepEqual(fs.readFileSync(file), FILE);
  assert.equal(requests.length, 2);
  assert.match(requests[1].range, /^bytes=\d+-$/);
  assert.ok(Number(/\d+/.exec(requests[1].range)[0]) > 0, "the second request skips what arrived");
  assert.match(logs[0], /interrupted .*resuming from byte/);
  assert.ok(!fs.existsSync(`${file}.${process.pid}.part`));
});

test("a stalled transfer is abandoned after the idle time and resumed", async () => {
  reset("stall");
  const file = target();
  await fetchToFile(`${base}/video.mp4`, file, undefined, 300);
  assert.deepEqual(fs.readFileSync(file), FILE);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].range);
});

test("a server that ignores Range starts the file over", async () => {
  reset("drop", false);
  const file = target();
  await fetchToFile(`${base}/video.mp4`, file, undefined, 2000);
  assert.deepEqual(fs.readFileSync(file), FILE);
  assert.equal(requests.length, 2);
});

test("an HTTP error is not retried and leaves nothing behind", async () => {
  reset(null);
  const file = target();
  await assert.rejects(fetchToFile(`${base}/missing.mp4`, file), /Download failed for .*: HTTP 404/);
  assert.equal(requests.length, 1);
  assert.ok(!fs.existsSync(file) && !fs.existsSync(`${file}.${process.pid}.part`));
});
