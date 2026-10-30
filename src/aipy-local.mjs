// 读 AiPy Pro 本机的登录态（SQLite 里那条 trustoken-token）
//
// 只做一件事：从 `%APPDATA%\aipy-pro\aipy` 读出客户端已经登录的 token，供
// 「本机登录（读取 AiPy 会话）」导入用。找不到/没装都安静地返回 null。
//
// ⚠ 这里曾经还有一套「创建 AiPy 任务」的本地 API 调用（找端口 / 读 key / 建任务），
//   用来刷 trustoken 的每日任务进度。社区 review 指出那是在「farms a vendor's promotion
//   on the user's account」，已整段删除 —— 本机接口只读，不再驱动 AiPy 客户端做任何事。

import { existsSync } from "node:fs"
import path from "node:path"

/** AiPy Pro 的 SQLite：%APPDATA%\aipy-pro\aipy */
export function aipyDbPath() {
  const base = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Roaming") : "")
  return base ? path.join(base, "aipy-pro", "aipy") : ""
}

async function openDb(file) {
  try {
    const { Database } = await import("bun:sqlite")
    return new Database(file, { readonly: true })
  } catch {}
  try {
    const { DatabaseSync } = await import("node:sqlite")
    return new DatabaseSync(file, { readonly: true })
  } catch {}
  return null
}

function queryOne(db, sql) {
  try {
    const stmt = db.query ? db.query(sql) : db.prepare(sql)
    return stmt.get ? stmt.get() : stmt.all()[0]
  } catch {
    return null
  }
}

/** 读 meta 表的 trustoken-token：客户端的登录态 */
export async function readTrustokenToken() {
  const file = aipyDbPath()
  if (!file || !existsSync(file)) return null
  const db = await openDb(file)
  if (!db) return null
  try {
    const row = queryOne(db, "select value from meta where field = 'trustoken-token'")
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    return parsed?.access_token ? parsed : null
  } catch {
    return null
  } finally {
    try { db.close?.() } catch {}
  }
}
