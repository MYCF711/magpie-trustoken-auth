// src/status.mjs —— 把上游的错误状态码翻译成 magpie 能听懂的状态码
//
// 为什么要有这一层（本机实测证据，2026-10-30）
//
// ① 上游确实回 400，而且这一轮就此结束（DSH 会话被打断）：
//    `~/.config/magpie/routing/2026-10-30.jsonl`：
//      {"id":"trustoken@181****6710","model":"deepseek-flash","effort":"max",
//       "done":true,"status":400,"ms":783,"fail":"other",
//       "error":"Trustoken（AiPy）: bad response status code 400 (request id:
//                20261030013142252178529samnEl6F). 出错了！若无法解决，可加入官方群寻求帮助（
//                https://www.aipyaipy.com/about.html ）或者新建全新任务重试。"}
//    DSH 侧看到的是 turn 直接以错误收尾：
//      D:\DeepSeek Harness\home\sessions\--D-~4E3B~5DE5~4F5C~533A--→
//      ffe0fdab-4099-49f9-8b1b-37e299f6486d\session.v4.jsonl.zstd：
//      {"type":"turn/end","data":{"turn":1,"reason":{"kind":"error","error":{
//        "message":"400: {\"code\":\"bad_response_status_code\",\"message\":\"Trustoken（AiPy）:
//        bad response status code 400 …\",\"code\":\"INVALID_REQUEST\"}}}}}
//    当天该账号这一路 **589 次 200、4 次 400**，4 次全在 01:31–01:41（高并发时段）。
//
// ② 插件这条路原本没有任何改写机会：`src/hooks/loader.mjs` 只给
//    `baseURL + apiKey + headers`，上游的 400 原样直传 magpie ⇒ 只能在 loader 里补一个 fetch。
//
// ③ magpie 为什么不换号（源码：本机 checkout `projects/magpie`，`v0.1.1775`；
//    本机装入版 `0.1.2145`）：
//      internal/gateway/fallback.go  retryable(status, body)：
//        case 401, 402, 403, 404, 408, 429, status >= 500 → true
//        case 400, 422 → 只有命中 quotaWords / unservedWords / refusedWords /
//                        shapeWords / unsaidWords / regionWords / wrongEndpoint 才算可重试
//      internal/gateway/gateway.go   只有 `!last && hw.failed()`（fail 即 retryable）才换下一个候选；
//                                    `holdWriter.failed()`（fallback.go）就是 `retryable(hw.code(), …)`
//      「bad response status code 400」一个词都不命中 ⇒ 既不换号也不 rest，直接把 400 抛给客户端。
//
// 所以这里只做**翻译**，不改语义：
//
//   钱不够（灵石 / 积分 / 点数 / 余额 / 额度 / 欠费 / 充值 / insufficient balance …）
//     → 402 Payment Required
//       magpie：retryable 无条件 true，`failure()` 落 failCredit ⇒ 把这个号按「没钱」休息 30 分钟，
//       去问同 provider 的下一个账号或组里的下一个成员。钱确实没了，换号才有意义。
//
//   上游渠道自己坏了（new-api 的 `bad response status code` / 无可用渠道 / 上游错误）
//     → 502 Bad Gateway
//       magpie：retryable 无条件 true（status >= 500），`failure()` 落 failOther
//       ⇒ 换号重试，而这个号只进 1 分钟起步的 backoff，**不会**被冤枉成欠费或限流。
//       这一档正是主人这次遇到的 400（`bad response status code`）。
//
//   模型这一路不服务（模型不存在 / 未开通 / 无权使用）
//     → 404。**绝不写 401** —— 401 会被 magpie 当登录失效，整个账号被停（本仓库 AGENTS 坑 6）。
//
//   限流（400/422 里明说 per-minute / too many requests 的）
//     → 429。magpie：retryable true，`failure()` 落 failRate ⇒ 按限流休息、退到队尾，而不是休息 30 分钟。
//
//   其它 400/422 → 原样放行。真正的请求格式错误（`invalid_text_request`、schema 不合法、
//   上下文过长）换号也没用，让 magpie 到处换号只会浪费别的账号。
//
// ⚠ 三条不能碰的（都实测过）：
//   · 只读 400/422 的响应体。其它状态码一律不读 —— 200 是 SSE 干流，读一下就废了。
//   · 429 / 408 / 401 / 403 / 404 / 5xx 不动：它们本来就按各自语义可重试。
//   · 上下文过长（`context_length_exceeded` / 提示词太长 / 上下文超长）不动：
//     magpie 要把它当作「这个请求太长」告诉 agent 去压缩上下文；当成渠道错误去换号只会
//     在别的账号上同样失败，还把「该压缩」的信号弄丢。

/** 一行判据：这条文案是不是「账户没钱了」（而不是请求本身有问题） */
const MONEY =
  /(?:灵石|积分|点数|余额|额度|配额|钱包)[^。．!！\n]{0,10}(?:不足|用尽|耗尽|不够|已用完|为零|为 ?0)|(?:不足|用尽|耗尽|不够)[^。．!！\n]{0,6}(?:灵石|积分|点数|余额|额度)|欠费|请充值|需要充值|充值通道|充值后|insufficient\s+(?:credit|credits|balance|funds?|points?|quota)|(?:credit|credits|balance|funds?|points?|quota)\s+(?:is\s+|are\s+)?(?:insufficient|exhausted|empty|zero|too\s+low)|out\s+of\s+(?:credits?|funds?|points?|balance|quota)|no\s+(?:credits?|balance|quota)(?:\s+(?:left|remaining))?|insufficient_quota|exceeded\s+your\s+current\s+quota/i

