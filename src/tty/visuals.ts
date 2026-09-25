import { isAgent } from "../login.js";

// The one gate for everything decorative: previews, animation, the spinner,
// colour and the logo. All of it is drawn on stderr, and only for a person at
// a terminal. Coding agents, pipes, CI logs, --json, --quiet and --plain get
// exactly the plain output they always did, so a preview never costs an agent
// a single token.

export interface VisualOptions {
  json: boolean;
  quiet: boolean;
  plain: boolean;
}

export interface Visuals {
  enabled: boolean;
  truecolor: boolean;
  columns: number;
}

export function visuals(opts: VisualOptions): Visuals {
  const env = process.env;
  const off =
    opts.json ||
    opts.quiet ||
    opts.plain ||
    !process.stderr.isTTY ||
    // `ludo ... | jq` has a person watching stderr, but they asked for data.
    !process.stdout.isTTY ||
    isAgent() ||
    !!env.CI ||
    env.TERM === "dumb" ||
    env.NO_COLOR !== undefined ||
    env.LUDO_PREVIEW === "0" ||
    // Legacy Windows consoles mangle block characters and colour.
    (process.platform === "win32" && !env.WT_SESSION && env.TERM_PROGRAM !== "vscode");
  const truecolor = /truecolor|24bit/i.test(env.COLORTERM || "") || ["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(env.TERM_PROGRAM || "") || !!env.WT_SESSION;
  return { enabled: !off, truecolor, columns: process.stderr.columns || 80 };
}

// Hidden cursor and half-drawn colour must never outlive the process, however
// it ends. Registered the first time anything draws.
let restoring = false;
export function restoreTerminal() {
  if (!restoring) return;
  try {
    process.stderr.write("\x1b[0m\x1b[?25h");
  } catch {
    // Nothing more to do while exiting.
  }
}

export function armRestore() {
  if (restoring) return;
  restoring = true;
  process.on("exit", restoreTerminal);
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      restoreTerminal();
      process.exit(128 + (sig === "SIGTERM" ? 15 : 1));
    });
  }
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
