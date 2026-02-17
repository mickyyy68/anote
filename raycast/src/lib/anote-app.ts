import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function openAnoteApp(): Promise<void> {
  try {
    // Fast path: open by app name for local dev installs.
    await execFileAsync("open", ["-a", "anote"]);
  } catch {
    // Fallback: open by bundle ID for packaged installs.
    await execFileAsync("open", ["-b", "com.anote.app"]);
  }
}
