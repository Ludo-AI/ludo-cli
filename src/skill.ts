import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACKAGE_ROOT, VERSION } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { addLocalNotice, compareVersions } from "./notices.js";
import { noteFact } from "./telemetry.js";

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

// The CLI version that wrote an installed skill, when ludo wrote it and it is
// older than this one. A copy without the version line predates it.
function staleSkill(project: boolean): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(skillTarget(project), "utf8");
  } catch {
    return undefined;
  }
  if (!text.includes(MARKER)) return undefined;
  const from = /<!-- ludo (\S+) -->/.exec(text)?.[1] ?? "0.0.0";
  return compareVersions(from, VERSION) < 0 ? from : undefined;
}

// Runs after every command. Updating the CLI replaces the package, never the
// copy in ~/.claude, so an agent would keep reading the skill of whichever
// version installed it. The personal copy is rewritten; a project's copy is
// part of its repository, so it only gets a notice.
export function refreshSkills(): void {
  try {
    const from = staleSkill(false);
    if (from) {
      installSkill({ project: false, force: false });
      noteFact("skill_refreshed", true);
      addLocalNotice("skill-updated", `Updated the Ludo skill for Claude Code from ${from} to ${VERSION}; a new session picks it up.`);
    }
  } catch {
    // Only costs the old skill for a while longer.
  }
  try {
    const from = staleSkill(true);
    if (from) addLocalNotice("skill-project-stale", `The Ludo skill in this project's .claude/skills is from ${from}; \`ludo skill install --project\` updates it to ${VERSION}.`);
  } catch {
    // As above.
  }
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
