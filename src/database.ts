import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("activity.db");

/**
 * users.user_id is INTEGER PRIMARY KEY (rowid) and Discord IDs do not fit in a JS number.
 * Bigint mode lets run() return lastInsertRowid without throwing.
 */
function prepareBig(sql: string) {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  return stmt;
}

export interface UserRow {
  user_id: string;
  last_message_date: string;
  warned: number;
  warned_date: string | null;
}

/** Формат "YYYY-MM-DD HH:MM:SS" (локальное время) — совместим со старой базой от Python-версии */
export function formatDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

export function parseDate(str: string): Date {
  return new Date(str.replace(" ", "T"));
}

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      last_message_date TEXT,
      warned INTEGER DEFAULT 0,
      warned_date TEXT
    )
  `);
  initGpuTable();
}

/** Обновляет дату последнего сообщения и сбрасывает предупреждение */
export function updateActivity(userId: string): void {
  prepareBig(
    `INSERT INTO users (user_id, last_message_date, warned, warned_date)
     VALUES (?, ?, 0, NULL)
     ON CONFLICT(user_id) DO UPDATE SET
       last_message_date = excluded.last_message_date,
       warned = 0,
       warned_date = NULL`,
  ).run(userId, formatDate(new Date()));
}

export function getAllUsers(): UserRow[] {
  // CAST в TEXT: ID Discord (~1e18) не помещаются в безопасный number
  return db
    .prepare(
      "SELECT CAST(user_id AS TEXT) AS user_id, last_message_date, warned, warned_date FROM users",
    )
    .all() as unknown as UserRow[];
}

// ---------------- GPU-прокачка ----------------

export interface GpuRow {
  user_id: string;
  branch: string;
  xp: number;
  mined: number;
  defects: string; // id дебафов через запятую
}

export function initGpuTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gpu_users (
      user_id TEXT PRIMARY KEY,
      branch TEXT NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0,
      mined INTEGER NOT NULL DEFAULT 0,
      defects TEXT NOT NULL DEFAULT ''
    )
  `);
}

export function getGpu(userId: string): GpuRow | undefined {
  return db.prepare("SELECT * FROM gpu_users WHERE user_id = ?").get(userId) as unknown as
    | GpuRow
    | undefined;
}

export function createGpu(userId: string, branch: string): void {
  db.prepare("INSERT INTO gpu_users (user_id, branch) VALUES (?, ?)").run(userId, branch);
}

export function saveGpu(row: GpuRow): void {
  db.prepare("UPDATE gpu_users SET xp = ?, mined = ?, defects = ? WHERE user_id = ?").run(
    row.xp,
    row.mined,
    row.defects,
    row.user_id,
  );
}

export function setWarned(userId: string, dateStr: string): void {
  prepareBig("UPDATE users SET warned = 1, warned_date = ? WHERE user_id = ?").run(dateStr, userId);
}

export function deleteUser(userId: string): void {
  prepareBig("DELETE FROM users WHERE user_id = ?").run(userId);
}