/**
 * 上游渠道自己坏了 —— new-api 读到渠道回非 200 时用它自己的话回一条，
 * 真正的错在渠道那边，换一个账号（另一个渠道）大概率就好了。
 */
const CHANNEL_DOWN =
  /bad[_ ]response[_ ]status[_ ]code|bad\s+response\s+status\s+code|no\s+available\s+channels?|无可用渠道|所有渠道|上游(?:服务)?(?:错误|异常|不可用|失败|超时)|网关(?:错误|异常)|upstream\s+(?:error|failure|unavailable|timeout)/i

/** 模型这一路不服务（不是登录失效） */
const MODEL_UNSERVED =
  /(?:模型|该模型|此模型)[^。．!！\n]{0,60}(?:不存在|不支持|不可用|无权|未开通|未授权|已下线|已停用)|(?:no such|unknown|invalid|unsupported)\s+model|model[^。\n]{0,80}(?:not\s+(?:supported|accessible|available|found|enabled|allowed|permitted|exist)|does\s?n[o']?t\s+exist)|model_not_found|not\s+(?:authorized|permitted)\s+to\s+(?:use|access)\s+(?:this\s+)?model/i

/** 限流：只有自己说了「每分钟/每秒」或英文 rate limit / too many requests 才认 */
const RATE_LIMIT = /每分钟|每秒|一分钟内|频率限制|请求(?:数|频率)限制|rate.?limit|too many requests|per\s+(?:second|sec|minute|min)\b|\b[rt]p[ms]\b|throttl/i

/** 上下文过长 —— 换号一样失败，必须留给 magpie 当「该压缩上下文」处理 */
const TOO_LONG =
  /max_tokens|max_output_tokens|max_completion_tokens|context[_ ](?:length|window|limit)|prompt\s+is\s+too\s+long|input\s+is\s+too\s+long|maximum\s+context|too\s+many\s+(?:input\s+|prompt\s+)?tokens|token\s+limit\s+exceeded|reduce\s+the\s+length\s+of\s+the\s+messages|上下文(?:长度)?(?:超|过长)|超(?:过|出)(?:了)?(?:模型)?(?:的)?(?:最大)?上下文/i

/** 这条错误文案是不是「账户没钱了」（而不是请求本身有问题） */
export function isMoneyRefusal(text) {
  return MONEY.test(String(text ?? ""))
}

/** 这条错误文案是不是「上游渠道自己坏了」 */
export function isChannelDown(text) {
  return CHANNEL_DOWN.test(String(text ?? ""))
}

/** 这条错误文案是不是「模型这一路不服务」 */
export function isModelUnserved(text) {
  return MODEL_UNSERVED.test(String(text ?? ""))
}

/**
 * 上游状态码 + 响应体 → 该改成哪个状态码（0 = 原样放行）。
 *
 * 纯函数，测试直接钉它；`rewriteRefusal` 拿它做实际的 Response 改写。
 *
 * @param {number} status 上游状态码
 * @param {string} text   响应体原文（**只在 400/422 时才有**）
 * @returns {0|402|404|429|502}
 */
export function classifyRefusal(status, text) {
  if (status !== 400 && status !== 422) return 0
  const t = String(text ?? "")
  if (!t) return 0
  // 顺序即优先级：上下文过长先出局（它可能同时提到 max_tokens / 额度），
  // 然后是钱（渠道错误里若混着厂商的「余额不足」，那是真没钱），再是渠道、模型、限流。
  if (TOO_LONG.test(t)) return 0
  if (MONEY.test(t)) return 402
  if (CHANNEL_DOWN.test(t)) return 502
  if (MODEL_UNSERVED.test(t)) return 404
  if (RATE_LIMIT.test(t)) return 429
  return 0
}

const REASON = {
  402: "Payment Required",
  404: "Not Found",
  429: "Too Many Requests",
  502: "Bad Gateway",
}

/**
 * 拦截上游响应：只把 400/422 里的「钱 / 渠道 / 模型 / 限流」翻译成 magpie 认的状态码，
 * 其余响应（含所有 2xx 流式响应）**原对象**返回 —— 绝不读干流。
 *
 * 用法就是 loader 的 `fetch` 包装；也可以直接拿去测。
 *
 * @param {Response} res
 * @returns {Promise<Response>}
 */
export async function rewriteRefusal(res) {
  const status = res?.status
  if (status !== 400 && status !== 422) return res
  let text
  try {
    // 只读 400/422 的错误响应体（很小）。clone 之后再读，原 Response 便仍可用，
    // 不改写时就把它原样交回去 —— 与 magicrew 的 rewriteCreditRefusal 同一手法。
    text = await res.clone().text()
  } catch {
    return res
  }
  const mapped = classifyRefusal(status, text)
  if (!mapped) return res
  const headers = new Headers(res.headers)
  // body 已由 undici 解压，原 content-encoding / content-length 不再成立
  headers.delete("content-length")
  headers.delete("content-encoding")
  // 排障用：上游原本是几，为什么会走到这一步（magpie 会把响应头透给客户端）
  headers.set("x-trustoken-vendor-status", String(status))
  return new Response(text, {
    status: mapped,
    statusText: REASON[mapped] ?? "",
    headers,
  })
}
