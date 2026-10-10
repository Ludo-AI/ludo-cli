import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACKAGE_ROOT, VERSION } from "./config.js";
import { CliError, EXIT } from "./errors.js";

// `ludo skill install`: puts the bundled Claude Code skill where Claude Code
// finds it, so an agent knows how to use the CLI without loading every tool
// schema. Personal (~/.claude/skills) by default, or the current project's
// .claude/skills with --project. A file we wrote carries a marker, so a
// re-run updates it; a skill file someone else wrote is left alone unless
// --force.

const MARKER = "<!-- Installed by the ludo CLI. `ludo skill install` updates it; `ludo skill uninstall` removes it. -->";

export function bundledSkill(): string {
  return fs.readFileSync(path.join(PACKAGE_ROOT, "skills", "ludo", "SKILL.md"), "utf8");
}

export function skillTarget(project: boolean): string {
  const base = project ? path.join(process.cwd(), ".claude") : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  return path.join(base, "skills", "ludo", "SKILL.md");
}

export function isInstalled(project = false): boolean {
  try {
    return fs.readFileSync(skillTarget(project), "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

export interface SkillResult {
  path: string;
  action: "installed" | "updated" | "unchanged" | "removed" | "absent";
}

export function installSkill(opts: { project: boolean; force: boolean }): SkillResult {
  const target = skillTarget(opts.project);
  const content = `${bundledSkill().trimEnd()}\n\n${MARKER}\n<!-- ludo ${VERSION} -->\n`;
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== undefined && !existing.includes(MARKER) && !opts.force) {
    throw new CliError(`${target} exists and was not written by ludo`, EXIT.USAGE, "Pass --force to replace it.");
  }
  if (existing === content) return { path: target, action: "unchanged" };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  } catch (err) {
    // A base folder that can't be resolved (a CLAUDE_CONFIG_DIR on a missing
    // drive, a broken link): the person's setup, not a crash (LUDO-CLI-7).
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    throw new CliError(
      `Could not create ${path.dirname(target)}: ${code === "ENOENT" ? "a folder on the way does not exist" : "part of the path is not a folder"}.`,
      EXIT.ERROR,
      opts.project
        ? "Run it from a project folder you can write to."
        : "Check that CLAUDE_CONFIG_DIR (or ~/.claude) points to a folder that exists, or install into this project with --project."
    );
  }
  return { path: target, action: existing === undefined ? "installed" : "updated" };
}

export function uninstallSkill(opts: { project: boolean; force: boolean }): SkillResult {
  const target = skillTarget(opts.project);
  let existing: string;
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch {
    return { path: target, action: "absent" };
  }
  if (!existing.includes(MARKER) && !opts.force) {
    throw new CliError(`${target} was not written by ludo`, EXIT.USAGE, "Pass --force to remove it anyway.");
  }
  fs.rmSync(target);
  try {
    fs.rmdirSync(path.dirname(target)); // only if now empty
  } catch {
    // Other files live there; leave the folder.
  }
  return { path: target, action: "removed" };
}
