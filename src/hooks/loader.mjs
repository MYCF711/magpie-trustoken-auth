// ④ auth.loader(getAuth) —— 请求接管
//
// 返回 baseURL + apiKey，magpie 的 SDK 会自动加 Authorization: Bearer。
// 两种登录态都支持：
//   oauth（手机号 / 粘贴 token） → auth.apiKey 是平台令牌
//   api（直接粘 API Key）        → auth.key
//
// 另外带一个 `fetch`（magpie 的插件契约：loader 的 fetch 一旦给了，
// 聊天请求就走它，见 internal/plugin/host.js 的 `const f = typeof o.fetch === "function" ? o.fetch : fetch`）。
// 它的唯一职责是把上游的 400/422 按语义翻译成 magpie 认的状态码，好让智能路由换号重试、
// 不把 400 直接摔给客户端 —— 完整证据与判据在 `src/status.mjs` 顶部。
//
// ⚠ 这里**不改请求**：不改 body、不改 Authorization、不加头 —— magpie 递进来的
//   `input`/`init`（url + 已经带好 Bearer 的 headers + body + signal）原样转交。
//   也不读任何非 400/422 的响应体（200 是 SSE 干流，读一下就废了）。

import { BASE } from "../context.mjs"
import { rewriteRefusal } from "../status.mjs"

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
      async fetch(input, init) {
        const res = await fetch(input, init)
        return rewriteRefusal(res)
      },
    }
  }
}
