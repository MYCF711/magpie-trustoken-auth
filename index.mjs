// 爱派 AiPy · magpie 供应商插件
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
import { setInviteOptionReader, INVITE_FIRST_OPTION } from "./src/invite.mjs"
import { makeConfig } from "./src/hooks/config.mjs"
import { makeMethods } from "./src/hooks/methods.mjs"
import { makeRefresh } from "./src/hooks/refresh.mjs"
import { makeLoader } from "./src/hooks/loader.mjs"
import { makeUsage } from "./src/hooks/usage.mjs"
import { makeCheckin } from "./src/hooks/checkin.mjs"
import { makeModels } from "./src/hooks/models.mjs"
import { makeHeaders } from "./src/hooks/headers.mjs"

function buildPlugin(c) {
  // magpie 会把插件工厂当 `(input) => plugin` 调用；input 里带着宿主能力。
  // input 可能是 undefined（老 magpie / 测试直接调工厂），一律可选链。
  return async (input) => {
    // 把「怎么读这个供应商的开关」交给 invite.mjs —— 邀请码模式靠它。
    // ⚠ 必须传**读取函数**而不是读一次存下来：magpie 的 option 拨一下立刻生效，
    //   每次读才是当前值（providers.go 的 setProviderOptions 不重启 host）。
    setInviteOptionReader(c.PROVIDER, (key) => input?.magpie?.option?.(c.PROVIDER, key) === true)

    return {
      config: makeConfig(c),

      auth: {
        provider: c.PROVIDER,
        icon: c.ICON,
        maxConcurrency: 4,
        refreshLead: REFRESH_LEAD_MS,

        // 供应商编辑器里的「插件选项」：只有一个布尔开关（magpie 的 PluginOptions 只支持 bool）。
        // 开 = 固定用当前邀请码；关 = 跟随最后一个登录 / 签到的账号（默认，滚动码）。
        options: [
          {
            key: INVITE_FIRST_OPTION,
            label: "邀请码固定不滚动",
            description:
              "开：新号注册固定使用当前邀请码（默认作者码），不跟随登录 / 签到变化。关：跟随最后一个登录 / 签到的账号（默认）。",
            default: false,
          },
        ],

        // getter：每次 magpie 问 providers 都按「本机有没有账号」重新算登录入口
        // （host.js:1881 的 methods(auth) 每次 RPC 都会读 auth.methods）。
        // 即便某个 magpie 版本把列表缓存住了，下载入口的 authorize() 里还有行为层兜底。
        get methods() {
          return makeMethods(c)
        },
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
