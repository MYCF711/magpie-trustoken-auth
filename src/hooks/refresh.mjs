// ③ auth.refresh(auth) —— 续期
//
// ## 上游到底能不能续
//
// 2026-11-20 用真实凭据实测（5 个号结果一致）：
//
//   · `POST /api/oauth/token` + `grant_type=refresh_token`
//       401 unsupported_grant_type —— 上游**没有** refresh_token 端点
//   · `GET /api/token/`（带登录 token + new-api-user）
//       `"key": "Uaylzh…"`, `"expired_time": -1`, `"unlimited_quota": true`
//       —— 模型网关用的那把 API 令牌是**永久**的
//   · `GET /api/user/self` 200、`GET /v1/models` 200 —— 账号与令牌都活着
//
// 结论：**模型调用不需要续期**（永久令牌）；登录 access_token 的 30 天到期
// 没有可续的东西，只能重新手机号登录。
//
// ## 那 refresh 钩子该干什么
//
// magpie 的 staleAccess()（宿主 host.js）对「没到期却被上游 401 拒掉」的
// OAuth 账号会把 `expires` 写成 `1`，等下一个 refresh 把它续上；它不是
// 「登录失效」的信号。旧实现把 `Number(expires)` 直接和 `Date.now()` 比，
// 读到 1 就抛 `signIn: "expired"` —— 于是账号永久卡在「需要重新登录」，
// 而令牌其实好着（2026-11-20 五个号全躺就是这条链）。
//
// 现在的判据：**以网关令牌的真实可用性为准**，而不是本地时间戳。
//
//   · `GET /v1/models` 200        → 续 30 天，返回 `{ expires }`
//   · 401 / 403                   → 令牌真失效，抛 `signIn: "expired"`
//   · 网络 / 超时 / 5xx           → 抛普通错误：不标失效，下一轮再来
//
// ⚠ 返回是「合并」语义（宿主 `{ ...was, ...fields }`）：只给 expires，
//   其余字段（access / refresh / apiKey / accountToken / uid / accountId /
//   username / quota）由宿主原样保留，不要在这里重复回传。

import { ApiError, fetchV1Models } from "../api.mjs"

/** 续期窗口：API 令牌本身永久，这里按 30 天一个周期自检一次 */
export const RENEW_MS = 30 * 24 * 60 * 60 * 1000

/** 提前量：距到期这么多以内才真的去探一次（宿主自己的 refreshLead 是 24h） */
const LEAD_MS = 60 * 1000

/**
 * @param {object} c 供应商上下文（这里只为了与其它钩子保持签名一致）
 * @param {{ probe?: (apiKey: string) => Promise<unknown> }} [deps] 测试注入点
 */
export function makeRefresh(c, deps = {}) {
  const probe = deps.probe ?? ((apiKey) => fetchV1Models(apiKey))
  return async (auth) => {
    if (!auth) return undefined
    const expires = Number(auth.expires || 0)
    if (!expires) return undefined
    const now = Date.now()
    if (now < expires - LEAD_MS) return undefined

    // access 在登录时就是 apiKey（methods.mjs 的 `access: apiKey`），老账号只有其中一个
    const apiKey = auth.apiKey || auth.access
    if (!apiKey) {
      throw Object.assign(new Error("Trustoken 账号没有可用的网关令牌，请重新登录"), {
        signIn: "expired",
      })
    }
    try {
      await probe(apiKey)
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        throw Object.assign(new Error("Trustoken 网关拒绝了账号的 API 令牌，请重新登录"), {
          signIn: "expired",
        })
      }
      throw e
    }
    return { expires: now + RENEW_MS }
  }
}