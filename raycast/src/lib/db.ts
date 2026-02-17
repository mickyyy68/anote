import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ReadonlyNote, ReadonlyNoteSummary } from "./types";

const execFileAsync = promisify(execFile);
const SQLITE_BIN = "sqlite3";
const DB_PATH = path.join(os.homedir(), ".anote", "anote.db");

function ensureDbExists() {
  if (!existsSync(DB_PATH)) {
    throw new Error(`anote database not found at ${DB_PATH}`);
  }
}

function escapeSqlLiteral(input: string): string {
  return `'${input.replace(/'/g, "''")}'`;
}

async function queryJson(sql: string): Promise<Record<string, unknown>[]> {
  ensureDbExists();
  // Shelling out to sqlite3 keeps the extension dependency-light and aligned with the app DB.
  const { stdout } = await execFileAsync(SQLITE_BIN, ["-json", DB_PATH, sql], {
    maxBuffer: 1024 * 1024 * 20,
  });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as Record<string, unknown>[];
}

function toSummary(row: Record<string, unknown>): ReadonlyNoteSummary {
  return {
    id: String(row.id ?? ""),
    folderId: String(row.folder_id ?? ""),
    folderName: String(row.folder_name ?? ""),
    title: String(row.title ?? ""),
    preview: String(row.preview ?? ""),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function toNote(row: Record<string, unknown>): ReadonlyNote {
  return {
    id: String(row.id ?? ""),
    folderId: String(row.folder_id ?? ""),
    folderName: String(row.folder_name ?? ""),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    pinned: Number(row.pinned ?? 0),
    sortOrder: Number(row.sort_order ?? 0),
  };
}

export async function searchNotesReadOnly(query: string, limit = 80): Promise<ReadonlyNoteSummary[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const trimmed = query.trim();

  if (!trimmed) {
    const sql = `
      SELECT n.id, n.folder_id, n.title, substr(n.body, 1, 200) AS preview,
             n.updated_at, COALESCE(f.name, '') AS folder_name
      FROM notes n
      LEFT JOIN folders f ON f.id = n.folder_id
      ORDER BY n.updated_at DESC
      LIMIT ${safeLimit};
    `;
    const rows = await queryJson(sql);
    return rows.map(toSummary);
  }

  const escapedQuery = escapeSqlLiteral(trimmed);
  const ftsSql = `
    SELECT n.id, n.folder_id, n.title, substr(n.body, 1, 200) AS preview,
           n.updated_at, COALESCE(f.name, '') AS folder_name
    FROM notes_fts nf
    JOIN notes n ON n.rowid = nf.rowid
    LEFT JOIN folders f ON f.id = n.folder_id
    WHERE notes_fts MATCH ${escapedQuery}
    ORDER BY rank
    LIMIT ${safeLimit};
  `;

  try {
    const rows = await queryJson(ftsSql);
    return rows.map(toSummary);
  } catch {
    // FTS MATCH can fail for malformed syntax; fallback keeps search usable.
    const escapedLike = escapeSqlLiteral(`%${trimmed}%`);
    const fallbackSql = `
      SELECT n.id, n.folder_id, n.title, substr(n.body, 1, 200) AS preview,
             n.updated_at, COALESCE(f.name, '') AS folder_name
      FROM notes n
      LEFT JOIN folders f ON f.id = n.folder_id
      WHERE n.title LIKE ${escapedLike} OR n.body LIKE ${escapedLike}
      ORDER BY n.updated_at DESC
      LIMIT ${safeLimit};
    `;
    const rows = await queryJson(fallbackSql);
    return rows.map(toSummary);
  }
}

export async function getReadonlyNoteById(id: string): Promise<ReadonlyNote | null> {
  const escapedId = escapeSqlLiteral(id);
  const sql = `
    SELECT n.id, n.folder_id, n.title, n.body, n.created_at, n.updated_at,
           n.pinned, n.sort_order, COALESCE(f.name, '') AS folder_name
    FROM notes n
    LEFT JOIN folders f ON f.id = n.folder_id
    WHERE n.id = ${escapedId}
    LIMIT 1;
  `;
  const rows = await queryJson(sql);
  if (rows.length === 0) return null;
  return toNote(rows[0]);
}
