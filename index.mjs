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
  return async (input) => {
    // magpie 的 optionValues()：用户在 provider 设置里改的开关，实时读。
    // ⚠ 用 options(provider) 而不是 option(provider,key)：后者对「还不知道的
    // 选项」也返回 false，插件加载早期会把默认 true 误判成关闭。
    const getLock = () => {
      const vals = input?.magpie?.options?.(c.PROVIDER)
      if (vals && Object.prototype.hasOwnProperty.call(vals, "inviteLock")) {
        return vals.inviteLock !== false
      }
      return true
    }

    return {
      config: makeConfig(c),

      auth: {
        provider: c.PROVIDER,
        icon: c.ICON,
        maxConcurrency: 4,
        refreshLead: REFRESH_LEAD_MS,

        options: [
          {
            key: "inviteLock",
            label: "锁定邀请上级（签到不再覆盖）",
            description:
              "打开：新号固定挂在选定的邀请码下；关闭：跟随最后一个登录 / 签到的账号（会漂移）。",
            default: true,
          },
        ],

        methods: makeMethods(c, getLock),
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
    }
  }
}

export const TrustokenAuthPlugin = buildPlugin(ctx)

// 供测试引用（⚠ 入口不要导出其它「像插件的对象」，否则会被 magpie 当插件加载）
export const _internal = { buildPlugin, ctx }
