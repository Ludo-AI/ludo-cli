// Stable exit codes. Agents branch on these, so never renumber one: add new
// codes at the end.
export const EXIT = {
  OK: 0,
  ERROR: 1, // network failure, server error, anything unclassified
  USAGE: 2, // unknown command, bad or missing flag
  AUTH: 3, // no API key, or the key was rejected
  INVALID: 4, // the API rejected the request (400/404/409)
  CREDITS: 5, // not enough credits (402)
  JOB_FAILED: 6, // the generation job failed (credits refunded)
  JOB_CANCELED: 7,
  RATE_LIMITED: 8, // 429, including PENDING_JOBS_LIMIT
  TIMEOUT: 9, // --timeout elapsed while the job was still running
  UPGRADE_REQUIRED: 10, // this CLI version is below the API's minimum (426)
  BUDGET: 11, // the spending guard refused: over --max-credits or the session budget
  INTERRUPTED: 130
} as const;

export class CliError extends Error {
  exitCode: number;
  hint?: string;
  details?: unknown;
  // Set when the error may only mean the cached spec is out of date: an
  // unknown command, flag or value. The CLI refreshes the spec and retries.
  specMismatch?: boolean;
  // Set when the API could not be reached at all (safe requests retry once).
  network?: boolean;

  constructor(message: string, exitCode: number = EXIT.ERROR, hint?: string, details?: unknown) {
    super(message);
    this.exitCode = exitCode;
    this.hint = hint;
    this.details = details;
  }
}

export function specMismatch(message: string, hint?: string): CliError {
  const err = new CliError(message, EXIT.USAGE, hint);
  err.specMismatch = true;
  return err;
}

export function exitCodeForStatus(status: number): number {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 402) return EXIT.CREDITS;
  if (status === 429) return EXIT.RATE_LIMITED;
  if (status >= 400 && status < 500) return EXIT.INVALID;
  return EXIT.ERROR;
}
