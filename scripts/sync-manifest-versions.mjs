// Runs from `npm version` (the "version" script): copies the new package.json
// version into the agent plugin manifests, so Claude Code and Gemini CLI see
// each release as an update. npm stages the files we `git add` here into the
// version commit.
import fs from "node:fs";

const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
for (const file of [".claude-plugin/plugin.json", "gemini-extension.json"]) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.version = version;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}
