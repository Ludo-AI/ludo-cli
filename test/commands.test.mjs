import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildCommands, commandName, findCommand } from "../dist/commands.js";
import { parseArgv, resolveFlags } from "../dist/args.js";
import { CliError, EXIT } from "../dist/errors.js";

const spec = JSON.parse(fs.readFileSync(new URL("../spec/openapi.json", import.meta.url), "utf8"));
const commands = buildCommands(spec);
const byId = id => commands.find(c => c.operationId === id);

test("derives command names from tags and operationIds", () => {
  const names = Object.fromEntries(commands.map(c => [c.operationId, `${c.group} ${c.name}`]));
  assert.equal(names.createImage, "image create");
  assert.equal(names.removeBackground, "image remove-background");
  assert.equal(names.animateSprite, "sprite animate");
  assert.equal(names.editSpritesheet, "sprite edit");
  assert.equal(names.create3DModel, "model create");
  assert.equal(names.animate3DModelPreset, "model animate-preset");
  assert.equal(names.createMusic, "audio music");
  assert.equal(names.createSoundEffect, "audio sound-effect");
  assert.equal(names.createVideo, "video create");
  assert.equal(names.getApiJob, "jobs get");
  assert.equal(names.searchDocs, "docs search");
});

test("command names are unique", () => {
  const seen = new Set();
  for (const c of commands) {
    const key = `${c.group} ${c.name}`;
    assert.ok(!seen.has(key), `duplicate command ${key}`);
    seen.add(key);
  }
});

test("a live spec whose operations collide still reaches each of them", () => {
  const live = structuredClone(spec);
  const rotate = live.paths["/assets/sprite/rotate"].post;
  live.paths["/assets/sprite/new-view"] = { post: { ...structuredClone(rotate), operationId: "rotateSpritesheet" } };
  const cmds = buildCommands(live);
  const name = id => cmds.find(c => c.operationId === id).name;
  assert.equal(name("rotateSprite"), "rotate");
  assert.equal(name("rotateSpritesheet"), "rotate-spritesheet");
  assert.equal(findCommand(cmds, ["sprite", "rotate-spritesheet"]).command.operationId, "rotateSpritesheet");

  live.paths["/assets/sprite/new-view"].post["x-cli-name"] = "rotate-sheet";
  assert.equal(buildCommands(live).find(c => c.operationId === "rotateSpritesheet").name, "rotate-sheet");
});

test("commandName keeps the verb when nothing is left", () => {
  assert.equal(commandName("docs", "docs"), "docs");
});

test("generations are jobs and never expose the async flag", () => {
  const c = byId("createImage");
  assert.equal(c.isJob, true);
  assert.ok(!c.fields.some(f => f.name === "async"));
  assert.equal(byId("listGenerations").isJob, false);
});

test("flags only the fields that accept arbitrary media as files", () => {
  assert.ok(byId("removeBackground").fields.find(f => f.name === "image").isFile);
  assert.ok(byId("editSpritesheet").fields.find(f => f.name === "images").isFile);
  assert.ok(!byId("createImage").fields.find(f => f.name === "prompt").isFile);
  // Only a video you generated is accepted there, so a local file cannot work.
  assert.ok(!byId("upscaleVideo").fields.find(f => f.name === "video").isFile);
});

test("createUpload is hidden and deprecated reads are gone", () => {
  assert.equal(byId("createUpload").hidden, true);
  assert.equal(byId("getImageResults"), undefined);
});

test("finds commands by group/name and by operationId", () => {
  assert.equal(findCommand(commands, ["image", "create"]).command.operationId, "createImage");
  assert.equal(findCommand(commands, ["createImage"]).command.operationId, "createImage");
  assert.equal(findCommand(commands, ["nope"]).command, undefined);
});

test("parses typed flags, negation, repeats and positionals", () => {
  const c = byId("removeBackground");
  const parsed = parseArgv(["--image", "a.png", "--crop", "--no-creative-edit", "--json"]);
  assert.equal(parsed.globals.json, true);
  const r = resolveFlags(c, parsed, []);
  assert.deepEqual(r.body, { image: "a.png", crop: true, creative_edit: false });

  const edit = byId("editSpritesheet");
  const r2 = resolveFlags(edit, parseArgv(["--spritesheet-url", "https://x/s.png", "--prompt", "p", "--images", "a.png", "--images", "b.png"]), []);
  assert.deepEqual(r2.body.images, ["a.png", "b.png"]);

  const get = byId("getApiJob");
  const r3 = resolveFlags(get, parseArgv(["--wait", "30"]), ["job-1"]);
  assert.deepEqual(r3.path, { id: "job-1" });
  assert.equal(r3.query.wait, 30);
});

test("reports missing required flags and bad enum values", () => {
  const c = byId("createImage");
  assert.throws(() => resolveFlags(c, parseArgv(["--prompt", "x"]), []), /Missing required flag: --image-type/);
  assert.throws(() => resolveFlags(c, parseArgv(["--prompt", "x", "--image-type", "bogus"]), []), /must be one of/);
  assert.throws(() => resolveFlags(c, parseArgv(["--nope", "1"]), []), /Unknown flag --nope/);
});

test("--input supplies the body and flags override it", () => {
  const file = new URL("./fixtures/body.json", import.meta.url);
  fs.mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ prompt: "from file", image_type: "sprite" }));
  const r = resolveFlags(byId("createImage"), parseArgv(["--input", file.pathname, "--prompt", "from flag"]), []);
  assert.deepEqual(r.body, { prompt: "from flag", image_type: "sprite" });
});

test("a missing --input or @file is a usage error, not a crash", () => {
  const c = byId("createImage");
  assert.throws(() => resolveFlags(c, parseArgv(["--input", "/nope/body.json"]), []), err => err instanceof CliError && err.exitCode === EXIT.USAGE && /--input: file not found: \/nope\/body\.json/.test(err.message));
  const dir = new URL("./fixtures/", import.meta.url).pathname;
  assert.throws(() => resolveFlags(c, parseArgv(["--input", dir]), []), /is a folder, not a file/);
});
