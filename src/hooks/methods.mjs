// ② auth.methods[] —— 登录 / 添加账号的入口，按「本机有没有该供应商账号」自动分流
//
//   · 有账号（plugin-auth.json 里有 trustoken / trustoken#…）：
//       只留一个「本机登录（读取 AiPy 会话）」—— 点一下就把 AiPy Pro 客户端里
//       已经登录的号导入 magpie，无输入、无选择页。
//   · 没有账号：
//       ① 「本机登录（读取 AiPy 会话）」（客户端已经装好的人免下载）
//       ② 「手机号注册 / 登录（弹窗）」（受控 Chromium 完成注册 / 登录；打不开浏览器时回退成系统浏览器 + 复制网址）
//
// 「有没有账号」只能只读 ~/.config/magpie/plugin-auth.json（magpie 不给插件账号列表
// API，理由与口径见 src/accounts.mjs 文件头）。读不到时保守按「有账号」处理。
//
// ⚠ label 一律稳定文案（magpie 在插件加载时读走并缓存，见 magicrew AGENTS 坑 31）；
//   动态信息（邀请码、本次会做什么）全部放进 authorize() 返回的 instructions。
// ⚠ 列表层是按账号状态现算的（index.mjs 的 `get methods()` + magpie 每次 providers RPC
//   都会读 auth.methods）；但**行为层还有第二道兜底** —— 下载入口的 authorize() 会
//   再判一次账号，有账号时绝不返回下载链接。
//
// 手机号注册 / 登录流程（无账号时的入口之一，2026-10-30 e2e 实测版）：
//   1. 用户在 magpie 里填手机号；
//   2. 插件起一个**受控 Chromium 窗口**（AiPy 客户端 UA + 独立 profile），
//      打开 /api/oauth/authorize → 307 到 /oauth/login（该页会把 sessionStorage.layout 设为 "false"，
//      前端才会走 /api/user/register/mobile —— 新号注册的第二道门）；
//   3. 用户在窗口里完成注册/登录（滑块、短信、微信扫码都在这扇窗口里，插件不代解）；
//   4. 插件轮询到 localStorage.user 后，用 CDP Storage.getCookies 拷 trustoken 的 session cookie；
//   5. node 里带 cookie + AiPy UA 重新 GET authorize（redirect:manual）→ 读 302 Location 里的 code；
//   6. POST /api/oauth/token（code + verifier）→ access_token → /api/user/self → /api/token/ → api_key；
//   7. completeSignIn 导入 magpie；关窗口、删一次性 profile、删 verifier 落盘记录。
// 详见 docs/internals.md 十四。

import { fetchSelf, ensureApiKey } from "../api.mjs"
import { makePkce, authorizeUrlFor, codeFromLocation, fetchOAuthCode, exchangeOAuthCode, tokenExpiry, AIPY_REDIRECT_URI } from "../oauth.mjs"
import { launchLoginWindow, aipyUserAgent, pickSessionCookie } from "../browser-login.mjs"
import { fileOf, readJson, writeJson, removeJson } from "../store.mjs"
import { readTrustokenToken } from "../aipy-local.mjs"
import { execFileSync } from "node:child_process"
import { inviteToUse, rollInvite, isKnownAccount } from "../invite.mjs"
import { hasAccounts } from "../accounts.mjs"
import { defaultGroup, pickGroup, saveGroup } from "../header-groups.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 官方下载页（跟着厂商最新版走，不写死任何安装包直链）
const CLIENT_DOWNLOAD_URL = "https://www.aipyaipy.com/"

function copyText(text) {
  try {
    if (process.platform === "win32") {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Value '${String(text).replace(/'/g, "''")}'`], { timeout: 5000, windowsHide: true })
    }
  } catch {}
}

