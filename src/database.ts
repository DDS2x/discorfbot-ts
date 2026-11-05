import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("activity.db");

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
}

/** Обновляет дату последнего сообщения и сбрасывает предупреждение */
export function updateActivity(userId: string): void {
  db.prepare(
    `INSERT INTO users (user_id, last_message_date, warned, warned_date)
     VALUES (?, ?, 0, NULL)
     ON CONFLICT(user_id) DO UPDATE SET
       last_message_date = excluded.last_message_date,
       warned = 0,
       warned_date = NULL`,
  ).run(userId, formatDate(new Date()));
}

export function getAllUsers(): UserRow[] {
  return db
    .prepare("SELECT user_id, last_message_date, warned, warned_date FROM users")
    .all() as unknown as UserRow[];
}

export function setWarned(userId: string, dateStr: string): void {
  db.prepare("UPDATE users SET warned = 1, warned_date = ? WHERE user_id = ?").run(dateStr, userId);
}

export function deleteUser(userId: string): void {
  db.prepare("DELETE FROM users WHERE user_id = ?").run(userId);
}
