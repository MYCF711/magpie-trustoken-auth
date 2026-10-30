// ② auth.methods[] —— 登录 / 添加账号的入口，按「本机有没有该供应商账号」自动分流
//
//   · 有账号（plugin-auth.json 里有 trustoken / trustoken#…）：
//       只留一个「本机登录（读取 AiPy 会话）」—— 点一下就把 AiPy Pro 客户端里
//       已经登录的号导入 magpie，无输入、无选择页。
//   · 没有账号：
//       ① 「首次使用：下载 AiPy Pro 客户端注册」（问邀请码模式 → 下载链接 → 轮询登录态）
//       ② 「本机登录（读取 AiPy 会话）」（客户端已经装好的人免下载）
//       ③ 「手机号登录（无头浏览器）」（已注册的手机号直接登录）
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
import { makePkce, authorizeUrlFor, fetchOAuthCode, exchangeOAuthCode, tokenExpiry, AIPY_REDIRECT_URI } from "../oauth.mjs"
import { launchLoginWindow, aipyUserAgent, pickSessionCookie } from "../browser-login.mjs"
import { fileOf, readJson, writeJson, removeJson } from "../store.mjs"
import { readTrustokenToken } from "../aipy-local.mjs"
import { execFileSync } from "node:child_process"
import { inviteToUse, rollInvite, modeHint, saveInviteChoice, isKnownAccount } from "../invite.mjs"
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
        // 邀请码：留空 = 自动（跟随最近登录/签到的号，否则用作者码）；填了 = 指定这个码。
        // 与「首次使用：下载客户端注册」那条的语义一致，见 src/invite.mjs 的 saveInviteChoice。
        {
          type: "text",
          key: "invite",
          message: "邀请码（可选）",
          placeholder: modeHint(),
        },
      ],
      async authorize(inputs) {
        const phone = String(inputs?.phone || "").replace(/[\s-]/g, "")
        if (!/^1\d{10}$/.test(phone)) throw new Error("手机号不完整")
        // 留空 / 0 = 自动；填了 = 指定。与「首次使用：下载」那条同一套策略。
        saveInviteChoice(inputs?.invite)
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

        let win
        try {
          win = await launchLoginWindow(authorizeUrlFor(challenge, undefined, inviteCode))
        } catch (e) {
          removeJson(pkceFile)
          throw new Error(`打不开注册窗口：${String(e?.message ?? e).slice(0, 300)}`)
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

  // 首次登录 = 下载 AiPy Pro 客户端并在客户端内注册，然后等本机 token 出现。
  // 不再走网页 /api/user/register/mobile（服务端对新号是硬拦截）。
  // 邀请码先选：留空 / 0 = 自动（跟随最近登录 / 签到的号），也可直接填一个码；选完再给官方下载页。
  //
  // ⚠ 这条路**只在「本机 0 个账号」时出现**（见函数末尾按 hasAccounts() 拼列表）。
  //   即便 magpie 的 providers 列表缓存还是旧的、把这个入口显示给了有账号的人，
  //   authorize() 里也会再判一次：有账号就**绝不返回下载链接**，直接给「请走本机登录」。
  //   这就是「缓存不刷新，行为层兜底仍然正确」的那一层。
  const firstLoginMethod = {
    type: "oauth",
    // label 必须是稳定文案：magpie 在插件加载时把 methods[].label 读走缓存，
    // 动态邀请码放进 authorize 的 instructions（magicrew AGENTS 坑 31）。
    label: `${c.PROVIDER_NAME} 首次使用：下载 AiPy Pro 客户端注册`,
    async ask(inputs) {
      // 有账号 → 一个问题都不问（理论上这个入口不会出现，兜住旧缓存）
      if (hasAccountsNow()) return null
      if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, "invite")) {
        return { type: "text", key: "invite", message: "邀请码", placeholder: modeHint() }
      }
      return null
    },
    async authorize(inputs) {
      // 行为层兜底：有账号时绝不再走下载（详见上面的注释）
      if (hasAccountsNow()) {
        return {
          url: "",
          opened: true,
          method: "auto",
          instructions: "你已经有 Trustoken 账号了：这次不会再走下载安装。",
          async callback() {
            return {
              type: "failed",
              error:
                "你已经有 Trustoken 账号了：请在 AiPy Pro 客户端登录要添加的号，再用「本机登录（读取 AiPy 会话）」导入；下载入口只给还没有账号的人。",
            }
          },
        }
      }
      saveInviteChoice(inputs?.invite)
      const code = inviteToUse()
      const url = CLIENT_DOWNLOAD_URL
      copyClipboard(code)
      const first = await readTokenNow().catch(() => null)
      const firstToken = first?.access_token || ""
      return {
        url,
        opened: false,
        method: "auto",
        instructions: `邀请码 ${code} 已复制到剪贴板。
下载安装包后，在 AiPy Pro 客户端里用新手机号完成首次注册；登录成功后这个窗口会自动导入登录态，不用再回来点任何东西。
下载链接：${url}`,
        async callback() {
          const deadline = Date.now() + 10 * 60 * 1000
          while (Date.now() < deadline) {
            const tok = await readTokenNow().catch(() => null)
            if (tok?.access_token && tok.access_token !== firstToken) {
              return await completeSignIn(c, { access_token: tok.access_token, refresh_token: tok.refresh_token || tok.access_token }, { group: defaultGroup(), affCode: code })
            }
            await sleep(2000)
          }
          return { type: "failed", error: "等待 AiPy Pro 登录超时（10 分钟）：请确认客户端已登录新号" }
        },
      }
    },
  }

  // 入口集合按「本机有没有该供应商的账号」现算：
  //   有账号（≥1）→ 只留「本机登录」一条：主人原话「有账号就直接走软件登录」，不要再弹下载。
  //   没有账号     → 才露出「首次使用：下载客户端注册」，外加本机登录（客户端已装的人免下载）
  //                 和手机号登录（已注册的号）。
  // out = [手机号登录, 本机登录]
  if (hasAccountsNow()) return [out[1]]
  return [firstLoginMethod, out[1], out[0]]
}
