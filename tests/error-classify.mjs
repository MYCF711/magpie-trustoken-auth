// tests/error-classify.mjs —— 锁死「上游 400/422 → magpie 能换号的状态码」这套翻译
//
//   node tests/error-classify.mjs
//
// 为什么这条要单独钉（实测出处见 src/status.mjs 顶部）：
//   trustoken（AiPy）的渠道坏了的时候用 400 + "bad response status code 400" 回话；
//   magpie 的 retryable() 对 400 只认 quotaWords / unservedWords / shapeWords 那几组词，
//   这句话一个都不命中 ⇒ 不换号，400 直接摔给 DSH 把会话打断（2026-10-30 01:31–01:41 实测 4 次）。
//   插件侧的修法只有一层：把 400 按语义翻译成 402 / 502 / 404 / 429。
//
//   翻译必须**只**命中该命中的那一类，且绝不能读非 400/422 的响应体（200 是 SSE 干流）。
//
// 下面每条 errorFixture 里的 message 都是本机实测原文（2026-10-30，api.trustoken.cn）。

import assert from "node:assert/strict"
import {
  classifyRefusal,
  isChannelDown,
  isModelUnserved,
  isMoneyRefusal,
  rewriteRefusal,
} from "../src/status.mjs"
import { makeLoader } from "../src/hooks/loader.mjs"

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`      ${e.message.split("\n")[0]}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`      ${e.message.split("\n")[0]}`)
  }
}

// ── 实测报文（原文照抄，只把 request id 留着当证据） ────────────────────

/** ① 主人遇到的那条：渠道自己坏了 —— 2026-10-30 01:31:42 实回 */
const CHANNEL_400 = JSON.stringify({
  error: {
    code: "bad_response_status_code",
    message:
      "bad response status code 400 (request id: 20261030013142252178529samnEl6F). " +
      "出错了！若无法解决，可加入官方群寻求帮助（ https://www.aipyaipy.com/about.html ）或者新建全新任务重试。",
    param: "400",
    type: "new_api_error",
  },
})

/** ② 真正的请求错误（temperature 类型不对）—— 实测 new-api 回这条 */
const BAD_REQUEST_400 = JSON.stringify({
  error: {
    code: "invalid_text_request",
    message:
      "json: cannot unmarshal string into Go struct field GeneralOpenAIRequest.temperature of type float64 " +
      "(request id: 202610301639027784461362StwnE4U). 出错了！若无法解决，可加入官方群寻求帮助（ " +
      "https://www.aipyaipy.com/about.html ）或者新建全新任务重试。",
    param: "",
    type: "new_api_error",
  },
})

/** ③ 真正的请求错误（messages 空） */
const EMPTY_MESSAGES_400 = JSON.stringify({
  error: {
    code: "invalid_text_request",
    message: "field messages is required (request id: 202610301639125801602531ro9WNtO). 出错了！",
    param: "",
    type: "new_api_error",
  },
})

/** ④ 限流 —— 实测 new-api 回 429（每分钟 60 次） */
const RATE_429_BODY = JSON.stringify({
  error: {
    message:
      "您已达到总请求数限制：1分钟内最多请求60次，包括失败次数，请检查您的请求是否正确 " +
      "(request id: 2026103016395391002817295AkJdD8). 出错了！",
    type: "new_api_error",
  },
})

function response(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/** 一个「读一下就会记账」的 Response —— 用来证明我们没读不该读的 body */
function countedResponse(status, body) {
  let pulls = 0
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(body))
      c.close()
    },
    pull() {
      pulls++
    },
  })
  const res = new Response(stream, { status, headers: { "content-type": "application/json" } })
  return { res, pulls: () => pulls }
}

console.log("classifyRefusal —— 纯函数判据")

check("渠道坏了（主人的那条实测报文）→ 502", () => {
  assert.equal(classifyRefusal(400, CHANNEL_400), 502)
})
check("bad_response_status_code 这个 code 也认 → 502", () => {
  assert.equal(classifyRefusal(422, '{"error":{"code":"bad_response_status_code"}}'), 502)
})
check("无可用渠道 → 502", () => {
  assert.equal(classifyRefusal(400, '{"error":{"message":"当前分组无可用渠道，请稍后再试"}}'), 502)
})
check("灵石不足 → 402", () => {
  assert.equal(classifyRefusal(400, '{"error":{"message":"您的灵石余额不足，请充值后重试"}}'), 402)
})
check("可用积分已不足 + 充值通道（超级麦吉那条同款说法）→ 402", () => {
  assert.equal(
    classifyRefusal(
      400,
      "非常抱歉，当前对话需要调用大模型 / 付费工具，您的可用积分已不足。您可以点击右上角「用户头像」，通过「充值」通道补充积分。",
    ),
    402,
  )
})
check("insufficient credits → 402", () => {
  assert.equal(classifyRefusal(400, '{"error":{"message":"Insufficient credits. Please top up."}}'), 402)
})
check("insufficient_quota → 402", () => {
  assert.equal(classifyRefusal(422, '{"error":{"code":"insufficient_quota"}}'), 402)
})
check("模型不存在 → 404", () => {
  assert.equal(classifyRefusal(400, '{"error":{"message":"模型 deepseek-flash 不存在或未开通"}}'), 404)
})
check("model does not exist → 404", () => {
  assert.equal(
    classifyRefusal(400, '{"error":{"message":"The model `gpt-x` does not exist or you do not have access to it"}}'),
    404,
  )
})
check("400 里写着「1分钟内最多请求60次」→ 429", () => {
  assert.equal(classifyRefusal(400, RATE_429_BODY), 429)
})

// ── 必须放行的（误改比不改更糟） ────────────────────────────────────────

check("真正的请求错误（temperature 类型不对）原样放行", () => {
  assert.equal(classifyRefusal(400, BAD_REQUEST_400), 0)
})
check("真正的请求错误（messages 必填）原样放行", () => {
  assert.equal(classifyRefusal(400, EMPTY_MESSAGES_400), 0)
})
check("上下文过长原样放行 —— 换号一样失败，要留给 agent 去压缩", () => {
  assert.equal(
    classifyRefusal(400, '{"error":{"message":"This model\'s maximum context length is 262144 tokens"}}'),
    0,
  )
  assert.equal(classifyRefusal(400, '{"error":{"message":"上下文长度超过模型上限"}}'), 0)
  assert.equal(
    classifyRefusal(400, '{"error":{"message":"max_tokens 超出该模型允许的额度"}}'),
    0,
    "提到 max_tokens / 额度 也不该被读成「账户没钱」",
  )
})
check("非 400/422 一律不动（408/429/401/403/404/5xx）", () => {
  for (const s of [200, 201, 401, 403, 404, 408, 413, 429, 500, 502, 503]) {
    assert.equal(classifyRefusal(s, CHANNEL_400), 0, `${s} 不该被改写`)
  }
})

check("isMoneyRefusal / isChannelDown / isModelUnserved 各认各的", () => {
  assert.equal(isMoneyRefusal("可用积分已不足"), true)
  assert.equal(isMoneyRefusal(BAD_REQUEST_400), false)
  assert.equal(isChannelDown(CHANNEL_400), true)
  assert.equal(isChannelDown(BAD_REQUEST_400), false)
  assert.equal(isModelUnserved("模型 deepseek-flash 未开通"), true)
  assert.equal(isModelUnserved(CHANNEL_400), false)
})

// ── rewriteRefusal：改哪些、保什么、不读什么 ────────────────────────────

console.log("\nrewriteRefusal —— Response 层")

await checkAsync("渠道 400 → 502，body 逐字保留，content-length/encoding 被摘掉", async () => {
  const src = response(400, CHANNEL_400, { "content-length": String(CHANNEL_400.length), "x-upstream": "x" })
  const out = await rewriteRefusal(src)
  assert.equal(out.status, 502)
  assert.equal(out.statusText, "Bad Gateway")
  assert.equal(await out.text(), CHANNEL_400)
  assert.equal(out.headers.get("content-length"), null)
  assert.equal(out.headers.get("x-upstream"), "x", "上游别的头照旧")
  assert.equal(out.headers.get("x-trustoken-vendor-status"), "400")
})

await checkAsync("钱 400 → 402；模型 400 → 404；限流 400 → 429", async () => {
  const money = await rewriteRefusal(response(400, "您的灵石余额不足，请充值"))
  assert.equal(money.status, 402)
  assert.match(await money.text(), /灵石余额不足/)
  const model = await rewriteRefusal(response(400, "模型 xxx 不存在"))
  assert.equal(model.status, 404)
  const rate = await rewriteRefusal(response(400, "请求过于频繁，每分钟最多 60 次"))
  assert.equal(rate.status, 429)
})

await checkAsync("不该改的返回**同一个 Response 对象**（没有重建、没有丢流）", async () => {
  for (const [status, body] of [
    [400, BAD_REQUEST_400],
    [429, RATE_429_BODY],
    [500, "boom"],
    [401, '{"error":{"message":"无效的令牌"}}'],
  ]) {
    const src = response(status, body)
    const out = await rewriteRefusal(src)
    assert.equal(out, src, `${status} 应原样返回同一个对象`)
  }
})

await checkAsync("判类读过一次 clone 之后，不改写的那个 Response 仍然读得到完整 body", async () => {
  const src = response(400, BAD_REQUEST_400)
  const out = await rewriteRefusal(src)
  assert.equal(out, src)
  assert.equal(await out.text(), BAD_REQUEST_400, "clone 判类不能把原来的流吃掉")
})

await checkAsync("非 400/422 的响应体一个字都不读（200 是 SSE 干流）", async () => {
  for (const status of [200, 201, 429, 500, 503]) {
    const { res, pulls } = countedResponse(status, "data: {}\n\n")
    const out = await rewriteRefusal(res)
    assert.equal(out, res)
    assert.equal(pulls(), 0, `${status} 不该被 pull`)
    await out.body.cancel()
  }
})

await checkAsync("400/422 之外连 clone 都不做 —— body 仍然可读", async () => {
  const { res } = countedResponse(200, "data: [DONE]\n\n")
  const out = await rewriteRefusal(res)
  assert.equal(out.bodyUsed, false)
  assert.equal(await out.text(), "data: [DONE]\n\n")
})

// ── loader 接线 ─────────────────────────────────────────────────────────

console.log("\nloader.fetch —— 接进插件")

const ORIG = globalThis.fetch

await checkAsync("loader 返回了 fetch，且请求原样转交（不改 body / 不改 Authorization）", async () => {
  let seen = null
  globalThis.fetch = async (input, init) => {
    seen = { input, init }
    return response(400, CHANNEL_400)
  }
  const l = await makeLoader({ PROVIDER: "trustoken" })(async () => ({ type: "api", key: "Uayl-test" }))
  assert.equal(typeof l.fetch, "function")
  const init = { method: "POST", headers: { authorization: "Bearer Uayl-test" }, body: '{"model":"deepseek-flash"}' }
  const out = await l.fetch("https://api.trustoken.cn/v1/chat/completions", init)
  assert.equal(out.status, 502)
  assert.equal(seen.input, "https://api.trustoken.cn/v1/chat/completions")
  assert.equal(seen.init, init)
  assert.equal(seen.init.headers.authorization, "Bearer Uayl-test")
  assert.equal(seen.init.body, '{"model":"deepseek-flash"}')
})

await checkAsync("上游正常时 loader.fetch 不碰响应（同一个对象出去）", async () => {
  const src = response(200, '{"ok":true}')
  globalThis.fetch = async () => src
  const l = await makeLoader({})(async () => ({ type: "oauth", apiKey: "Uayl-test" }))
  assert.equal(await l.fetch("https://api.trustoken.cn/v1/chat/completions", {}), src)
})

await checkAsync("上游抛错时原样往外抛（不吞）", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed")
  }
  const l = await makeLoader({})(async () => ({ type: "oauth", apiKey: "Uayl-test" }))
  await assert.rejects(() => l.fetch("https://api.trustoken.cn/v1/chat/completions", {}), /fetch failed/)
})

await checkAsync("未登录时 loader 不给 fetch（维持原行为）", async () => {
  const l = await makeLoader({})(async () => null)
  assert.deepEqual(l, {})
})

globalThis.fetch = ORIG

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
