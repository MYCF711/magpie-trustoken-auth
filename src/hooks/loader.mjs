// ④ auth.loader(getAuth) —— 请求接管
//
// 返回 baseURL + apiKey，magpie 的 SDK 会自动加 Authorization: Bearer。
// 两种登录态都支持：
//   oauth（手机号 / 粘贴 token） → auth.apiKey 是平台令牌
//   api（直接粘 API Key）        → auth.key

import { BASE } from "../context.mjs"

export function makeLoader(c) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (!auth) return {}
    const apiKey = auth.type === "api" ? auth.key : auth.apiKey || auth.access
    if (!apiKey) return {}
    return {
      baseURL: BASE,
      apiKey,
      headers: {
        "user-agent": "magpie-trustoken-auth/0.1.0",
      },
    }
  }
}
