// Trustoken OAuth —— 用官方登录页登录，回调到本机
//
// Trustoken 的网页和 AiPy 客户端用的是同一套 OAuth：
//   client_id     = aipy-pro
//   redirect_uri  = http://127.0.0.1:<随机端口>/oauth/callback（AiPy 用 aipy-pro://oauth）
//   PKCE S256
//   token 端点    = /api/oauth/token（form-urlencoded）
//
// 这样登录页里手机号 / 微信 / 密码三种方式都能用，滑块验证也在网页里由用户过，
// 插件不需要自己实现滑块，也不需要短信接口。
//
// 2026-10-30 起另有一条「注册」链路（见 docs/internals.md 十四）：
//   受控 Chromium（AiPy UA）→ 用户在原页面注册 → 拷 session cookie → node 补签 code → 换 token。
//   authorizeUrlFor / fetchOAuthCode / codeFromLocation / tokenExpiry 就是给那条链路用的纯函数。

import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { WEB } from "./context.mjs"

const CLIENT_ID = "aipy-pro"
const SCOPE = "all"
const CALLBACK_PATH = "/oauth/callback"
const TIMEOUT_MS = 300_000

/** AiPy 客户端用的 redirect_uri（注册流程固定用它；不是本机 http 回调） */
export const AIPY_REDIRECT_URI = "aipy-pro://oauth"

/** PKCE：verifier 32 字节 base64url（43 字符），challenge = SHA256(verifier) 的 base64url */
export function makePkce() {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

function pkce() {
  return makePkce()
}

/** 拼 /api/oauth/authorize 的地址（注册流程用 aipy-pro://oauth 回调）。
 *
 * `aff` 是邀请码：新号注册时服务端会把它记成注册来源；不传就等于没有邀请人。
 * 旧的本机回调流程 `beginOAuth` 一直带这个参数，注册流程最初漏了——补上。
 */
export function authorizeUrlFor(challenge, redirectUri = AIPY_REDIRECT_URI, aff = "") {
  const u = new URL(`${WEB}/api/oauth/authorize`)
  const params = {
    code_challenge: challenge,
    code_challenge_method: "S256",
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
    client_id: CLIENT_ID,
    lang: "zh",
  }
  if (aff) params.aff = aff
  u.search = new URLSearchParams(params).toString()
  return u.toString()
}

/** 从 302 的 Location 里取 code：`aipy-pro://oauth?code=xxx&site=cn` */
export function codeFromLocation(location) {
  const loc = String(location || "")
  if (!loc.startsWith(`${AIPY_REDIRECT_URI}?`)) {
    throw new Error(`OAuth 302 的 Location 不是 aipy-pro://oauth（实际：${loc.slice(0, 120)}）`)
  }
  const code = new URL(loc).searchParams.get("code") || ""
  if (!code) throw new Error("OAuth 302 的 Location 里没有 code")
  return code
}

/**
 * node 补签：带浏览器拷来的 session cookie + AiPy UA 重新 GET authorize，
 * redirect:"manual" 读 302 的 Location 拿 code（文档 5.1：浏览器里拦不到自定义协议）。
 */
export async function fetchOAuthCode({ challenge, sessionCookie, userAgent, redirectUri = AIPY_REDIRECT_URI }) {
  if (!sessionCookie) throw new Error("缺少 session cookie，无法补签 OAuth code")
  const res = await fetch(authorizeUrlFor(challenge, redirectUri), {
    redirect: "manual",
    headers: {
      cookie: `session=${sessionCookie}`,
      ...(userAgent ? { "user-agent": userAgent } : {}),
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status !== 302) {
    throw new Error(`补签 authorize 期望 302，实际 ${res.status}（cookie 可能已失效）`)
  }
  return codeFromLocation(res.headers.get("location") || "")
}

/** 只读一次响应体（文档坑 5.6：text() 之后再 json() 会炸） */
export async function readJsonBody(res) {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`OAuth 响应不是 JSON：${text.slice(0, 200)}`)
  }
}

/** token 响应的形状（文档第 4 节判据：access_token 存在且 expires_in ≈ 2592000） */
export const TOKEN_TTL_SECONDS = 2_592_000
export function tokenExpiry(json, now = Date.now()) {
  if (!json?.access_token) {
    throw new Error(`OAuth token 响应里没有 access_token（字段：${Object.keys(json || {}).join(", ")}）`)
  }
  const ttl = Number(json.expires_in ?? TOKEN_TTL_SECONDS)
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("OAuth token 的 expires_in 不合法")
  return {
    accessToken: String(json.access_token),
    refreshToken: String(json.refresh_token || ""),
    expiresAt: now + ttl * 1000,
    expiresIn: ttl,
  }
}

/**
 * 启动本机回调服务器并生成授权 URL。
 * 返回 { url, redirectUri, verifier, wait(), close() }。
 */
export function beginOAuth({ inviteCode = "" } = {}) {
  return new Promise((resolve, reject) => {
    const { verifier, challenge } = pkce()
    const state = randomBytes(16).toString("base64url")
    let waiter = null
    let settled = null
    let done = false
    let timer = null

    const finish = (err, code) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try {
        server.close()
      } catch {}
      if (err) {
        if (waiter) waiter.reject(err)
        else settled = { err }
      } else {
        if (waiter) waiter.resolve(code)
        else settled = { code }
      }
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1")
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
        res.end("not found")
        return
      }
      const err = url.searchParams.get("error")
      const code = url.searchParams.get("code")
      const gotState = url.searchParams.get("state")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Trustoken 登录</title>` +
          `<h2 style="font-family:sans-serif">${err ? "登录失败" : "登录完成"}</h2>` +
          `<p style="font-family:sans-serif">${err ? String(err) : "可以关闭这个窗口，回到 magpie。"}</p>`,
      )
      if (err) return finish(new Error(`OAuth 返回错误：${err}`))
      if (!code) return finish(new Error("OAuth 回调里没有 code"))
      if (gotState && gotState !== state) return finish(new Error("OAuth state 不匹配"))
      finish(null, code)
    })

    server.on("error", (e) => reject(e))
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
      const u = new URL(`${WEB}/api/oauth/authorize`)
      u.search = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        lang: "zh",
        ...(inviteCode ? { aff: inviteCode } : {}),
      }).toString()

      timer = setTimeout(() => finish(new Error("登录超时（5 分钟）")), TIMEOUT_MS)

      resolve({
        url: u.toString(),
        redirectUri,
        verifier,
        state,
        wait() {
          if (settled?.code) return Promise.resolve(settled.code)
          if (settled?.err) return Promise.reject(settled.err)
          return new Promise((res, rej) => {
            waiter = { resolve: res, reject: rej }
          })
        },
        close() {
          if (timer) clearTimeout(timer)
          try {
            server.close()
          } catch {}
        },
      })
    })
  })
}

/** 用授权码换 token（PKCE） */
export async function exchangeOAuthCode({ code, verifier, redirectUri }) {
  const body = new URLSearchParams({
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    grant_type: "authorization_code",
  })
  const res = await fetch(`${WEB}/api/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  const json = await readJsonBody(res)
  if (!res.ok) {
    throw new Error(json?.error_description || json?.error || `HTTP ${res.status}`)
  }
  if (!json?.access_token) throw new Error("OAuth token 响应里没有 access_token")
  return json
}
