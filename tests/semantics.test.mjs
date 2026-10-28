// tests/semantics.test.mjs —— 锁住这个插件里「形状对、语义错」的那几处
//
// 跑法：node --test

import test from "node:test"
import assert from "node:assert/strict"

import { buildModels, mergeModels, isUsable, visionOf, contextOf } from "../src/models.mjs"
import { rateOf, CHEAPEST_MODEL, quotaToStones } from "../src/rates.mjs"
import { ApiError, read, asModelError } from "../src/api.mjs"
import { withUsage, singleShotToSSE, normalizeUsage } from "../src/chat.mjs"
import { usage, usageWindow, QuotaShapeError } from "../src/quota.mjs"
import { makeLoader } from "../src/hooks/loader.mjs"

// ── 倍率 ──────────────────────────────────────────────────────────────

test("rate: qwen3.8-flash 是最低消费模型（实测值）", () => {
  assert.equal(CHEAPEST_MODEL, "qwen3.8-flash")
  assert.equal(rateOf("qwen3.8-flash").input, 0.7471)
  assert.equal(rateOf("qwen3.8-flash").output, 2.2538)
})

test("rate: 未知模型回退到 0.75 / 3.0", () => {
  assert.deepEqual(rateOf("no-such-model"), { input: 0.75, output: 3.0 })
})

test("rate: quota → 灵石 = /5000", () => {
  assert.equal(quotaToStones(500_000), 100)
  assert.equal(quotaToStones(250_000), 50)
})

// ── 模型目录 ──────────────────────────────────────────────────────────

test("models: 过滤 embedding / 生图 / VIP", () => {
  assert.equal(isUsable({ id: "text-embedding-3" }), false)
  assert.equal(isUsable({ id: "qwen-image-plus" }), false)
  assert.equal(isUsable({ id: "gpt-x", tags: [{ value: "vip" }] }), false)
  assert.equal(isUsable({ id: "deepseek-flash" }), true)
  assert.equal(isUsable({}), false)
})

test("models: 图片能力只认 modalities.input 的 image", () => {
  assert.equal(visionOf({ id: "qwen3.8-flash", features: { modalities: { input: ["text", "image"] } } }), true)
  assert.equal(visionOf({ id: "deepseek-flash", features: { modalities: { input: ["text"] } } }), false)
  assert.equal(visionOf({ id: "deepseek-flash" }), false)
  assert.equal(visionOf({ id: "kimi/kimi-k3" }), true)
})

test("models: 1000 亿的占位 context 被截到静态值", () => {
  assert.equal(contextOf({ id: "deepseek-flash", features: { limit: { context: 100_000_000_000 } } }), 1_000_000)
  assert.equal(contextOf({ id: "hy3", features: { limit: { context: 0 } } }), 256_000)
})

test("models: mergeModels 保留 13 个静态模型，并合并动态模型", () => {
  const out = mergeModels([{ id: "deepseek-flash", features: { limit: { context: 1_000_000 } } }])
  assert.equal(Object.keys(out).length, 13)
  assert.equal(out["deepseek-flash"].name, "DeepSeek V4.1 Flash")
  assert.equal(out["qwen3.8-flash"].capabilities.input.image, true)
  assert.equal(out["deepseek-flash"].capabilities.input.image, false)
})

test("models: 静态表每个模型都显式声明 input.image 布尔值", () => {
  for (const [id, m] of Object.entries(mergeModels([]))) {
    assert.equal(typeof m.capabilities.input.image, "boolean", `${id} 缺 input.image`)
  }
})

test("models: buildModels 跳过不可用条目", () => {
  const out = buildModels([{ id: "text-embedding-3" }, { id: "deepseek-flash" }])
  assert.deepEqual(Object.keys(out), ["deepseek-flash"])
})

// ── 错误语义 ──────────────────────────────────────────────────────────

test("api: 200 + success:false 也会抛", async () => {
  const res = new Response(JSON.stringify({ success: false, message: "未到签到时间" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
  await assert.rejects(() => read(res, "https://example/api"), ApiError)
})

test("api: 模型级 400 被翻译成 404（不打死账号）", () => {
  const e = asModelError(new ApiError("model not found", { status: 400 }), "deepseek-flash")
  assert.equal(e.status, 404)
  assert.equal(e.modelId, "deepseek-flash")
})

test("api: 401 不被改写 —— 那确实是登录失效", () => {
  assert.equal(asModelError(new ApiError("unauthorized", { status: 401 })).status, 401)
})

test("api: read 把非 JSON 也变成异常", async () => {
  const res = new Response("<html>502</html>", { status: 200 })
  await assert.rejects(() => read(res), /不是 JSON/)
})

// ── 流式三坑（chat.mjs 沿用脚手架实现） ─────────────────────────────

test("chat: withUsage 给流式请求补 include_usage", () => {
  assert.deepEqual(withUsage({ stream: true, model: "m" }).stream_options, { include_usage: true })
  assert.equal(withUsage({ stream: false, model: "m" }).stream_options, undefined)
})

test("chat: singleShotToSSE 以 [DONE] 收尾", async () => {
  const res = singleShotToSSE({ model: "m", text: "你好", usage: { prompt: 3, completion: 4, total: 7 } })
  const text = await res.text()
  assert.ok(text.trim().endsWith("data: [DONE]"))
})

test("chat: normalizeUsage 兼容两套字段名", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 1, completion_tokens: 2 }), { prompt: 1, completion: 2, total: 3 })
  assert.deepEqual(normalizeUsage({ input_tokens: 5, output_tokens: 6 }), { prompt: 5, completion: 6, total: 11 })
  assert.equal(normalizeUsage(null), null)
})

// ── 额度窗口 ──────────────────────────────────────────────────────────

test("quota: 钱包型窗口可以只给 balance", () => {
  const w = usageWindow({ name: "灵石", balance: 1234, unit: "灵石" })
  assert.equal(w.balance, 1234)
  assert.equal(w.used, undefined)
})

test("quota: 钱包型再给 used 会抛", () => {
  assert.throws(() => usageWindow({ name: "灵石", balance: 1, used: 10 }), QuotaShapeError)
})

test("quota: 数量型漏 used 会抛", () => {
  assert.throws(() => usageWindow({ name: "额度", limit: 100 }), QuotaShapeError)
})

test("quota: usage() 逐个过一遍窗口", () => {
  const u = usage({ plan: "灵石制", windows: [{ name: "灵石", balance: 100, unit: "灵石" }] })
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].balance, 100)
})

// ── loader ────────────────────────────────────────────────────────────

test("loader: oauth 用 apiKey，api 类型用 key", async () => {
  const l = makeLoader({ PROVIDER: "trustoken" })
  assert.equal((await l(async () => ({ type: "oauth", apiKey: "Uayl-test" }))).apiKey, "Uayl-test")
  assert.equal((await l(async () => ({ type: "api", key: "Uayl-key" }))).apiKey, "Uayl-key")
  assert.deepEqual(await l(async () => null), {})
})
