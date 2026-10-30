// src/api.mjs —— Trustoken 的两层 API
//
//   模型网关   https://api.trustoken.cn/v1      OpenAI 兼容，Bearer <api_key>
//   账号 API   https://www.trustoken.cn/api     new-api，Bearer <access_token> + New-Api-User
//
// 三个约定（与脚手架一致）：
//   ① 统一出口 read()：非 2xx、success:false、坏 JSON 都在这里变成异常
//   ② 模型级错误用 404，不要 401 —— 401 会被 magpie 当成登录失效，整个账号被停
//   ③ 每个请求都带超时

import { BASE, WEB } from "./context.mjs"

export class ApiError extends Error {
  constructor(message, { status = 0, code = "", url = "" } = {}) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.url = url
  }
}

export const TIMEOUT = { short: 10_000, long: 120_000 }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) magpie-trustoken-auth/0.1.0"

export function headersFor(auth = {}) {
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": UA,
  }
  if (auth.token) h.authorization = `Bearer ${auth.token}`
  return h
}

function webHeaders(token, uid) {
  const h = headersFor({ token })
  if (uid !== undefined && uid !== null && String(uid) !== "") h["new-api-user"] = String(uid)
  return h
}

export async function read(res, url = "") {
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError(`返回的不是 JSON：${text.slice(0, 200)}`, { status: res.status, url })
  }
  if (!res.ok) {
    throw new ApiError(body?.message || body?.error?.message || `HTTP ${res.status}`, {
      status: res.status,
      code: String(body?.code ?? body?.error?.code ?? ""),
      url,
    })
  }
  if (body && body.success === false) {
    throw new ApiError(body.message || "接口返回 success:false", {
      status: res.status,
      code: String(body?.code ?? ""),
      url,
    })
  }
  return body
}

async function request(url, { method = "GET", headers, body, timeout = TIMEOUT.short } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  return read(res, url)
}

// ── 账号 API（www.trustoken.cn/api） ──────────────────────────────────

async function webGet(path, token, uid) {
  return request(`${WEB}${path}`, { headers: webHeaders(token, uid) })
}

/**
 * POST 但**不因 success:false 抛异常** —— 签到/领奖的「今天已签」「未到时间」
 * 都是 HTTP 200 + success:false，属于正常业务结果，由调用方解释。
 */
async function webPostSoft(path, token, uid, body) {
  const url = `${WEB}${path}`
  const res = await fetch(url, {
    method: "POST",
    headers: webHeaders(token, uid),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT.short),
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError(`返回的不是 JSON：${text.slice(0, 200)}`, { status: res.status, url })
  }
  if (!res.ok) {
    throw new ApiError(json?.message || `HTTP ${res.status}`, {
      status: res.status,
      code: String(json?.code ?? ""),
      url,
    })
  }
  return json
}

export async function sendSmsCode(mobile) {
  const body = await webPostSoft("/api/sms/code", "", null, { mobile })
  if (body.success === false) {
    throw new ApiError(body.message || "短信发送失败：可能触发了风控，或号码格式不对", {
      url: `${WEB}/api/sms/code`,
    })
  }
  return body
}

export async function loginMobile(phone_number, code, aff = "") {
  const body = await webPostSoft("/api/user/login/mobile", "", null, { phone_number, code, aff })
  if (body.success === false) {
    throw new ApiError(body.message || "登录失败：验证码错误或已过期", {
      url: `${WEB}/api/user/login/mobile`,
    })
  }
  return body
}

export async function registerMobile(phone_number, code, aff_code = "") {
  const body = await webPostSoft("/api/user/register/mobile", "", null, {
    phone_number,
    code,
    aff_code,
  })
  if (body.success === false) {
    throw new ApiError(body.message || "注册失败：验证码错误或邀请码无效", {
      url: `${WEB}/api/user/register/mobile`,
    })
  }
  return body
}

export async function fetchSelf(token, uid) {
  const body = await webGet("/api/user/self", token, uid)
  return body.data
}

export async function fetchTokenList(token, uid) {
  const body = await webGet("/api/token/?p=0&size=100", token, uid)
  return Array.isArray(body.data) ? body.data : (body.data?.items ?? [])
}

export async function createApiToken(token, uid, name) {
  const body = await request(`${WEB}/api/token/`, {
    method: "POST",
    headers: webHeaders(token, uid),
    body: {
      name,
      remain_quota: 0,
      expired_time: -1,
      unlimited_quota: true,
      model_limits_enabled: false,
      model_limits: "",
      allow_ips: "",
      group: "",
    },
  })
  return body.data ?? body
}

export async function checkinStatus(token, uid) {
  const body = await webGet("/api/user/checkin/status", token, uid)
  return body.data
}

/** 签到：success:false + message 是「未到窗口」等正常结果，不抛 */
export async function doCheckin(token, uid) {
  return webPostSoft("/api/user/checkin", token, uid)
}

export async function dailyTaskStatus(token, uid) {
  const body = await webGet("/api/user/daily_tasks/status", token, uid)
  return body.data?.tasks ?? []
}

export async function claimDailyTask(token, uid, task_type) {
  return webPostSoft("/api/user/daily_tasks/claim", token, uid, { task_type })
}

/** 拿一个可用的 API key：优先 status===1 的，没有就创建一把 */
export async function ensureApiKey(token, uid, name = "magpie") {
  const tokens = await fetchTokenList(token, uid)
  const live = tokens.find((t) => Number(t?.status) === 1 && t?.key)
  if (live) return live.key
  const created = await createApiToken(token, uid, `${name}-${Date.now().toString(36)}`)
  const key = created?.key ?? created?.data?.key
  if (!key) throw new ApiError("令牌列表为空，创建新令牌也没有返回 key", { url: `${WEB}/api/token/` })
  return key
}

// ── 模型网关（api.trustoken.cn/v1） ──────────────────────────────────

export async function fetchV1Models(apiKey) {
  const body = await request(`${BASE}/models`, { headers: headersFor({ token: apiKey }) })
  return Array.isArray(body?.data) ? body.data : []
}

/** 一次最小的 chat 调用（给每日任务用） */
export async function chatOnce(apiKey, { model, content, max_tokens = 16, headers = {} }) {
  const body = await request(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { ...headersFor({ token: apiKey }), ...headers },
    body: {
      model,
      messages: [{ role: "user", content }],
      max_tokens,
      stream: false,
    },
    timeout: TIMEOUT.long,
  })
  return body
}

// ── 错误语义 ─────────────────────────────────────────────────────────

export function asModelError(e, modelId = "") {
  if (!(e instanceof ApiError)) return e
  const looksLikeModel = /model|模型|not found|不存在|no access|未开通/i.test(String(e.message))
  if (looksLikeModel || e.status === 400 || e.status === 422) {
    return Object.assign(new ApiError(e.message, { status: 404, code: e.code, url: e.url }), {
      modelId,
    })
  }
  return e
}

export function asSignInExpired(message = "登录已失效") {
  return Object.assign(new Error(message), { signIn: "expired" })
}

export function isAuthFailure(e) {
  return e instanceof ApiError && (e.status === 401 || e.status === 403)
}
