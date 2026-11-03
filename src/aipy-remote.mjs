// 纯 API 推进 trustoken「每日 AI 任务」—— 不依赖 AiPro 客户端（0.4.0）
//
// 2026-11-04 抓包 + 对照实验结论：
//   · 真实任务请求 = OpenAI/Python SDK 头组 + aipy-task-id/depth + **x-aipy-task-id / x-aipy-task-type**
//     + 完整任务 prompt（system 约 3.5 万字符）+ stream + stream_options.include_usage。
//   · 只带 Aipy-Task-ID（旧降级路径）、只带 x-aipy-task-id、简化 body、简化头 —— 全部不计数；
//     100% 重放才计数。所以这里**原样保留全部要素，不做「优化」**。
//   · 计数有结算节奏：10 秒间隔连发会漏计，35–40 秒间隔稳定每次 +1。
//   · 实测：189****8051 从 locked 0/5 补到 5/5，daily_ai_1 / daily_ai_5 奖励均成功领取。

import { randomBytes } from "node:crypto"
import { buildMessages } from "./aipy-task-template.mjs"

export const REMOTE_TASK_BASE = "https://api.trustoken.cn/v1"
/** 任务之间的最小间隔：过密会被结算漏掉（实测 40s 稳定，35s 留一点余量） */
export const TASK_INTERVAL_MS = 35_000

/** 与 AiPy 客户端同构的 21 位任务 id */
export function remoteTaskId() {
  return randomBytes(16).toString("base64url").replace(/[-_]/g, "x").slice(0, 21)
}

/** 完整请求头：SDK 标识 + 任务标识，缺一不可（对照实验：去掉 SDK 头组即不计数） */
export function remoteTaskHeaders(apiKey, tid) {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "OpenAI/Python 2.38.0",
    "x-stainless-lang": "python",
    "x-stainless-package-version": "2.38.0",
    "x-stainless-os": "Windows",
    "x-stainless-arch": "other:amd64",
    "x-stainless-runtime": "CPython",
    "x-stainless-runtime-version": "3.12.12",
    "x-stainless-async": "false",
    "x-stainless-retry-count": "0",
    "aipy-task-depth": "0",
    "aipy-task-id": `${tid}/0.5.0`,
    "x-aipy-task-id": tid,
    "x-aipy-task-type": "manual",
  }
}

/**
 * 以完整任务形态发一次请求（= 一个「AI 任务」）。
 * 返回 { ok, status, tid }；不抛网络异常以外的错（HTTP 非 200 也算 ok:false 返回）。
 */
export async function runRemoteTask({
  apiKey,
  model,
  instruction = "只回复 OK 两个字，不要做别的事",
  workdir = `${process.env.USERPROFILE || "C:\\Users\\user"}\\aipywork\\remote`,
  today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10),
  base = REMOTE_TASK_BASE,
  fetchImpl = fetch,
}) {
  const tid = remoteTaskId()
  const body = {
    model,
    messages: buildMessages({ instruction, workdir, today }),
    max_tokens: 8192,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.6,
    tools: null,
  }
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: remoteTaskHeaders(apiKey, tid),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  // 流必须读完：服务端按流式结算（include_usage）计数，提前断开可能不计
  const text = await res.text()
  return { ok: res.ok, status: res.status, tid, tail: text.slice(-200) }
}
