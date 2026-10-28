// ② auth.methods[] —— 只保留一个入口：从本机 AiPy 登录态自动登录
//
// 为什么不是手机号验证码：Trustoken 的 /api/sms/code 在真实浏览器里也返回 400
// （滑块验证在页面上，但接口仍然拒发；2026-10-29 实测），所以插件不重复实现
// 这套表单，直接复用本机 AiPy Pro 已经拿到的 OAuth 会话：
//   %APPDATA%\aipy-pro\aipy  meta.trustoken-token  → access_token
//   setting(api, key)                              → 本地 API key
// 然后校验 /api/user/self、必要时创建 API key。
//
// 这是「自己的适配」：登录态本来就存在，没必要让用户再输一次。

import { fetchSelf, ensureApiKey } from "../api.mjs"
import { readTrustokenToken } from "../aipy-local.mjs"
import { rollInvite } from "../invite.mjs"

function maskPhone(p) {
  return String(p || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")
}

export function makeMethods(c) {
  return [
    {
      type: "api",
      keyless: true,
      label: `${c.PROVIDER_NAME} 本机登录（读取 AiPy 会话）`,
      async authorize() {
        const tok = await readTrustokenToken()
        if (!tok?.access_token) {
          throw new Error("本机没有 AiPy 登录态：先打开 AiPy Pro 登录一次，再点这里")
        }

        // 用账号 token 自查；顺带拿 uid / 用户名
        const self = await fetchSelf(tok.access_token, "")
        const uid = self?.id
        if (!uid) throw new Error("账号 token 无效：/api/user/self 没有返回用户")

        // 始终用账号 token 查/建平台令牌，避免拿到过期的旧 key
        const apiKey = await ensureApiKey(tok.access_token, uid)

        await rollInvite({
          accountToken: tok.access_token,
          uid,
          accountId: maskPhone(self?.username) || String(uid),
        })

        return {
          type: "success",
          access: apiKey,
          refresh: tok.access_token,
          expires: Number(tok.expires_at) || Date.now() + 30 * 86400e3,
          accountId: maskPhone(self?.username) || String(uid),
          uid: String(uid),
          apiKey,
          accountToken: tok.access_token,
          username: self?.username,
          quota: self?.quota,
        }
      },
    },
  ]
}
