// tests/remote-tasks.test.mjs —— 纯 API 补每日任务的请求形态锁（0.4.0）
//
// 2026-11-04 抓包 + 对照实验：只有「完整任务形态」的请求才计数。
// 简化头（exp11）、简化 body（exp10/exp12）、只带 Aipy-Task-ID（旧 filler）全部不计；
// 100% 重放才计入并可领奖。所以这些字段一个都不许「优化」掉。

import test from "node:test"
import assert from "node:assert/strict"
import { remoteTaskId, remoteTaskHeaders, runRemoteTask, TASK_INTERVAL_MS } from "../src/aipy-remote.mjs"
import { buildMessages, SYSTEM_PROMPT } from "../src/aipy-task-template.mjs"

test("① remoteTaskId：21 位、与 AiPy 客户端同构", () => {
  const id = remoteTaskId()
  assert.equal(id.length, 21)
  assert.match(id, /^[A-Za-z0-9]+$/)
  assert.notEqual(remoteTaskId(), remoteTaskId())
})

test("② remoteTaskHeaders：SDK 头组 + 两种任务头齐全且 id 一致", () => {
  const h = remoteTaskHeaders("sk-test", "abc123")
  assert.equal(h.authorization, "Bearer sk-test")
  assert.equal(h["user-agent"], "OpenAI/Python 2.38.0")
  assert.equal(h["x-stainless-lang"], "python")
  assert.equal(h["aipy-task-id"], "abc123/0.5.0")
  assert.equal(h["aipy-task-depth"], "0")
  assert.equal(h["x-aipy-task-id"], "abc123", "x-aipy-task-id 是不带版本号的纯 id（服务端计数的关键）")
  assert.equal(h["x-aipy-task-type"], "manual")
})

test("③ buildMessages：占位符全部替换，system 原样保留", () => {
  const [s, u] = buildMessages({ instruction: "只回复 OK", workdir: "D:\\work\\x", today: "2026-11-04" })
  assert.equal(s.role, "system")
  assert.equal(s.content, SYSTEM_PROMPT)
  assert.ok(SYSTEM_PROMPT.length > 30000, "完整任务 prompt 不许裁短（简化 body 不计数）")
  assert.ok(u.content.includes("只回复 OK"))
  assert.ok(u.content.includes("2026-11-04"))
  assert.ok(u.content.includes("D:\\work\\x"))
  assert.ok(!u.content.includes("{{INSTRUCTION}}") && !u.content.includes("{{WORKDIR}}") && !u.content.includes("{{TODAY}}"))
})

test("④ runRemoteTask：完整 body + 流必须读完", async () => {
  let seenUrl, seenInit, readDone = false
  const fake = async (url, init) => {
    seenUrl = url
    seenInit = init
    return {
      ok: true,
      status: 200,
      text: async () => { readDone = true; return "data: [DONE]\n" },
    }
  }
  const r = await runRemoteTask({ apiKey: "sk-test", model: "qwen3.8-flash", fetchImpl: fake })
  assert.equal(r.ok, true)
  assert.equal(readDone, true, "响应流必须读完（服务端按流式结算计数）")
  assert.ok(seenUrl.endsWith("/chat/completions"))
  const body = JSON.parse(seenInit.body)
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.max_tokens, 8192)
  assert.equal(body.temperature, 0.6)
  assert.equal(body.tools, null)
  assert.equal(body.model, "qwen3.8-flash")
  assert.equal(body.messages.length, 2)
  const h = seenInit.headers
  const tid = h["x-aipy-task-id"]
  assert.equal(h["aipy-task-id"], `${tid}/0.5.0`)
  assert.equal(r.tid, tid)
})

test("⑤ 间隔常量：任务间隔不得小于 30 秒（过密漏计）", () => {
  assert.ok(TASK_INTERVAL_MS >= 30_000)
})

test("⑥ 模板脱敏：不含本机用户名 / 手机号", () => {
  assert.ok(!SYSTEM_PROMPT.includes("Administrator"), "system 模板必须脱敏")
})
