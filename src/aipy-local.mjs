// AiPy Pro 本机任务接口 —— 每日「AI 任务」只有走这里才算数
//
// 2026-10-29 实测：
//   · `POST http://127.0.0.1:<AiPy 端口>/api/aipy/createTask`（body 是参数数组）
//   · `{force:true, title, instruction, model}` → 新建一个任务（会话）并执行
//   · 每执行一个任务，trustoken 的 daily_ai_5 progress +1（3 → 4 → 5 实测）
//   · 用 aipyapp 的 Python API 直接跑任务不算 —— 必须是 AiPy Pro 客户端创建的任务
//
// 这里只做三件事：找端口、读 key、创建任务。找不到就安静地返回 null，让调用方降级。

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

const isWin = process.platform === "win32"

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

/** 读 setting(category='api', field='key') —— 这是 AiPy 本地 HTTP API 的 Bearer key */
export async function readAipyApiKey() {
  const file = aipyDbPath()
  if (!file || !existsSync(file)) return null
  const db = await openDb(file)
  if (!db) return null
  try {
    const row = queryOne(db, "select value from setting where category = 'api' and field = 'key'")
    return row?.value || null
  } finally {
    try { db.close?.() } catch {}
  }
}

/** 读 meta 表的 trustoken-token（AI 任务状态查询用，可选） */
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

/** 找 AiPyPro.exe 在 127.0.0.1 上监听的 API 端口（Windows） */
export async function findAipyPort(apiKey) {
  if (!isWin) return null
  try {
    const tasks = execSync('tasklist /FI "IMAGENAME eq AiPyPro.exe" /FO CSV /NH', {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    })
    const pids = new Set()
    for (const line of tasks.split(/\r?\n/)) {
      const m = line.match(/"AiPyPro\.exe","(\d+)"/i)
      if (m) pids.add(m[1])
    }
    if (!pids.size) return null

    const net = execSync("netstat -ano -p tcp", { encoding: "utf8", windowsHide: true, timeout: 5000 })
    const ports = []
    for (const line of net.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
      if (m && pids.has(m[2])) ports.push(Number(m[1]))
    }

    // AiPy 同时开多个本地服务（character / sandbox / …）。
    // 真正的任务 API 是 qN server：带正确 key 访问 / 会回 "Greetings from AiPy Pro x.y.z!"。
    for (const port of ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(1500),
        })
        const text = await res.text()
        if (/Greetings from AiPy/i.test(text)) return port
      } catch {}
    }
    return null
  } catch {
    return null
  }
}

/** 调 AiPy 本地 API：POST /api/aipy/createTask，body 是参数数组 */
export async function createAipyTask({ port, apiKey, title, instruction, model }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/aipy/createTask`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify([{ force: true, title, instruction, model }]),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`AiPy 本地接口返回的不是 JSON：${text.slice(0, 200)}`)
  }
  if (!res.ok || body?.error) throw new Error(body?.error || `HTTP ${res.status}`)
  return body?.data
}

/**
 * 创建 n 个 AiPy 任务（会话）。返回实际创建数与原因。
 * 任一环节缺失（没装 / 没运行 / 没 key）都返回 created: 0，不抛。
 */
export async function ensureAipyTasks({ n, model = "qwen3.8-flash", title = "每日任务", instruction = "只回复 OK 两个字，不要做别的事" }) {
  if (!n || n <= 0) return { created: 0, reason: "不需要创建" }
  if (!isWin) return { created: 0, reason: "非 Windows，跳过本机 AiPy 任务" }

  const apiKey = await readAipyApiKey()
  if (!apiKey) return { created: 0, reason: "没读到 AiPy 本地 API key（AiPy 未首次启动？）" }

  const port = await findAipyPort(apiKey)
  if (!port) return { created: 0, reason: "没找到 AiPyPro.exe 的任务 API 端口（AiPy 没在运行？）" }

  let created = 0
  const ids = []
  for (let i = 0; i < n; i++) {
    try {
      const id = await createAipyTask({
        port,
        apiKey,
        title: `${title} ${i + 1}`,
        instruction,
        model,
      })
      if (id) {
        created++
        ids.push(id)
      }
    } catch (e) {
      return { created, ids, port, reason: String(e?.message ?? e).slice(0, 200) }
    }
  }
  return { created, ids, port, reason: null }
}
