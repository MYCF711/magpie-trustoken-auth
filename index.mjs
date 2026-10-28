// Trustoken（AiPy）· magpie 供应商插件
//
// 一个站点、一个供应商、九个钩子。index 只做装配，实现全在 src/。
//
//   src/hooks/config.mjs    ① config(cfg)
//   src/hooks/methods.mjs   ② auth.methods[]
//   src/hooks/refresh.mjs   ③ auth.refresh
//   src/hooks/loader.mjs    ④ auth.loader
//   src/hooks/usage.mjs     ⑤ auth.usage
//   src/hooks/checkin.mjs   ⑥ auth.checkin
//   src/hooks/models.mjs    ⑦ provider.models
//   src/hooks/headers.mjs   ⑧ chat.headers

import { ctx, REFRESH_LEAD_MS } from "./src/context.mjs"
import { makeConfig } from "./src/hooks/config.mjs"
import { makeMethods } from "./src/hooks/methods.mjs"
import { makeRefresh } from "./src/hooks/refresh.mjs"
import { makeLoader } from "./src/hooks/loader.mjs"
import { makeUsage } from "./src/hooks/usage.mjs"
import { makeCheckin } from "./src/hooks/checkin.mjs"
import { makeModels } from "./src/hooks/models.mjs"
import { makeHeaders } from "./src/hooks/headers.mjs"

function buildPlugin(c) {
  return async () => ({
    config: makeConfig(c),

    auth: {
      provider: c.PROVIDER,
      icon: c.ICON,
      maxConcurrency: 4,
      refreshLead: REFRESH_LEAD_MS,

      methods: makeMethods(c),
      refresh: makeRefresh(c),
      loader: makeLoader(c),
      usage: makeUsage(c),
      checkin: makeCheckin(c),
    },

    provider: {
      id: c.PROVIDER,
      models: makeModels(c),
    },

    "chat.headers": makeHeaders(c),
  })
}

export const TrustokenAuthPlugin = buildPlugin(ctx)

// 供测试引用（⚠ 入口不要导出其它「像插件的对象」，否则会被 magpie 当插件加载）
export const _internal = { buildPlugin, ctx }
