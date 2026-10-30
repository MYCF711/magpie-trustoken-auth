// src/browser-login.mjs —— 受控 Chromium + CDP（注册/登录用）
//
// 2026-10-30 e2e 实测（E:\Downloads\aipy-register-flow.md）后的实现：
// 新号注册必须走「有 AiPy UA 的浏览器窗口」——UA 是服务端认客户端的第一道门。
// 这个模块只做三件事：起窗口、等登录完成、把 trustoken 的 session cookie 拷出来。
// **不拦截 aipy-pro:// 导航**（文档 5.1：自定义协议不经过网络栈，CDP 收不到），
// 拿 code 的事交给 src/oauth.mjs 在 node 里补签。
//
// 流程与判据见 docs/internals.md 第十四节。
//
// ⚠ UA 必须**在请求层**覆盖（启动参数只覆盖导航请求；页面里的 XHR/fetch 可能带浏览器自己的 UA，
//   或被页面自己的 fetch 头覆盖）。这里三层一起上：
//     ① 启动参数 --user-agent（导航）
//     ② CDP Network.setUserAgentOverride + Emulation.setUserAgentOverride（target 的所有请求 + navigator）
//     ③ CDP Fetch.enable + Fetch.continueRequest（最硬：每个请求出去前把 User-Agent 头重写）
//   并在 waitForLogin 里断言 navigator.userAgent 含 aipy-pro/ —— 覆盖失败就当场报错，不要静默。

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"

/** AiPy 客户端同款 UA（文档第 1 节：服务端只认 `aipy-pro/*`） */
export const AIPY_APP_VERSION = "2.1.1"
export function aipyUserAgent() {
  return `Mozilla/5.0 (${process.platform}; ${process.arch}) AppleWebKit/537.36 (KHTML, like Gecko) aipy-pro/${AIPY_APP_VERSION} Chrome/134.0.6998.179 Electron/34.3.3 Safari/537.36`
}

function cacheDir() {
  return join(homedir(), ".cache", "magpie")
}

