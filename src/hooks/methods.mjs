// ② auth.methods[] —— 登录 / 添加账号的入口，**恒定两条**（0.3.12 修订坑 28 口径）：
//
//   ① 「本机登录（读取 AiPy 会话）」—— 点一下就把 AiPy Pro 客户端里已登录的号导入
//      magpie，无输入、无选择页；同一号已在 magpie 里时明确报错（不静默）。
//   ② 「手机号注册 / 登录（弹窗）」—— 受控浏览器弹窗注册新号 / 登录任意号。
//
// 「有没有账号」只读 ~/.config/magpie/plugin-auth.json（magpie 不给插件账号列表 API，
// 理由与口径见 src/accounts.mjs 文件头），但现在**只影响提示文案，不影响入口集合**——
// 入口集合按账号状态收缩会让 magpie 的位置索引漂移（详见文件尾注释）。
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

  // 入口集合**恒定不收缩**（0.3.12 修订坑 28 口径）：
  //   「本机登录」+「手机号注册 / 登录（弹窗）」两条，无论有没有账号。
  //
  // 为什么不能按账号状态收缩：magpie 的登录页按 methods 的**位置**调插件（页面渲染时的
  // index），而插件每次 providers RPC 现算列表。第一个号加上后如果收缩成 1 条，用户点
  // 「弹窗」按钮（旧 index 1 或缓存条目）就会错配到现算列表的另一条——实测（2026-10-31）：
  // 点弹窗却执行了本机登录的查重、报「这个号已经在 magpie 里了」，浏览器根本不弹，
  // 第二个以后的号永远加不上。入口集合形状恒定 = 任何 index 永不漂移。
  //
  // 下载入口已删除（0.3.10）：0.3.7 起弹窗能直接注册新号，不再需要引导用户装 AiPy Pro 客户端；
  // 坑 28「有账号只留本机登录」的前提（下载入口挡人）已不存在。查重仍在本机登录 authorize()
  // 里做（客户端停在同一号上时明确报错，不静默）。firstLoginMethod 的定义还留着是为了
  // 「万一弹窗注册被上游封了」时能一行恢复；它不再挂载。
  return [out[1], out[0]]
}
