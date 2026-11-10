import { run } from "./osascript.js";

/** True when ioreg's Root entry says the login session is locked. */
export function isConsoleLocked(ioregOutput: string): boolean {
  return /"IOConsoleLocked" = Yes/.test(ioregOutput);
}

/** Whether the Mac's screen is locked. While it is, hidden apps show no windows to Accessibility. */
export async function screenLocked(): Promise<boolean> {
  try {
    return isConsoleLocked((await run("ioreg", ["-n", "Root", "-d1"], 10_000)).stdout);
  } catch {
    return false; // Can't tell: don't block work on a failed check.
  }
}

export const LOCKED_MESSAGE =
  "The screen is locked, so the app's windows can't be reached and any result would come back empty. Nothing was done. Unlock the Mac and run this again.";
