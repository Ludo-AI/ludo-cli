import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cacheDir, configDir, launchedAsCli, PACKAGE_ROOT, readConfig, VERSION } from "./config.js";
import { compareVersions } from "./notices.js";

// Automatic updates. Most runs come from agents, which never act on an
// "update available" line, so when the API says a newer ludo is out, the CLI
// installs it itself: `npm install -g @ludoai/cli@<version>` in a detached
// child, so the command that noticed it is not slowed down and the next
// command runs the new version.
//
// It only does this where an update cannot go wrong:
//   - this copy was installed with `npm install -g` (not npx, not a project's
//     dependency), into a folder this user can write to (no sudo), and the
//     npm on the PATH installs into that same folder;
//   - not in CI, not offline, and not turned off: `ludo update --auto off`
//     (saved in config.json) or LUDO_AUTO_UPDATE=0;
//   - at most one attempt a day, and one at a time across parallel sessions.
// Anywhere else the update line is printed instead (on every run for agents).

const PACKAGE = "@ludoai/cli";
const RETRY_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 15 * 60 * 1000;
const RELEASE = /^\d+\.\d+\.\d+$/;
const OFF = ["0", "false", "off", "no"];
const ON = ["1", "true", "on", "yes"];

export interface UpdateState {
  attempted_at?: number;
  version?: string;
  result?: "started" | "ok" | "failed";
  error?: string;
  // The update the next run has already announced as done.
  announced?: string;
}

// What the end-of-run notices should say about updates.
export interface UpdateInfo {
  started?: boolean; // an update to `latest` started in the background
  everyRun?: boolean; // print the update line on every run, not once a day
  failed?: string; // why the last automatic update failed
  updated?: string; // the version this run is, freshly installed by an automatic update
}

export function autoUpdateEnabled(env: NodeJS.ProcessEnv = process.env, config: { auto_update?: boolean } = readConfig()): boolean {
  const v = (env.LUDO_AUTO_UPDATE || "").trim().toLowerCase();
  if (OFF.includes(v)) return false;
  if (ON.includes(v)) return true;
  return config.auto_update !== false;
}

// The global node_modules folder `npm install -g` put this copy in, when it
// can be updated there without sudo; undefined for any other install.
export function globalNodeModules(root: string = PACKAGE_ROOT): string | undefined {
  const scope = path.dirname(root);
  const modules = path.dirname(scope);
  if (path.basename(root) !== "cli" || path.basename(scope) !== "@ludoai" || path.basename(modules) !== "node_modules") return undefined;
  // npx runs from its own cache, which it refreshes itself.
  if (root.split(path.sep).includes("_npx")) return undefined;
  // A package.json beside node_modules means a project (or a pnpm/yarn
  // global store) owns this copy and pins its version.
  if (fs.existsSync(path.join(path.dirname(modules), "package.json"))) return undefined;
  try {
    fs.accessSync(modules, fs.constants.W_OK);
    fs.accessSync(root, fs.constants.W_OK);
  } catch {
    return undefined;
  }
  return modules;
}

// Whether to start an update to `latest` now. Pure, for tests.
export function updateDue(state: UpdateState, latest: string | undefined, current: string, now: number): boolean {
  if (!latest || !RELEASE.test(latest) || compareVersions(latest, current) <= 0) return false;
  return !state.attempted_at || now - state.attempted_at >= RETRY_MS;
}

const stateFile = () => path.join(configDir(), "auto-update.json");
const lockFile = () => path.join(configDir(), "auto-update.lock");
export const updateLogFile = () => path.join(cacheDir(), "auto-update.log");

export function readUpdateState(): UpdateState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) || {};
  } catch {
    return {};
  }
}

