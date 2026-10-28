// ② auth.methods[] —— 一个入口：浏览器登录（参考超级麦吉的内置登录）
//
// 超级麦吉的做法：插件自己拉起一个独立 profile 的 Chromium，打开官方登录页，
// 用户在窗口里登录，插件通过 CDP 从页面里读凭据。Trustoken 这里同样：
//   · 登录页有手机号（滑块 + 短信）/ 微信扫码 / 密码三种方式，用户自己操作；
//   · 插件在页面里挂 fetch/XHR 钩子，捕获 /api/user/login* 或 /api/oauth/* 的响应；
//   · 同时兜底读 localStorage.user 和 sessionStorage.oToken；
//   · 拿到 access_token 后创建/读取 API Key。
//
// 铁律：authorize() 立刻返回；真正等登录在 callback() 里。

import { fetchSelf, ensureApiKey } from "../api.mjs"
import { launchLoginBrowser, waitForLogin, closeSession } from "../browser-login.mjs"
import { inviteToUse, rollInvite } from "../invite.mjs"

function maskPhone(p) {
  return String(p || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")
}

async function completeSignIn(c, data) {
  const access = data?.access_token ?? data?.accessToken ?? data?.token
  if (!access) {
    throw new Error(`登录响应里没有 access_token（字段：${Object.keys(data || {}).join(", ")}）`)
  }

  const self = await fetchSelf(access, data?.user?.id ?? data?.id)
  const uid = self?.id ?? data?.user?.id ?? data?.id
  const phone = self?.username ?? data?.user?.username ?? data?.username ?? ""
  const apiKey = await ensureApiKey(access, uid)
  const expiresIn = Number(data?.expires_in ?? 2_592_000)

  await rollInvite({ accountToken: access, uid, accountId: maskPhone(phone) || String(uid ?? "") })

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

export function makeMethods(c) {
  return [
    {
      type: "oauth",
      label: `${c.PROVIDER_NAME} 浏览器登录（手机号 / 微信 / 密码）`,
      async authorize() {
        const inviteCode = inviteToUse()
        const url = inviteCode
          ? `${c.WEB}/login?aff=${encodeURIComponent(inviteCode)}`
          : `${c.WEB}/login`

        let session = null
        let launchError = ""
        try {
          session = await launchLoginBrowser(url)
        } catch (e) {
          launchError = String(e?.message ?? e).slice(0, 300)
        }

        return {
          url,
          opened: Boolean(session),
          method: "auto",
          instructions: session
            ? "已打开独立的登录浏览器窗口。在里面用手机号（拖动滑块 + 短信）/ 微信扫码 / 密码登录；完成后自动继续。"
            : `没能自动拉起浏览器${launchError ? `（${launchError}）` : ""}；请手动打开上面的地址登录。`,
          async callback() {
            try {
              if (!session) return { type: "failed", error: "登录浏览器没有启动" }
              const got = await waitForLogin(session)
              if (!got?.access_token) {
                return {
                  type: "failed",
                  error: "没拿到 access_token：登录完成了吗？如果页面已经登录成功，请把登录方式换成「本机登录」再试。",
                }
              }
              return await completeSignIn(c, got)
            } catch (e) {
              return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
            } finally {
              await closeSession(session).catch(() => {})
            }
          },
        }
      },
    },
  ]
}
