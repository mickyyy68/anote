import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPreferenceValues } from "@raycast/api";
import { bridgeTimeoutMs, type BridgeCommandSource } from "./bridge-timeout";
import type {
  CreateNoteRequest,
  CreateNoteResponse,
  DeleteNoteRequest,
  UpdateNoteRequest,
} from "./types";

type BridgeResponse = {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
};

const BRIDGE_LOG_PATH = path.join(os.homedir(), ".anote", "raycast-bridge.log");
const HOME_CARGO_BIN = path.join(os.homedir(), ".cargo", "bin", "cargo");
const DEFAULT_PATH_ENTRIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  path.join(os.homedir(), ".cargo", "bin"),
];

type BridgePreferences = {
  bridgeBinaryPath?: string;
  bridgeRepoRoot?: string;
};

type ResolvedBridgeCommand = {
  cmd: string;
  args: string[];
  source: BridgeCommandSource;
  diagnostics: {
    cwd: string;
    explicitPath: string | null;
    explicitPathExists: boolean;
    preferenceBinaryPath: string | null;
    preferenceBinaryExists: boolean;
    preferenceRepoRoot: string | null;
    preferenceRepoRootHasManifest: boolean;
    dirname: string;
    appBridgeCandidates: string[];
    appBridgePath: string | null;
    appMainCandidates: string[];
    appMainPath: string | null;
    discoveredRoots: string[];
    localBinCandidates: string[];
    localBin: string | null;
    localBinExists: boolean;
    cargoManifestPath: string | null;
    cargoManifestExists: boolean;
    cargoCmd: string;
  };
};

export class BridgeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    Object.setPrototypeOf(this, BridgeError.prototype);
  }
}

export function bridgeErrorMessage(error: unknown): string {
  if (error instanceof BridgeError) {
    return `${error.code}: ${error.message}`;
  }
  return String(error || "Unknown error");
}

function summarizePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    payload as Record<string, unknown>,
  )) {
    if (typeof value === "string") {
      summary[key] = `<string:${value.length}>`;
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

function logBridgeEvent(event: string, details: Record<string, unknown>) {
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(details)}\n`;
  try {
    mkdirSync(path.dirname(BRIDGE_LOG_PATH), { recursive: true });
    appendFileSync(BRIDGE_LOG_PATH, line, "utf8");
  } catch {
    // Logging must never break command execution paths.
  }
  console.error(`[anote bridge] ${event}`, details);
}

function readBridgePreferences(): BridgePreferences {
  try {
    const pref = getPreferenceValues<BridgePreferences>();
    return {
      bridgeBinaryPath: pref.bridgeBinaryPath?.trim() || undefined,
      bridgeRepoRoot: pref.bridgeRepoRoot?.trim() || undefined,
    };
  } catch {
    return {};
  }
}

function getParentDirs(start: string): string[] {
  if (!start) return [];
  const dirs: string[] = [];
  let current = path.resolve(start);
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function discoverRepoRoots(): string[] {
  const pref = readBridgePreferences();
  const preferenceRepoRoot = pref.bridgeRepoRoot
    ? path.resolve(pref.bridgeRepoRoot)
    : "";
  const preferenceRepoSrcTauri = preferenceRepoRoot
    ? path.join(preferenceRepoRoot, "src-tauri")
    : "";
  const seeds = [process.cwd(), __dirname, process.env.PWD || ""].filter(
    Boolean,
  );
  if (preferenceRepoRoot) seeds.push(preferenceRepoRoot);
  if (preferenceRepoSrcTauri) seeds.push(preferenceRepoSrcTauri);
  const uniqueRoots = new Set<string>();
  for (const seed of seeds) {
    for (const dir of getParentDirs(seed)) {
      if (existsSync(path.join(dir, "src-tauri", "Cargo.toml"))) {
        uniqueRoots.add(dir);
      }
    }
  }
  return [...uniqueRoots];
}

function resolvedPathEnv(): string {
  const fromEnv = (process.env.PATH || "").split(":").filter(Boolean);
  const merged = [...fromEnv, ...DEFAULT_PATH_ENTRIES];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of merged) {
    if (!seen.has(entry)) {
      seen.add(entry);
      deduped.push(entry);
    }
  }
  return deduped.join(":");
}

function resolveBridgeCommand(): ResolvedBridgeCommand {
  const pref = readBridgePreferences();
  const explicitPath = process.env.ANOTE_BRIDGE_BIN;
  const explicitPathExists = !!(explicitPath && existsSync(explicitPath));
  const preferenceBinaryPath = pref.bridgeBinaryPath
    ? path.resolve(pref.bridgeBinaryPath)
    : null;
  const preferenceBinaryExists = !!(
    preferenceBinaryPath && existsSync(preferenceBinaryPath)
  );
  const preferenceRepoRoot = pref.bridgeRepoRoot
    ? path.resolve(pref.bridgeRepoRoot)
    : null;
  const preferenceRepoRootHasManifest = !!(
    preferenceRepoRoot &&
    existsSync(path.join(preferenceRepoRoot, "src-tauri", "Cargo.toml"))
  );
  const appBridgeCandidates = [
    path.join(
      "/Applications",
      "anote.app",
      "Contents",
      "MacOS",
      "anote_bridge",
    ),
    path.join(
      os.homedir(),
      "Applications",
      "anote.app",
      "Contents",
      "MacOS",
      "anote_bridge",
    ),
    path.join(os.homedir(), ".anote", "bin", "anote_bridge"),
  ];
  const appBridgePath =
    appBridgeCandidates.find((candidate) => existsSync(candidate)) ?? null;
  const appMainCandidates = [
    path.join("/Applications", "anote.app", "Contents", "MacOS", "anote"),
    path.join(
      os.homedir(),
      "Applications",
      "anote.app",
      "Contents",
      "MacOS",
      "anote",
    ),
  ];
  const appMainPath =
    appMainCandidates.find((candidate) => existsSync(candidate)) ?? null;
  const discoveredRoots = discoverRepoRoots();
  const localBinCandidates = discoveredRoots.map((root) =>
    path.join(root, "src-tauri", "target", "debug", "anote_bridge"),
  );
  const localBin =
    localBinCandidates.find((candidate) => existsSync(candidate)) ?? null;
  const localBinExists = !!localBin;
  const cargoManifestPath =
    discoveredRoots
      .map((root) => path.join(root, "src-tauri", "Cargo.toml"))
      .find((candidate) => existsSync(candidate)) ?? null;
  const cargoManifestExists = !!cargoManifestPath;
  const cargoCmd = existsSync(HOME_CARGO_BIN) ? HOME_CARGO_BIN : "cargo";

  const diagnostics = {
    cwd: process.cwd(),
    explicitPath: explicitPath ?? null,
    explicitPathExists,
    preferenceBinaryPath,
    preferenceBinaryExists,
    preferenceRepoRoot,
    preferenceRepoRootHasManifest,
    dirname: __dirname,
    appBridgeCandidates,
    appBridgePath,
    appMainCandidates,
    appMainPath,
    discoveredRoots,
    localBinCandidates,
    localBin,
    localBinExists,
    cargoManifestExists,
    cargoManifestPath,
    cargoCmd,
  };

  if (explicitPathExists && explicitPath) {
    return {
      cmd: explicitPath,
      args: [] as string[],
      source: "env",
      diagnostics,
    };
  }

  if (preferenceBinaryPath && preferenceBinaryExists) {
    return {
      cmd: preferenceBinaryPath,
      args: [] as string[],
      source: "pref_bin",
      diagnostics,
    };
  }

  if (appBridgePath) {
    return {
      cmd: appBridgePath,
      args: [] as string[],
      source: "app_bridge",
      diagnostics,
    };
  }

  if (appMainPath) {
    // Production-safe fallback: the installed app binary can proxy bridge requests via --bridge-cli.
    return {
      cmd: appMainPath,
      args: ["--bridge-cli"],
      source: "app_main_cli",
      diagnostics,
    };
  }

  if (localBin) {
    return {
      cmd: localBin,
      args: [] as string[],
      source: "local",
      diagnostics,
    };
  }

  if (!cargoManifestPath) {
    throw new Error(
      `bridge binary not resolved; install/update anote app or set ANOTE_BRIDGE_BIN/bridgeBinaryPath. See ${BRIDGE_LOG_PATH}`,
    );
  }

  // Last-resort fallback for local dev when no prebuilt binary path is available.
  const args = ["run", "--quiet"];
  args.push("--manifest-path", cargoManifestPath);
  args.push("--bin", "anote_bridge");

  return {
    cmd: cargoCmd,
    args,
    source: "cargo",
    diagnostics,
  };
}

async function callBridge<T>(op: string, payload: unknown): Promise<T> {
  const requestJson = JSON.stringify({ op, payload });
  let cmd: string;
  let args: string[];
  let source: ResolvedBridgeCommand["source"];
  let diagnostics: ResolvedBridgeCommand["diagnostics"];
  try {
    const resolved = resolveBridgeCommand();
    cmd = resolved.cmd;
    args = resolved.args;
    source = resolved.source;
    diagnostics = resolved.diagnostics;
  } catch (error) {
    logBridgeEvent("bridge_resolution_failed", {
      op,
      error: String(error),
      payload: summarizePayload(payload),
      cwd: process.cwd(),
      dirname: __dirname,
    });
    throw error;
  }

  const response = await new Promise<string>((resolve, reject) => {
    let spawnFailed = false;
    let timeoutHit = false;
    const timeoutMs = bridgeTimeoutMs(source);
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: resolvedPathEnv(),
      },
    });
    const timeout = setTimeout(() => {
      timeoutHit = true;
      child.kill("SIGKILL");
      logBridgeEvent("bridge_timeout", {
        op,
        cmd,
        args,
        source,
        timeout_ms: timeoutMs,
        payload: summarizePayload(payload),
        diagnostics,
      });
      reject(new Error(`bridge request timed out; see ${BRIDGE_LOG_PATH}`));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      spawnFailed = true;
      clearTimeout(timeout);
      const errno = error as NodeJS.ErrnoException;
      logBridgeEvent("spawn_error", {
        op,
        cmd,
        args,
        source,
        code: errno.code ?? null,
        message: errno.message,
        path: errno.path ?? null,
        syscall: errno.syscall ?? null,
        payload: summarizePayload(payload),
        diagnostics,
      });

      if (errno.code === "ENOENT") {
        reject(
          new Error(
            `bridge executable not found (${cmd}); install/update anote app or set ANOTE_BRIDGE_BIN/bridgeBinaryPath. See ${BRIDGE_LOG_PATH}`,
          ),
        );
        return;
      }

      reject(
        new Error(
          `failed to launch bridge: ${errno.message}; see ${BRIDGE_LOG_PATH}`,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (spawnFailed) return;
      if (timeoutHit) return;
      if (code !== 0) {
        const trimmedStderr = stderr.trim();
        const trimmedStdout = stdout.trim();
        logBridgeEvent("bridge_exit_nonzero", {
          op,
          cmd,
          args,
          source,
          code,
          stderr: trimmedStderr || null,
          stdout: trimmedStdout || null,
          payload: summarizePayload(payload),
          diagnostics,
        });
        if (source === "app_main_cli" && !trimmedStderr) {
          reject(
            new Error(
              `installed anote app does not support bridge protocol yet; update anote to a build with --bridge-cli support. See ${BRIDGE_LOG_PATH}`,
            ),
          );
          return;
        }
        reject(
          new Error(
            trimmedStderr ||
              `bridge exited with code ${code}; see ${BRIDGE_LOG_PATH}`,
          ),
        );
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.write(requestJson);
    child.stdin.end();
  });

  let parsed: BridgeResponse;
  try {
    parsed = JSON.parse(response) as BridgeResponse;
  } catch {
    logBridgeEvent("bridge_invalid_json", {
      op,
      cmd,
      args,
      source,
      response_preview: response.slice(0, 500),
      payload: summarizePayload(payload),
      diagnostics,
    });
    if (source === "app_main_cli" && response.trim() === "") {
      throw new Error(
        `installed anote app returned no bridge response; update anote to a build with --bridge-cli support. See ${BRIDGE_LOG_PATH}`,
      );
    }
    throw new Error("Bridge returned invalid JSON response");
  }

  if (!parsed.ok) {
    const code = parsed.error?.code || "INTERNAL";
    const message = parsed.error?.message || "Bridge request failed";
    throw new BridgeError(code, message);
  }

  return parsed.data as T;
}

type RawCreateNoteResponse = {
  id: string;
  folder_id: string;
  created_at: number;
  updated_at: number;
};

export async function createNoteViaBridge(
  input: CreateNoteRequest,
): Promise<CreateNoteResponse> {
  const raw = await callBridge<RawCreateNoteResponse>("create_note", {
    title: input.title,
    body: input.body,
    folder_id: input.folderId,
  });
  return {
    id: raw.id,
    folderId: raw.folder_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export async function updateNoteViaBridge(
  input: UpdateNoteRequest,
): Promise<void> {
  await callBridge("update_note", {
    id: input.id,
    title: input.title,
    body: input.body,
    updated_at: input.updatedAt,
  });
}

export async function deleteNoteViaBridge(
  input: DeleteNoteRequest,
): Promise<void> {
  await callBridge("delete_note", {
    id: input.id,
    updated_at: input.updatedAt,
  });
}
