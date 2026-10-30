// tests/register-flow.test.mjs —— 弹窗注册链路的四个判据（文档第 4 节）
//
//   node --test
//
// 依据：E:\Downloads\aipy-register-flow.md（2026-10-30 e2e 实测）
//   · verifier 长度 43（32 字节 base64url），challenge = SHA256(verifier) base64url
//   · 浏览器窗口必须带 AiPy UA（服务端只认 `aipy-pro/*`）
//   · cookie 名 `session`（trustoken 域）非空
//   · 302 Location 以 `aipy-pro://oauth?code=` 开头
//   · access_token 存在且 expires_in ≈ 2592000
// 这一组只测纯函数，不起浏览器、不注册、不发短信。

import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  makePkce,
  authorizeUrlFor,
  codeFromLocation,
  tokenExpiry,
  readJsonBody,
  TOKEN_TTL_SECONDS,
  AIPY_REDIRECT_URI,
} from "../src/oauth.mjs"
import { aipyUserAgent, pickSessionCookie, isAuthRequest, uaOf, withUserAgent } from "../src/browser-login.mjs"
import { readFileSync } from "node:fs"

test("① PKCE：verifier 43 字符，challenge = SHA256(verifier) 的 base64url", () => {
  const { verifier, challenge } = makePkce()
  assert.equal(verifier.length, 43, "32 字节 base64url 应为 43 字符")
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  const expect = createHash("sha256").update(verifier).digest("base64url")
  assert.equal(challenge, expect, "challenge 必须是 verifier 的 SHA256")
  assert.equal(challenge.length, 43)

  const url = new URL(authorizeUrlFor(challenge))
  assert.equal(url.origin + url.pathname, "https://www.trustoken.cn/api/oauth/authorize")
  for (const k of ["code_challenge", "code_challenge_method", "response_type", "redirect_uri", "scope", "client_id"]) {
    assert.ok(url.searchParams.get(k), `authorize URL 缺 ${k}`)
  }
  assert.equal(url.searchParams.get("code_challenge"), challenge)
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("redirect_uri"), AIPY_REDIRECT_URI)
  assert.equal(url.searchParams.get("client_id"), "aipy-pro")
})

test("② UA 必须是 AiPy 客户端同款（服务端只认 aipy-pro/*）", () => {
  const ua = aipyUserAgent()
  assert.match(ua, /aipy-pro\/2\.1\.1/)
  assert.match(ua, /Electron\/34\.3\.3/)
  assert.match(ua, /Chrome\/134\.0\.6998\.179/)
  assert.ok(!/^Mozilla\/5\.0 \(win32; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/.test(ua), "不能是普通浏览器 UA")
})

test("③ 只拷 trustoken 的 session cookie（非空），其它 cookie 一律不碰", () => {
  const cookies = [
    { name: "session", value: "sess-abc", domain: ".trustoken.cn" },
    { name: "session", value: "other", domain: ".example.com" },
    { name: "theme", value: "dark", domain: ".trustoken.cn" },
  ]
  assert.equal(pickSessionCookie(cookies), "sess-abc")
  assert.throws(() => pickSessionCookie(cookies.slice(1)), /没有拿到 trustoken 的 session cookie/)
  assert.throws(() => pickSessionCookie([{ name: "session", value: "", domain: ".trustoken.cn" }]), /没有拿到/)
  assert.throws(() => pickSessionCookie(null), /没有拿到/)
})

test("④ 302 Location 前缀 aipy-pro://oauth?code= 且能取出 code", () => {
  assert.equal(codeFromLocation("aipy-pro://oauth?code=CODE123&site=cn"), "CODE123")
  assert.throws(() => codeFromLocation("https://example.com/?code=x"), /不是 aipy-pro:\/\/oauth/)
  assert.throws(() => codeFromLocation("aipy-pro://oauth?site=cn"), /没有 code/)
  assert.throws(() => codeFromLocation(""), /不是 aipy-pro:\/\/oauth/)
})

test("⑤ token 形状：access_token 必填，expires_in ≈ 2592000（30 天）", () => {
  assert.equal(TOKEN_TTL_SECONDS, 2_592_000)
  const now = 1_700_000_000_000
  const t = tokenExpiry({ access_token: "at", refresh_token: "rt", expires_in: 2_592_000 }, now)
  assert.equal(t.accessToken, "at")
  assert.equal(t.refreshToken, "rt")
  assert.equal(t.expiresAt, now + 2_592_000_000)
  assert.equal(t.expiresIn, 2_592_000)
  assert.throws(() => tokenExpiry({ refresh_token: "rt" }), /没有 access_token/)
  assert.throws(() => tokenExpiry({ access_token: "at", expires_in: 0 }), /expires_in 不合法/)
})

test("⑥ 响应体只能读一次（文档坑 5.6）：readJsonBody 走 text() + JSON.parse", async () => {
  let reads = 0
  const fake = {
    text: async () => {
      reads++
      if (reads > 1) throw new Error("body 只能读一次")
      return JSON.stringify({ access_token: "at", expires_in: 2592000 })
    },
  }
  const body = await readJsonBody(fake)
  assert.equal(body.access_token, "at")
  assert.equal(reads, 1, "只能读一次 body")
  await assert.rejects(() => readJsonBody({ text: async () => "not json" }), /不是 JSON/)
})

test("⑦ UA 必须在请求层覆盖：auth 请求识别 + User-Agent 头重写 + CDP 三层都在", () => {
  for (const u of [
    "https://www.trustoken.cn/api/user/register/mobile",
    "https://www.trustoken.cn/api/user/login/mobile",
    "https://www.trustoken.cn/api/sms/code",
    "https://www.trustoken.cn/api/oauth/token",
  ]) {
    assert.equal(isAuthRequest(u), true, `应识别为认证请求：${u}`)
  }
  for (const u of ["https://www.trustoken.cn/api/user/self", "https://www.trustoken.cn/assets/main.js", ""]) {
    assert.equal(isAuthRequest(u), false, `不该识别为认证请求：${u}`)
  }
  assert.equal(uaOf({ "User-Agent": "A" }), "A")
  assert.equal(uaOf({ "user-agent": "B" }), "B")
  assert.equal(uaOf({}), "")

  const ua = aipyUserAgent()
  const rewritten = withUserAgent({ Accept: "*/*", "user-agent": "Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36" }, ua)
  assert.equal(rewritten.filter((h) => h.name.toLowerCase() === "user-agent").length, 1, "不能出现两条 UA")
  assert.equal(rewritten.find((h) => h.name.toLowerCase() === "user-agent").value, ua)
  assert.match(rewritten.find((h) => h.name.toLowerCase() === "user-agent").value, /aipy-pro\//)
  assert.equal(withUserAgent({ Accept: "*/*" }, ua).filter((h) => h.name === "User-Agent").length, 1, "没有 UA 时要补一条")

  // 源码锁：启动参数之外，必须在 CDP 请求层覆盖
  const src = readFileSync(new URL("../src/browser-login.mjs", import.meta.url), "utf8")
  for (const w of ["--user-agent=", "Network.setUserAgentOverride", "Emulation.setUserAgentOverride", "Fetch.enable", "Fetch.requestPaused", "Fetch.continueRequest"]) {
    assert.ok(src.includes(w), `browser-login.mjs 缺「${w}」`)
  }
})