/** 一次性的浏览器 profile（登录完删掉；不污染用户的日常浏览器） */
export function newProfileDir() {
  return join(cacheDir(), `trustoken-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 找本机 Chromium 内核浏览器（只返回存在的，按优先级） */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files"
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
    const local = env.LOCALAPPDATA || ""
    return [
      { name: "Chrome", path: join(pf, "Google", "Chrome", "Application", "chrome.exe") },
      { name: "Chrome", path: join(pf86, "Google", "Chrome", "Application", "chrome.exe") },
      ...(local ? [{ name: "Chrome", path: join(local, "Google", "Chrome", "Application", "chrome.exe") }] : []),
      { name: "Edge", path: join(pf86, "Microsoft", "Edge", "Application", "msedge.exe") },
      { name: "Edge", path: join(pf, "Microsoft", "Edge", "Application", "msedge.exe") },
    ].filter((c) => {
      try {
        return existsSync(c.path)
      } catch {
        return false
      }
    })
  }
  if (platform === "darwin") {
    return [
      { name: "Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { name: "Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
    ].filter((c) => existsSync(c.path))
  }
  return ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"].flatMap((bin) => {
    try {
      const p = execFileSync("sh", ["-lc", `command -v ${bin}`], { encoding: "utf8" }).trim()
      return p ? [{ name: bin, path: p }] : []
    } catch {
      return []
    }
  })
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function getJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** 发一条 CDP 命令（每次新开一个 WebSocket，够用且不粘连接） */
function cdp(wsUrl, method, params = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let ws
    const timer = setTimeout(() => {
      try { ws?.close() } catch {}
      reject(new Error(`CDP ${method} 超时`))
    }, timeoutMs)
    try {
      ws = new WebSocket(wsUrl)
    } catch (e) {
      clearTimeout(timer)
      reject(e)
      return
    }
    ws.addEventListener("open", () => {
      try {
        ws.send(JSON.stringify({ id: 1, method, params }))
      } catch (e) {
        clearTimeout(timer)
        reject(e)
      }
    })
    ws.addEventListener("message", (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id !== 1) return
      clearTimeout(timer)
      try { ws.close() } catch {}
      msg.error ? reject(new Error(msg.error.message || "CDP error")) : resolve(msg.result)
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("CDP WebSocket 连接失败"))
    })
  })
}

async function evalInTarget(wsUrl, expression) {
  const r = await cdp(wsUrl, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || "页面脚本异常")
  return r?.result?.value
}

/** 需要盯 UA 的请求（注册 / 登录 / 短信 / 换 token） */
export function isAuthRequest(url) {
  return /\/api\/(?:user\/(?:register|login)\/mobile|sms\/code|oauth\/token)/.test(String(url || ""))
}

/** 大小写不敏感地取一个头（CDP 的 request.headers 键大小写不保证） */
export function uaOf(headers) {
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === "user-agent") return String(v || "")
  }
  return ""
}

/** 把请求头里的 User-Agent 换成指定值（Fetch.continueRequest 用；返回 CDP 要的数组） */
export function withUserAgent(headers, ua) {
  const out = []
  let hit = false
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === "user-agent") {
      out.push({ name: "User-Agent", value: ua })
      hit = true
    } else {
      out.push({ name: k, value: String(v) })
    }
  }
  if (!hit) out.push({ name: "User-Agent", value: ua })
  return out
}

/**
 * 对一个 page target 开一条常驻 CDP 连接：设 UA 覆盖 + Fetch 层重写 UA。
 * 记录所有被拦截的请求数、以及注册/登录类请求**最终发出去**的 UA。
 */
function openUaGuard(wsUrl, ua) {
  const state = { intercepted: 0, auth: [], ready: false, lastError: "" }
  let ws
  try {
    ws = new WebSocket(wsUrl)
  } catch (e) {
    state.lastError = String(e?.message ?? e)
    return { state, close() {} }
  }
  let nextId = 10
  const send = (method, params = {}) => {
    try { ws.send(JSON.stringify({ id: nextId++, method, params })) } catch {}
  }
  ws.addEventListener("open", () => {
    send("Network.enable", {})
    send("Network.setUserAgentOverride", { userAgent: ua, acceptLanguage: "zh-CN,zh;q=0.9", platform: "Win32" })
    send("Emulation.setUserAgentOverride", { userAgent: ua, acceptLanguage: "zh-CN,zh;q=0.9", platform: "Win32" })
    send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] })
    state.ready = true
  })
  ws.addEventListener("message", (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.method === "Fetch.requestPaused") {
      const { requestId, request } = msg.params || {}
      state.intercepted++
      if (isAuthRequest(request?.url)) {
        state.auth.push({ url: request.url, ua: ua })
      }
      send("Fetch.continueRequest", { requestId, headers: withUserAgent(request?.headers, ua) })
    }
  })
  ws.addEventListener("error", () => { state.lastError = "UA guard WebSocket 连接失败" })
  return { state, close() { try { ws.close() } catch {} } }
}

/** 从 CDP Storage.getCookies 的结果里挑 trustoken 的 session cookie（判据见文档第 4 节） */
export function pickSessionCookie(cookies) {
  const hit = (Array.isArray(cookies) ? cookies : []).find(
    (c) => c && c.name === "session" && String(c.domain || "").includes("trustoken") && String(c.value || "").length > 0,
  )
  if (!hit) throw new Error("没有拿到 trustoken 的 session cookie（登录可能没有完成）")
  return hit.value
}

/**
 * 起一个带 AiPy UA 的 Chromium 窗口，打开 url。
 * 返回 { port, waitForLogin(), getCookies(), close() }。
 */
export async function launchLoginWindow(url, { timeoutMs = 20_000 } = {}) {
  const cand = browserCandidates()[0]
  if (!cand) throw new Error("本机没找到 Chrome / Edge（需要 Chromium 内核浏览器才能完成注册）")

  const port = await freePort()
  const dir = newProfileDir()
  mkdirSync(dir, { recursive: true })

  const child = spawn(
    cand.path,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      `--user-agent=${aipyUserAgent()}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-features=Translate,MediaRouter",
      "--window-size=1280,900",
      url,
    ],
    { stdio: "ignore", detached: false, windowsHide: false },
  )

  const deadline = Date.now() + timeoutMs
  let ready = false
  while (Date.now() < deadline) {
    try {
      await getJson(`http://127.0.0.1:${port}/json/version`, 1500)
      ready = true
      break
    } catch {
      await sleep(400)
    }
  }
  if (!ready) {
    try { child.kill() } catch {}
    throw new Error(`浏览器没有起来（${cand.name} 的调试端口 ${port} 连不上）`)
  }

  // 每个 page target 一条常驻 UA guard（设覆盖 + Fetch 改头）
  const guards = new Map()
  function guardFor(page) {
    const id = page?.id || page?.webSocketDebuggerUrl || ""
    if (!id || guards.has(id)) return guards.get(id) || null
    const g = openUaGuard(page.webSocketDebuggerUrl, aipyUserAgent())
    guards.set(id, g)
    return g
  }

  async function pages() {
    return getJson(`http://127.0.0.1:${port}/json/list`, 2000)
  }

  async function pageTarget() {
    const list = await pages()
    return (
      list.find((p) => p.type === "page" && /trustoken\.cn/.test(p.url || "")) ||
      list.find((p) => p.type === "page")
    )
  }

  async function waitForLogin({ timeout = 300_000 } = {}) {
    const end = Date.now() + timeout
    let seenUser = ""
    let uaChecked = false
    while (Date.now() < end) {
      try {
        const page = await pageTarget()
        if (page?.webSocketDebuggerUrl) {
          guardFor(page)
          const raw = await evalInTarget(
            page.webSocketDebuggerUrl,
            `JSON.stringify({ url: location.href, user: (() => { try { return localStorage.getItem("user") || "" } catch { return "" } })() , ua: navigator.userAgent })`,
          )
          const st = raw ? JSON.parse(raw) : {}
          // 运行期断言：UA 覆盖必须生效（启动参数不够，必须在请求层/渲染层都覆盖）
          if (!uaChecked && st.ua) {
            if (!/aipy-pro\//.test(st.ua)) {
              throw new Error(`UA 覆盖失败：navigator.userAgent = ${String(st.ua).slice(0, 120)}（应含 aipy-pro/）`)
            }
            uaChecked = true
          }
          if (st.user) seenUser = st.user
          if (seenUser) return { user: seenUser, url: st.url || "" }
          if (String(st.url || "").startsWith("aipy-pro://")) return { user: seenUser, url: st.url }
        }
      } catch (e) {
        if (String(e?.message || "").includes("UA 覆盖失败")) throw e
        // 页面跳转 / target 切换中，继续轮询
      }
      await sleep(1500)
    }
    throw new Error("等待注册/登录超时（5 分钟）：请在新打开的窗口里完成注册或登录后重试")
  }

  async function getCookies() {
    const v = await getJson(`http://127.0.0.1:${port}/json/version`, 3000)
    const r = await cdp(v.webSocketDebuggerUrl, "Storage.getCookies", {})
    return r?.cookies || []
  }

  function uaStats() {
    const all = [...guards.values()]
    return {
      guards: all.length,
      intercepted: all.reduce((n, g) => n + (g.state?.intercepted || 0), 0),
      auth: all.flatMap((g) => g.state?.auth || []),
      lastError: all.map((g) => g.state?.lastError).filter(Boolean).join("; "),
    }
  }

  async function close() {
    for (const g of guards.values()) g.close()
    guards.clear()
    try { child.kill() } catch {}
    // Windows 上 Chrome 会留子进程：taskkill /T 收整棵进程树
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 })
      } catch {}
    }
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        await sleep(300)
      }
    }
  }

  return { port, profileDir: dir, waitForLogin, getCookies, uaStats, close }
}
