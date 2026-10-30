#!/usr/bin/env node
// 每日任务：看进度 + 领取已经到手的奖励
//
// 用法：
//   node scripts/aipy-daily.mjs            看进度，并把服务端标成 claimable 的奖励领掉
//   node scripts/aipy-daily.mjs --dry-run  只看进度，什么都不动
//
// ⚠ 这个脚本**不创建任务、不刷进度**。
//   trustoken 的「AI 任务」= AiPy Pro 里一个任务（会话），只有用户在客户端里真的干活，
//   progress 才会涨。旧版本用最低价模型在 AiPy 里批量建任务把进度刷上去 —— 社区 review
//   指出那是「farms a vendor's promotion on the user's account」，已删除（连同
//   src/aipy-local.mjs 里的本机任务接口）。

import { readTrustokenToken, aipyDbPath } from "../src/aipy-local.mjs"

const BASE = "https://www.trustoken.cn"

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

/** uid 从 AiPy 的 meta.trustoken-profile 读；读不到就让服务端按 token 解析 */
async function readUid(db) {
  try {
    const { Database } = await import("bun:sqlite")
    const d = new Database(db, { readonly: true })
    try {
      const row = d.query("select value from meta where field = 'trustoken-profile'").get()
      return row?.value ? String(JSON.parse(row.value).id || "") : ""
    } finally {
      d.close?.()
    }
  } catch {
    return ""
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  const db = aipyDbPath()
  if (!db) throw new Error("找不到 %APPDATA%")

  const tok = await readTrustokenToken()
  if (!tok?.access_token) throw new Error("读不到 trustoken-token，先在 AiPy 客户端登录一次")
  const uid = await readUid(db)

  const st = await api("/api/user/daily_tasks/status", tok.access_token, uid)
  const tasks = st?.data?.tasks || []
  if (!tasks.length) {
    console.log("服务端没返回每日任务")
    return
  }
  for (const t of tasks) {
    console.log(`${t.title || t.task_type}：${Number(t.progress)}/${Number(t.target)}（${t.status}）`)
  }

  const claimable = tasks.filter((t) => t.status === "claimable")
  if (!claimable.length) {
    console.log("没有可领取的奖励；进度要在 AiPy Pro 客户端里干活才会涨。")
    return
  }
  if (dryRun) {
    console.log(`可领取 ${claimable.length} 项（--dry-run，未领取）`)
    return
  }
  for (const t of claimable) {
    try {
      const r = await api("/api/user/daily_tasks/claim", tok.access_token, uid, "POST", { task_type: t.task_type })
      console.log(`领取 ${t.title || t.task_type}:`, JSON.stringify(r?.data ?? r))
    } catch (e) {
      console.error(`领取 ${t.task_type} 失败:`, String(e?.message ?? e))
    }
  }
}

main().catch((e) => {
  console.error("失败:", e?.message || e)
  process.exit(1)
})
