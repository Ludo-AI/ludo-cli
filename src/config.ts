import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_API_URL = "https://api.ludo.ai";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(here, "..");

// True when this process is the `ludo` command itself: node was started on our
// dist/cli.js (npm's bin symlink or Windows .cmd shim both end there). A
// package scanner that imports cli.js or calls the arm functions runs its own
// script, so it fails this check.
export function launchedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(path.join(PACKAGE_ROOT, "dist", "cli.js"));
  } catch {
    return false;
  }
}

export const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

export function configDir(): string {
  if (process.env.LUDO_CONFIG_DIR) return process.env.LUDO_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "ludo");
}

export function cacheDir(): string {
  if (process.env.LUDO_CACHE_DIR) return process.env.LUDO_CACHE_DIR;
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "ludo");
}

interface StoredConfig {
  api_key?: string;
  // "login" when `ludo login` created the key through the browser, so
  // `ludo logout` knows it may revoke it on the server.
  key_source?: "login";
  api_url?: string;
}

function configFile(): string {
  return path.join(configDir(), "config.json");
}

export function readConfig(): StoredConfig {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(config: StoredConfig): string {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const file = configFile();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync keeps an existing file's mode, so tighten it explicitly.
  fs.chmodSync(file, 0o600);
  return file;
}

// Flag, then environment, then the saved login.
export function resolveApiKey(flag?: string): string | undefined {
  return flag || process.env.LUDO_API_KEY || readConfig().api_key || undefined;
}

export function resolveApiUrl(flag?: string): string {
  const url = flag || process.env.LUDO_API_URL || readConfig().api_url || DEFAULT_API_URL;
  return url.replace(/\/+$/, "");
}
