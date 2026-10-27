import fs from "node:fs";
import { CliError, EXIT, localFsError } from "../errors.js";

// Every toolbox input is read through here, so a file that will not open is a
// usage error that says why, never a crash. Permission and disk errors go on
// to localFsError's wording at the top; anything else the path itself causes
// gets words of its own (LUDO-CLI-A: 14 paths in one argument made a name too
// long, and the loader only knew "not found").

const REASONS: Record<string, string> = {
  ENAMETOOLONG: "the name is too long",
  ENOTDIR: "part of the path is not a folder",
  ELOOP: "too many symbolic links on the way",
  EINVAL: "not a valid file name"
};

// `what` names the file in an error: "an image", "a sound", "a model".
export function readInput(file: string, what: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    throw openError(err, file, what);
  }
}

export function openError(err: unknown, file: string, what: string): unknown {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (!code || localFsError(err)) return err;
  // One quoted argument holding several files reads as one long name.
  const several = /\s/.test(file) && (code === "ENOENT" || code === "ENAMETOOLONG") ? "Give each file as its own argument, not several in one quoted string." : undefined;
  if (code === "ENOENT") return new CliError(`File not found: ${file}`, EXIT.USAGE, several);
  if (code === "EISDIR") return new CliError(`${file} is a folder, not ${what}`, EXIT.USAGE);
  return new CliError(`Cannot open ${file}: ${REASONS[code] ?? code}`, EXIT.USAGE, several);
}
