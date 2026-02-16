import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CreateNoteRequest, CreateNoteResponse, UpdateNoteRequest } from "./types";

type BridgeResponse = {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
};

export class BridgeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function resolveBridgeCommand() {
  const explicitPath = process.env.ANOTE_BRIDGE_BIN;
  if (explicitPath && existsSync(explicitPath)) {
    return { cmd: explicitPath, args: [] as string[] };
  }

  const localBin = path.resolve(process.cwd(), "../src-tauri/target/debug/anote_bridge");
  if (existsSync(localBin)) {
    return { cmd: localBin, args: [] as string[] };
  }

  // Last-resort fallback for local dev when no prebuilt binary path is available.
  return {
    cmd: "cargo",
    args: [
      "run",
      "--quiet",
      "--manifest-path",
      path.resolve(process.cwd(), "../src-tauri/Cargo.toml"),
      "--bin",
      "anote_bridge",
    ],
  };
}

async function callBridge<T>(op: string, payload: unknown): Promise<T> {
  const requestJson = JSON.stringify({ op, payload });
  const { cmd, args } = resolveBridgeCommand();

  const response = await new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `bridge exited with code ${code}`));
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
    throw new Error("Bridge returned invalid JSON response");
  }

  if (!parsed.ok) {
    const code = parsed.error?.code || "INTERNAL";
    const message = parsed.error?.message || "Bridge request failed";
    throw new BridgeError(code, message);
  }

  return parsed.data as T;
}

export async function createNoteViaBridge(input: CreateNoteRequest): Promise<CreateNoteResponse> {
  return callBridge<CreateNoteResponse>("create_note", {
    title: input.title,
    body: input.body,
    folder_id: input.folderId,
  });
}

export async function updateNoteViaBridge(input: UpdateNoteRequest): Promise<void> {
  await callBridge("update_note", {
    id: input.id,
    title: input.title,
    body: input.body,
    updated_at: input.updatedAt,
  });
}
