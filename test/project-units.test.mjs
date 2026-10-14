import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { buildCommands } from "../dist/commands.js";
import { estimatePrice, parseModelRates } from "../dist/pricing.js";
import { compareVersions, decodeNotice, pendingLines } from "../dist/notices.js";
import { totalOf } from "../dist/budget.js";
import { validateConfig } from "../dist/project.js";
import { upsertSection } from "../dist/workspace.js";
import { parsePick } from "../dist/generate.js";
import { extractInlineFiles, freePath } from "../dist/jobs.js";
import { fileBaseName } from "../dist/args.js";
import os from "node:os";
import path from "node:path";
import { appendAssets, readAssets } from "../dist/assets.js";

const spec = JSON.parse(fs.readFileSync(new URL("../spec/openapi.json", import.meta.url), "utf8"));
const byId = id => buildCommands(spec).find(c => c.operationId === id);

test("versions compare numerically, pre-releases before releases, garbage as equal", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("latest", "1.0.0"), 0);
});

test("notices decode from base64url JSON and lose control characters", () => {
  const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  assert.deepEqual(decodeNotice(enc({ id: "a", level: "critical", message: "Down\u001b[2J", url: "https://x.y" })), {
    id: "a",
    level: "critical",
    message: "Down [2J",
    url: "https://x.y"
  });
  assert.equal(decodeNotice(enc({ id: "b", message: "hi", url: "javascript:alert(1)" })).url, undefined);
  assert.equal(decodeNotice(enc({ id: "c", level: "loud", message: "hi" })).level, "info");
  assert.equal(decodeNotice("%%%"), undefined);
  assert.equal(decodeNotice(enc({ id: "d" })), undefined);
});

test("notices repeat every six hours, critical ones every run, updates once a day", () => {
  const now = 1_000_000_000_000;
  const found = { latest: "9.9.9", notices: [{ id: "w", level: "warning", message: "slow" }, { id: "c", level: "critical", message: "down" }] };
  const first = pendingLines({}, now, false, found);
  assert.equal(first.lines.length, 3);
  const soon = pendingLines(first.state, now + 60_000, false, found);
  assert.deepEqual(soon.lines, ["⚠ Ludo: down"]);
  const later = pendingLines(first.state, now + 7 * 3600_000, false, found);
  assert.equal(later.lines.length, 2);
  assert.deepEqual(pendingLines({}, now, true, found).lines, ["⚠ Ludo: down"]);
});

test("model price tables parse into rates, minimums and durations", () => {
  const rates = parseModelRates(byId("animateSprite").creditDetail);
  const hydra = rates.find(r => r.id === "hydra");
  assert.deepEqual(hydra, { id: "hydra", rate: 3, minimum: 9, shortest: 3, longest: 5 });
  // Current models bill rate x seconds; only legacy ones keep a minimum.
  assert.equal(rates.find(r => r.id === "forge").minimum, 0);
  assert.equal(rates.find(r => r.id === "eagle").minimum, 4);
  assert.ok(rates.some(r => r.id === "eagle-audio"));
});

test("estimates follow the published prices", () => {
  assert.deepEqual(estimatePrice(byId("createImage"), { n: 3 }), { credits: 1.5, exact: true });
  assert.equal(estimatePrice(byId("createMusic"), {}).credits, 3);
  assert.equal(estimatePrice(byId("animateSprite"), { model: "forge", duration: 4 }).credits, 6);
  assert.equal(estimatePrice(byId("animateSprite"), { model: "forge", duration: 1 }).credits, 1.5);
  assert.equal(estimatePrice(byId("animateSprite"), { model: "eagle", duration: 1 }).credits, 4); // legacy minimum charge
  assert.equal(estimatePrice(byId("createVideo"), { model: "griffin", duration: 2 }).credits, 7.5); // shortest duration
  // Fixes bill the source sheet's length, whatever duration is asked for.
  assert.deepEqual(estimatePrice(byId("editSpritesheet"), { edit_mode: "outpaint", duration: 3 }), { credits: 5, exact: false, note: "at most, for the source's length" });
  // Improve is flat too, not hydra's 3/s, and the model sent is ignored.
  assert.equal(estimatePrice(byId("editSpritesheet"), { edit_mode: "improve", model: "forge" }).credits, 5);
  assert.equal(estimatePrice(byId("editSpritesheet"), { edit_mode: "prompt", model: "hydra", duration: 4 }).credits, 12);
  assert.equal(estimatePrice(byId("upscaleVideo"), {}).credits, undefined);
});

test("a total is unknown when any part is", () => {
  assert.deepEqual(totalOf([{ credits: 2, exact: true }, { credits: 1.5, exact: true }]), { credits: 3.5, exact: true, note: undefined });
  assert.equal(totalOf([{ credits: 2, exact: true }, { exact: false, note: "?" }]).credits, undefined);
});

test("config validation names unknown fields and bad values", () => {
  assert.throws(() => validateConfig({ output: "x" }, ".ludo.json"), /unknown field "output"/);
  assert.throws(() => validateConfig({ engine: "unity" }, ".ludo.json"), /"engine" supports: godot/);
  assert.throws(() => validateConfig({ max_credits: -1 }, ".ludo.json"), /max_credits/);
  assert.throws(() => validateConfig({ defaults: { "image create": 3 } }, ".ludo.json"), /must be an object/);
  assert.deepEqual(validateConfig({ out: "a", max_credits: 0 }, ".ludo.json"), { out: "a", max_credits: 0 });
});