function writeUpdateState(state: UpdateState) {
  try {
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const tmp = `${stateFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state) + "\n");
    fs.renameSync(tmp, stateFile());
  } catch {
    // Costs at most one more attempt.
  }
}

// One update at a time across every ludo running on this machine. A lock left
// by a crashed install is taken over after LOCK_STALE_MS.
function takeLock(now: number): boolean {
  try {
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.writeFileSync(lockFile(), `${process.pid} ${now}\n`, { flag: "wx" });
      return true;
    } catch {
      try {
        if (now - fs.statSync(lockFile()).mtimeMs < LOCK_STALE_MS) return false;
        fs.unlinkSync(lockFile());
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock() {
  try {
    fs.unlinkSync(lockFile());
  } catch {
    // Already gone.
  }
}

// Called once a command has run, with the newest version the API reported.
export function maybeAutoUpdate(command: string, latest: string | undefined, env: NodeJS.ProcessEnv = process.env, now = Date.now()): UpdateInfo {
  const state = readUpdateState();
  const info: UpdateInfo = {};
  // The run after an automatic update says so once.
  if (state.result === "ok" && state.version === VERSION && state.announced !== VERSION) {
    info.updated = VERSION;
    writeUpdateState({ ...state, announced: VERSION });
  }
  if (!latest || compareVersions(latest, VERSION) <= 0) return info;
  // `ludo update` speaks for itself; `spec refresh` is our own background child.
  if (command === "update" || command === "spec") return info;
  // Agents get the line on every run: they don't remember yesterday's.
  const agent = !process.stderr.isTTY;
  if (env.CI || env.LUDO_OFFLINE === "1" || !autoUpdateEnabled(env)) return info;
  if (!launchedAsCli() || !globalNodeModules()) return { ...info, everyRun: agent };
  if (state.result === "failed" && state.version === latest && state.error) info.failed = state.error;
  if (!updateDue(state, latest, VERSION, now)) return { ...info, everyRun: agent && !!info.failed };
  if (!takeLock(now)) return info;
  writeUpdateState({ attempted_at: now, version: latest, result: "started" });
  try {
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "update", "--background-install", latest], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      env: { ...process.env, LUDO_TELEMETRY: "0" }
    });
    child.on("error", () => releaseLock());
    child.unref();
  } catch {
    releaseLock();
    return { ...info, everyRun: agent };
  }
  return { ...info, started: true, failed: undefined };
}

// `ludo update --background-install <version>`: the detached child above.
// Everything it needs is loaded before npm replaces its files.
export function backgroundInstall(version: string): number {
  const win = process.platform === "win32";
  const npm = win ? "npm.cmd" : "npm";
  let log: number | undefined;
  const finish = (result: "ok" | "failed", error?: string) => {
    writeUpdateState({ ...readUpdateState(), version, result, ...(error ? { error } : { error: undefined }) });
    releaseLock();
    if (log !== undefined) fs.closeSync(log);
    return result === "ok" ? 0 : 1;
  };
  try {
    if (!RELEASE.test(version)) return finish("failed", `${version} is not a release version`);
    const modules = globalNodeModules();
    if (!modules) return finish("failed", "this copy of ludo is not a global npm install this user can write to");
    const root = spawnSync(npm, ["root", "-g"], { encoding: "utf8", shell: win, windowsHide: true, timeout: 60_000 });
    const npmRoot = root.status === 0 ? String(root.stdout).trim() : "";
    const same = (a: string, b: string) => {
      try {
        return fs.realpathSync(a) === fs.realpathSync(b);
      } catch {
        return false;
      }
    };
    if (!npmRoot || !same(npmRoot, modules)) return finish("failed", `the npm on the PATH installs into ${npmRoot || "an unknown folder"}, not ${modules}`);
    fs.mkdirSync(cacheDir(), { recursive: true });
    log = fs.openSync(updateLogFile(), "w");
    const res = spawnSync(npm, ["install", "-g", `${PACKAGE}@${version}`, "--no-fund", "--no-audit"], {
      stdio: ["ignore", log, log],
      shell: win,
      windowsHide: true,
      timeout: 10 * 60_000
    });
    if (res.status === 0) return finish("ok");
    return finish("failed", `npm install exited with ${res.status ?? res.signal ?? res.error?.message}; see ${updateLogFile()}`);
  } catch (err) {
    return finish("failed", (err as Error)?.message || String(err));
  }
}
