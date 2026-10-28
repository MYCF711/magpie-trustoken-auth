// ⑦ provider.models(provider, { auth }) —— 每账号的模型目录
//
// 三态降级：
//   ① /v1/models 整个失败 → 退回静态表（不返回空表）
//   ② 单条缺字段 → 用静态表补齐（不猜未知字段）
//   ③ 登录失效 → 抛 signIn: "expired"

import { staticModels } from "../context.mjs"
import { fetchV1Models, asSignInExpired } from "../api.mjs"
import { mergeModels } from "../models.mjs"

export function makeModels(c) {
  return async (_provider, { auth } = {}) => {
    const fallback = staticModels()
    if (!auth) return fallback

    const apiKey = auth.type === "api" ? auth.key : auth.apiKey || auth.access
    if (!apiKey) return fallback

    try {
      const live = await fetchV1Models(apiKey)
      if (!live.length) return fallback
      return mergeModels(live)
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) {
        throw asSignInExpired("Trustoken API Key 失效，请重新登录")
      }
      return fallback
    }
  }
}
