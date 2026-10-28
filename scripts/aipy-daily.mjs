#!/usr/bin/env node
// 每日任务一键脚本 —— 用最低消费模型（qwen3.8-flash）在 AiPy Pro 里建任务（会话）
//
// 用法：
//   node scripts/aipy-daily.mjs
//   node scripts/aipy-daily.mjs --dry-run   只看当前进度，不创建任务
//
// 依赖：AiPy Pro 正在运行（Windows），本机有 %APPDATA%\aipy-pro\aipy。
// 原理：trustoken 的 daily_ai_5「完成 5 次 AI 任务」= AiPy Pro 里 5 个任务（会话）。
// 实测 2026-10-29：每创建并执行一个任务，progress +1（3→4→5）。

import { dailyTaskStatus, claimDailyTask } from "../src/api.mjs"
import { ensureAipyTasks, readTrustokenToken, aipyDbPath } from "../src/aipy-local.mjs"

const BASE = "https://www.trustoken.cn"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CHEAPEST = "qwen3.8-flash"

function log(...args) {
  console.log(...args)
}

async function api(path, token, uid, method = "GET", body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(uid ? { "new-api-user": String(uid) } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`)
  return json
}

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  const db = aipyDbPath()
  if (!db) throw new Error("找不到 %APPDATA%")
  log(`AiPy DB: ${db}`)

  const tok = await readTrustokenToken()
  if (!tok?.access_token) throw new Error("读不到 trustoken-token，先在 AiPy 登录一次")

  // uid 从 profile 读；读不到就让服务端按 token 解析
  let uid = ""
  try {
    const { readTrustokenToken: _r } = await import("../src/aipy-local.mjs")
    // profile 存在 meta.trustoken-profile
    const { Database } = await import("bun:sqlite").catch(() => ({}))
    if (Database) {
      const d = new Database(db, { readonly: true })
      const row = d.query("select value from meta where field = 'trustoken-profile'").get()
      if (row?.value) uid = String(JSON.parse(row.value).id || "")
      d.close()
    }
  } catch {}

  const before = await api("/api/user/daily_tasks/status", tok.access_token, uid)
  const tasks = before?.data?.tasks || []
  log("当前进度:", tasks.map((t) => `${t.task_type} ${t.progress}/${t.target} (${t.status})`).join(" | "))

  const gaps = tasks.filter((t) => t.status === "in_progress" && Number(t.progress) < Number(t.target))
  if (!gaps.length) {
    log("没有需要补的任务")
    return
  }
  const need = Math.max(...gaps.map((t) => Number(t.target) - Number(t.progress)))
  log(`需要补 ${need} 个任务（模型 ${CHEAPEST}）`)
  if (dryRun) return

  const r = await ensureAipyTasks({ n: need, model: CHEAPEST })
  log("创建结果:", JSON.stringify(r))
  if (!r.created) throw new Error(`创建失败：${r.reason}`)

  for (let i = 0; i < 20; i++) {
    await sleep(3000)
    const now = await api("/api/user/daily_tasks/status", tok.access_token, uid)
    const cur = now?.data?.tasks || []
    const open = cur.filter((t) => t.status === "in_progress" && Number(t.progress) < Number(t.target))
    if (!open.length) {
      log("进度已结算:", cur.map((t) => `${t.task_type} ${t.progress}/${t.target}`).join(" | "))
      break
    }
  }

  const after = await api("/api/user/daily_tasks/status", tok.access_token, uid)
  for (const t of after?.data?.tasks || []) {
    if (t.status !== "claimable") continue
    const claim = await api("/api/user/daily_tasks/claim", tok.access_token, uid, "POST", { task_type: t.task_type })
    log(`领取 ${t.task_type}:`, JSON.stringify(claim))
  }
}

main().catch((e) => {
  console.error("失败:", e?.message || e)
  process.exit(1)
})