test("the managed AGENTS.md section is appended once and replaced in place", () => {
  const once = upsertSection("# Game\n", "v1");
  assert.match(once, /^# Game\n\n<!-- ludo:start[^\n]*-->\nv1\n<!-- ludo:end -->\n$/);
  const twice = upsertSection(once + "\nMore notes\n", "v2");
  assert.match(twice, /\nv2\n<!-- ludo:end -->\n\nMore notes\n$/);
  assert.doesNotMatch(twice, /v1/);
});

test("variation picks accept numbers, lists, ranges and all", () => {
  assert.deepEqual(parsePick("2", [1, 2, 3]), [2]);
  assert.deepEqual(parsePick("v1, 3", [1, 2, 3]), [1, 3]);
  assert.deepEqual(parsePick("1-2", [1, 2, 3]), [1, 2]);
  assert.deepEqual(parsePick("", [1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(parsePick("all", [1, 3]), [1, 3]);
  assert.equal(parsePick("best", [1, 2]), undefined);
});

test("the asset log replaces an entry for the same job and file, and takes over a stale lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-log-"));
  const log = path.join(dir, "ludo-assets.json");
  const entry = (credits, file = "a.png") => ({ file, command: "c", operation_id: "o", body: {}, job_id: "j1", credits, created_at: "t" });
  appendAssets(log, [entry(1), entry(1, "b.png")]);
  fs.writeFileSync(`${log}.lock`, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${log}.lock`, old, old);
  appendAssets(log, [entry(2)]);
  const entries = readAssets(log);
  assert.deepEqual(entries.map(e => [e.file, e.credits]), [["b.png", 1], ["a.png", 2]]);
  assert.ok(!fs.existsSync(`${log}.lock`));
});

test("the asset log keeps inline base64 once in ludo-inputs/, also for entries an older CLI wrote", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-log-"));
  const log = path.join(dir, "ludo-assets.json");
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(600, 7)]);
  const webp = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), Buffer.alloc(600, 9)]);
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  const text = "A".repeat(800); // base64 alphabet, but no file type in its bytes
  const entry = (file, body) => ({ file, command: "c", operation_id: "o", body, job_id: file, created_at: "t" });
  // An older CLI's log: the same image inlined in every entry.
  fs.writeFileSync(log, JSON.stringify({ assets: [entry("old-1.png", { initial_image: dataUri }), entry("old-2.png", { initial_image: dataUri })] }));
  appendAssets(log, [
    entry("new.png", { initial_image: png.toString("base64"), references: [webp.toString("base64"), "ref.png"], motion_prompt: "walk", note: text })
  ]);
  const entries = readAssets(log);
  const hash = b => crypto.createHash("sha256").update(b).digest("hex");
  const pngPath = path.join("ludo-inputs", `${hash(png)}.png`);
  const webpPath = path.join("ludo-inputs", `${hash(webp)}.webp`);
  assert.deepEqual(entries.map(e => e.body.initial_image), [pngPath, pngPath, pngPath]);
  assert.deepEqual(entries[2].body.references, [webpPath, "ref.png"]);
  assert.equal(entries[2].body.motion_prompt, "walk");
  assert.equal(entries[2].body.note, text);
  assert.deepEqual(fs.readFileSync(path.join(dir, pngPath)), png);
  assert.deepEqual(fs.readFileSync(path.join(dir, webpPath)), webp);
  assert.deepEqual(fs.readdirSync(path.join(dir, "ludo-inputs")).sort(), [".gitignore", `${hash(png)}.png`, `${hash(webp)}.webp`].sort());
  assert.equal(fs.readFileSync(path.join(dir, "ludo-inputs", ".gitignore"), "utf8"), "*\n");
  assert.ok(fs.statSync(log).size < 2000);
});

test("saved files never overwrite: taken names get -2, -3; a WebP needs its PNG twin free", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-free-"));
  assert.equal(freePath(dir, "sfx", ".mp3"), path.join(dir, "sfx.mp3"));
  fs.writeFileSync(path.join(dir, "sfx.mp3"), "");
  fs.writeFileSync(path.join(dir, "sfx-2.mp3"), "");
  assert.equal(freePath(dir, "sfx", ".mp3"), path.join(dir, "sfx-3.mp3"));
  fs.writeFileSync(path.join(dir, "hero.png"), "");
  assert.equal(freePath(dir, "hero", ".webp"), path.join(dir, "hero-2.webp"));
  // Inline (base64) results follow the same rule.
  fs.writeFileSync(path.join(dir, "boom-audio.mp3"), "old");
  const { files } = extractInlineFiles({ audio_b64: Buffer.concat([Buffer.from("ID3"), Buffer.alloc(80, 1)]).toString("base64") }, { dir, prefix: "boom" });
  assert.equal(files[0].path, path.join(dir, "boom-audio-2.mp3"));
  assert.equal(fs.readFileSync(path.join(dir, "boom-audio.mp3"), "utf8"), "old");
});

test("fileBaseName drops a media extension and refuses folders", () => {
  assert.equal(fileBaseName("sfx_pump.mp3", "--name"), "sfx_pump");
  assert.equal(fileBaseName("hero.PNG", "--name"), "hero");
  assert.equal(fileBaseName("knight.walk", "--name"), "knight.walk");
  for (const bad of ["a/b", "a\\b", "..", "../x", "", "  ", ".webp"]) assert.throws(() => fileBaseName(bad, "--name"), /plain file name/, bad);
});
