// ⑤ auth.usage(getAuth) —— 额度 → 卡片
//
// /api/user/self 的 quota 单位是 quota：500,000 quota = 1 元；100 灵石 = 1 元。
// 所以 灵石 = quota / 5000。
//
// 钱包型窗口只给 balance，不给 used —— 给了会被当成占比（quota.mjs 会 throw）。

import { fetchSelf } from "../api.mjs"
import { QUOTA_PER_STONE } from "../context.mjs"
import { usage as buildUsage, usageWindow } from "../quota.mjs"

export function makeUsage(c) {
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
    if (!token) return { error: "没有账号 token，请重新登录", windows: [] }

    try {
      const self = await fetchSelf(token, auth.uid)
      const stones = Number(self?.quota || 0) / QUOTA_PER_STONE
      const used = Number(self?.used_quota || 0) / QUOTA_PER_STONE
      const plan = stones > 0 ? "灵石制" : "已耗尽"
      return buildUsage({
        plan,
        windows: [
          usageWindow({
            name: "灵石",
            balance: stones,
            unit: "灵石",
            display: `${stones.toFixed(2)} 灵石（累计消耗 ${used.toFixed(2)}）`,
          }),
        ],
      })
    } catch (e) {
      return { error: String(e?.message ?? e).slice(0, 300), windows: [] }
    }
  }
}
