// Leaving the process on a signal (Ctrl-C, or a coding agent stopping a long
// command). Every signal handler exits through exitNow, so the command's usage
// event is still sent: without this, an interrupted command vanished from the
// stats. The hook gets a second at most, then the process exits regardless.
//
// The first exitNow wins: a handler with a more specific message (such as the
// "job keeps running" hint) runs before the generic one and sets the code.

const HOOK_TIMEOUT_MS = 1000;

let hook: ((code: number) => Promise<void>) | undefined;
let exiting = false;

export function onExit(fn: (code: number) => Promise<void>) {
  hook = fn;
}

export function exitNow(code: number): void {
  if (exiting) return;
  exiting = true;
  const done = () => process.exit(code);
  if (!hook) return done();
  const timer = setTimeout(done, HOOK_TIMEOUT_MS);
  timer.unref?.();
  hook(code).then(done, done);
}

// The generic handlers, installed once by the `ludo` command. They run after
// any handler a command added itself (setImmediate), so those keep their say.
export function handleSignals() {
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  for (const sig of Object.keys(codes) as (keyof typeof codes)[]) {
    process.on(sig, () => setImmediate(() => exitNow(codes[sig])));
  }
}
