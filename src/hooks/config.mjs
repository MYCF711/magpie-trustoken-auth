// ① config(cfg) —— 声明 provider 与静态模型表
//
// 未登录时 magpie 也会渲染供应商卡片；models 不能为空。

import { staticModels } from "../context.mjs"

export function makeConfig(c) {
  return async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[c.PROVIDER] ??= {
      name: c.PROVIDER_NAME,
      npm: c.SDK,
      api: c.BASE,
      models: staticModels(),
    }
  }
}
