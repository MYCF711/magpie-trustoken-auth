// ⑤ auth.usage(getAuth) —— 额度 → 卡片
//
// /api/user/self 的 quota 单位是 quota：500,000 quota = 1 元；100 灵石 = 1 元。
// 所以 灵石 = quota / 5000。
//
// 钱包型窗口只给 balance，不给 used —— 给了会被当成占比（quota.mjs 会 throw）。
//
// ## 登录令牌失效时怎么还显示余额（2026-11-28 主人截图「暂时无法获取额度：
//    无权进行此操作，access token 无效」）
//
// 三条事实，缺一条这个降级就不成立：
//   ① 登录 access_token 会失效，而且**没有 refresh_token 可续**（上游 401
//      unsupported_grant_type / invalid_grant，见 src/hooks/refresh.mjs）；
//   ② 同一个账号的网关 apiKey 是永久的 —— 实测 5 个号里 3 个登录令牌已死，
//      `GET /v1/models` 却全部 200；
//   ③ OpenAI 兼容的计费端点认这把 apiKey，且换算回来与 /api/user/self 逐位相同
//      （推导与实测见 src/api.mjs 的 fetchBillingBalance）。
//
// 所以：/api/user/self 读不到时，改用网关计费读余额，并在 display 里如实写明
// 「网关计费口径」和「登录令牌已失效，签到需重新登录」——
// 既不假装一切正常，也不把整个账号（其实还能跑模型）报成不可用。

import { fetchSelf, fetchBillingBalance, isAccountLoginDead } from "../api.mjs"
import { QUOTA_PER_STONE } from "../context.mjs"
import { usage as buildUsage, usageWindow } from "../quota.mjs"

/** 登录令牌已死时的定性文案：说清「什么坏了 / 什么没坏 / 要做什么」 */
export const LOGIN_DEAD_HINT =
  "登录令牌已失效（模型调用不受影响）；签到与账号接口需要重新登录这个账号"

/**
 * 失败原因 → 卡片上的 error 文案。
 *
 * ⚠ 不要自己加「暂时无法获取额度：」—— 那是 **magpie 自己**给 usage.error 加的前缀
 *   （旧实现在卡片上看到的就是「暂时无法获取额度：无权进行此操作，access token 无效」）。
 *   自己再加一层会变成「暂时无法获取额度：暂时无法获取额度：…」。
 *
 * 认得出「登录令牌作废」就换成直说：那句话不是暂时的，重试一辈子也不会好。
 */
export function usageErrorText(e) {
  if (isAccountLoginDead(e)) return LOGIN_DEAD_HINT
  return String(e?.message ?? e).slice(0, 300)
}

/** 钱包窗口：余额 + 累计消耗 + 来源说明（display 只是文字，不参与排序） */
function walletWindow({ stones, used, sourceNote = "" }) {
  return usageWindow({
    name: "灵石",
    balance: stones,
    unit: "灵石",
    display: `${stones.toFixed(2)} 灵石（累计消耗 ${used.toFixed(2)}）${sourceNote}`,
  })
}

export function makeUsage(c, deps = {}) {
  // 依赖可注入：离线测试不该打真上游
  const readSelf = deps.fetchSelf ?? ((token, uid) => fetchSelf(token, uid))
  const readBilling = deps.fetchBilling ?? ((apiKey) => fetchBillingBalance(apiKey))

  return async (getAuth) => {
    const auth = await getAuth()
    if (!auth) return { error: "未登录", windows: [] }
    if (auth.type === "api") {
      return {
        error: "API Key 登录看不到灵石余额；用手机号验证码登录可显示签到与余额",
        windows: [],
      }
    }

    const token = auth.accountToken || auth.refresh
    const apiKey = auth.apiKey || (auth.type === "oauth" ? auth.access : "")
    /** 第一段（账号接口）的失败原因：决定第二段之后卡片上写什么 */
    let loginError = token ? null : new Error("没有账号 token，请重新登录")

    // 连账号令牌和网关令牌都没有：这句不是「暂时」，直说
    if (!token && !apiKey) return { error: "没有账号 token，请重新登录", windows: [] }

    // ── ① 首选：账号接口（权威口径，带 used_quota） ──────────────────
    if (token) {
      try {
        const self = await readSelf(token, auth.uid)
        const stones = Number(self?.quota || 0) / QUOTA_PER_STONE
        const used = Number(self?.used_quota || 0) / QUOTA_PER_STONE
        const plan = stones > 0 ? "灵石制" : "已耗尽"
        return buildUsage({
          plan,
          windows: [walletWindow({ stones, used })],
        })
      } catch (e) {
        loginError = e
      }
    }

    // ── ② 降级：网关计费（apiKey 永久，模型调用也靠它） ──────────────
    if (apiKey) {
      try {
        const b = await readBilling(apiKey)
        return buildUsage({
          plan: b.stones > 0 ? "灵石制" : "已耗尽",
          windows: [
            walletWindow({
              stones: b.stones,
              used: b.used,
              sourceNote: isAccountLoginDead(loginError) ? " · 网关计费口径（登录令牌已失效，签到需重新登录）" : " · 网关计费口径",
            }),
          ],
        })
      } catch (e) {
        // 计费也读不到：保留「哪一段更值得说」的那个原因 —— 登录令牌死了才是根因
        if (!isAccountLoginDead(loginError)) loginError = e
      }
    }

    return { error: usageErrorText(loginError), windows: [] }
  }
}