function maskPhone(p) {
  return String(p || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")
}

async function completeSignIn(c, data, meta = {}) {
  const access = data?.access_token ?? data?.accessToken ?? data?.token
  if (!access) {
    throw new Error(`登录响应里没有 access_token（字段：${Object.keys(data || {}).join(", ")}）`)
  }

  const self = await fetchSelf(access, data?.user?.id ?? data?.id)
  const uid = self?.id ?? data?.user?.id ?? data?.id
  const phone = self?.username ?? data?.user?.username ?? data?.username ?? ""
  const apiKey = await ensureApiKey(access, uid)
  const expiresIn = Number(data?.expires_in ?? 2_592_000)

  const known = isKnownAccount(uid)
  const ownCode = await rollInvite({ accountToken: access, uid, accountId: maskPhone(phone) || String(uid ?? "") }, { roll: !known })
  try {
    if (meta.group) {
      saveGroup({
        ...meta.group,
        uid,
        accountId: maskPhone(phone) || String(uid ?? ""),
        affCode: ownCode || meta.affCode || meta.group.affCode,
      })
    }
  } catch {}

  return {
    type: "success",
    access: apiKey,
    refresh: data?.refresh_token ?? data?.refreshToken ?? access,
    expires: Date.now() + Math.max(3_600, expiresIn) * 1000,
    accountId: maskPhone(phone) || String(uid ?? "trustoken"),
    uid: String(uid ?? ""),
    apiKey,
    accountToken: access,
    username: phone,
    quota: self?.quota,
  }
}

export function makeMethods(c, deps = {}) {
  // 依赖可注入是给测试用的：入口集合必须能按「本机有没有该供应商账号」现算，
  // 测试不该去读这台机器真实的 plugin-auth.json / AiPy 客户端。
  const {
    hasAccounts: hasAccountsNow = () => hasAccounts(c.PROVIDER),
    isKnown: isKnownNow = (uid) => isKnownAccount(uid),
    readToken: readTokenNow = () => readTrustokenToken(),
    fetchSelf: fetchSelfNow = (token, uid) => fetchSelf(token, uid),
    copyToClipboard: copyClipboard = copyText,
    launchWindow: launchWindowNow = (url, opts) => launchLoginWindow(url, opts),
  } = deps
  const out = [
    {
      type: "oauth",
      label: `${c.PROVIDER_NAME} 手机号注册 / 登录（弹窗）`,
      prompts: [
        {
          type: "text",
          key: "phone",
          message: "手机号",
          placeholder: "13800138000",
          validate: (v) =>
            /^1\d{10}$/.test(String(v || "").replace(/[\s-]/g, "")) ? undefined : "11 位手机号，只要数字",
        },
      ],
      async authorize(inputs) {
        const phone = String(inputs?.phone || "").replace(/[\s-]/g, "")
        if (!/^1\d{10}$/.test(phone)) throw new Error("手机号不完整")
        // 邀请码不再问用户：由供应商编辑器里的「邀请码固定不滚动」开关决定（见 index.mjs 的 auth.options）
        const inviteCode = inviteToUse()
        const group = pickGroup()
        const account = maskPhone(phone)

        // ⚠ 文档坑 5.2：verifier 必须先落盘。进程被杀后服务端 session 里还挂着旧的授权请求，
        //   只存内存会丢；同一手机号 10 分钟内复用同一对 PKCE，避免被弹回旧授权页。
        const pkceFile = fileOf("oauth-pkce", { siteId: "trustoken", account })
        const saved = readJson(pkceFile, null)
        const reusable =
          saved?.verifier && saved?.challenge && Date.now() - Date.parse(saved.at || 0) < 10 * 60_000
        const { verifier, challenge } = reusable ? saved : makePkce()
        if (!reusable) writeJson(pkceFile, { verifier, challenge, account, at: new Date().toISOString() })

        const loginUrl = authorizeUrlFor(challenge, undefined, inviteCode)
        let win
        try {
          win = await launchWindowNow(loginUrl)
        } catch (e) {
          // ⚠ 回退（主人 2026-10-31 要求）：打不开受控浏览器时，不能只报「没找到浏览器」。
          // 把登录网址复制到剪贴板 + 返回 opened:false，让 magpie 用系统浏览器打开
          // （host 的 plugins.go:788：`if !st.Opened { open(st.URL) }`）。
          // 但系统浏览器这条路拿不到 session cookie —— 只能完成「网页登录」，不会自动导入；
          // 若浏览器最终跳到 aipy-pro://oauth?code=...，用户可以把整段粘回来，用这次的 verifier 换 token。
          const reason = String(e?.message ?? e).slice(0, 200)
          try {
            copyClipboard(loginUrl)
          } catch {}
          return {
            url: loginUrl,
            opened: false,
            method: "code",
            instructions:
              `没能启动受控浏览器（${reason}）。
` +
              `登录网址（已复制到剪贴板）：
${loginUrl}

` +
              `用系统浏览器打开上面的网址，完成手机号 / 微信登录。
` +
              `⚠ 这条回退只能完成网页登录：插件拿不到系统浏览器的 session cookie，**通常不会自动导入**。
` +
              `如果登录后浏览器地址栏出现 aipy-pro://oauth?code=...（或提示打开 AiPy Pro），把整段网址或 code 粘贴到下面的输入框，插件会用它换 token；
` +
              `没有的话，请改用「本机登录（读取 AiPy 会话）」导入（需要 AiPy Pro 客户端已登录同一个号）；或装一个 Chrome / Edge 再回来点「手机号注册 / 登录（弹窗）」。`,
            async callback(raw) {
              const t = String(raw || "").trim()
              if (!t) {
                return {
                  type: "failed",
                  error: "没有拿到 code：请改用「本机登录（读取 AiPy 会话）」导入，或安装 Chrome / Edge 后重试弹窗注册。",
                }
              }
              try {
                const code = /^aipy-pro:\/\/oauth\?/i.test(t) ? codeFromLocation(t) : t.replace(/^code[=:]\s*/i, "")
                const tokenJson = await exchangeOAuthCode({ code, verifier, redirectUri: AIPY_REDIRECT_URI })
                const tok = tokenExpiry(tokenJson)
                removeJson(pkceFile)
                return await completeSignIn(
                  c,
                  { access_token: tok.accessToken, refresh_token: tok.refreshToken || tok.accessToken, expires_in: tok.expiresIn },
                  { group, affCode: inviteCode },
                )
              } catch (err) {
                return { type: "failed", error: String(err?.message ?? err).slice(0, 500) }
              }
            },
          }
        }

        return {
          url: "",
          opened: true,
          method: "auto",
          instructions: `已打开注册窗口（带 AiPy 客户端 UA）：新手机号会自动走注册，老号直接登录。在网页里完成验证后不用再点任何东西，插件会自动导入。邀请码：${inviteCode || "无"}。`,
          async callback() {
            try {
              await win.waitForLogin({ timeout: 5 * 60_000 })
              const cookies = await win.getCookies()
              const session = pickSessionCookie(cookies)
              // 浏览器里拦不到 aipy-pro:// 导航（文档 5.1）：在 node 里补签 302
              const code = await fetchOAuthCode({ challenge, sessionCookie: session, userAgent: aipyUserAgent() })
              const tokenJson = await exchangeOAuthCode({ code, verifier, redirectUri: AIPY_REDIRECT_URI })
              const tok = tokenExpiry(tokenJson)
              removeJson(pkceFile)
              return await completeSignIn(
                c,
                { access_token: tok.accessToken, refresh_token: tok.refreshToken || tok.accessToken, expires_in: tok.expiresIn },
                { group, affCode: inviteCode },
              )
            } catch (e) {
              return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
            } finally {
              await win.close().catch(() => {})
            }
          },
        }
      },
    },
    {
      type: "api",
      keyless: true,
      label: `${c.PROVIDER_NAME} 本机登录（读取 AiPy 会话）`,
      async authorize() {
        const tok = await readTokenNow()
        if (!tok?.access_token) {
          throw new Error(
            "本机没有 AiPy 登录态：请先在 AiPy Pro 客户端登录要添加的手机号，再回来点「本机登录（读取 AiPy 会话）」。首次使用才需要下载客户端。",
          )
        }
        const self = await fetchSelfNow(tok.access_token, "")
        const uid = self?.id
        if (!uid) throw new Error("AiPy 会话无效：/api/user/self 没有返回用户")
        const accountId = maskPhone(self?.username) || String(uid)
        // 查重：客户端还停在一个已经在 magpie 里的号上时，别让用户以为「新号加上了」。
        // magpie 的 settle 遇到同 accountId+uid 是替换旧账号，不查重就是静默没变化。
        if (isKnownNow(uid)) {
          throw new Error(
            `本机 AiPy 当前登录的是 ${accountId}，这个号已经在 magpie 里了。要添加新号：先在 AiPy Pro 客户端切换到那个号，再点一次「本机登录（读取 AiPy 会话）」。`,
          )
        }
        const apiKey = await ensureApiKey(tok.access_token, uid)
        await rollInvite({ accountToken: tok.access_token, uid, accountId }, { roll: false })
        return {
          type: "success",
          access: apiKey,
          refresh: tok.access_token,
          expires: Number(tok.expires_at) || Date.now() + 30 * 86400e3,
          accountId,
          uid: String(uid),
          apiKey,
          accountToken: tok.access_token,
          username: self?.username,
          quota: self?.quota,
        }
      },
    },
  ]

  // 入口集合按「本机有没有该供应商的账号」现算：
  //   有账号（≥1）→ 只留「本机登录」一条：有账号就直接走软件登录，不要再弹下载。
  //   没有账号     → 「手机号注册 / 登录（弹窗）」+「本机登录（读取 AiPy 会话）」两条。
  //
  // 下载入口已删除（0.3.10）：0.3.7 起弹窗能直接注册新号，不再需要引导用户装 AiPy Pro 客户端。
  // firstLoginMethod 的定义还留着是为了「万一弹窗注册被上游封了」时能一行恢复；它不再挂载。
  if (hasAccountsNow()) return [out[1]]
  return [out[1], out[0]]
}
