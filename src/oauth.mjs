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

import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { WEB } from "./context.mjs"

const CLIENT_ID = "aipy-pro"
const SCOPE = "all"
const CALLBACK_PATH = "/oauth/callback"
const TIMEOUT_MS = 300_000

function pkce() {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
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
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`OAuth token 接口返回的不是 JSON：${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    throw new Error(json?.error_description || json?.error || `HTTP ${res.status}`)
  }
  if (!json?.access_token) throw new Error("OAuth token 响应里没有 access_token")
  return json
}
