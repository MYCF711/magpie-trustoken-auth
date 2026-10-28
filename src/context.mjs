// 共享上下文 —— Trustoken（AiPy）供应商的全部常量
//
// 插件里的每个钩子都只读这一份。改厂商信息只改这里。

/** 厂商 id：agent 用 `<id>/<model>` 命名 */
export const PROVIDER = "trustoken"

/** 卡片上显示的供应商名 */
export const PROVIDER_NAME = "Trustoken（AiPy）"

/** 模型网关：OpenAI 兼容 */
export const BASE = "https://api.trustoken.cn/v1"

/** 网页 / 账号 API 根：签到、额度、令牌管理都在这里 */
export const WEB = "https://www.trustoken.cn"

/** SDK 决定 API 形状 */
export const SDK = "@ai-sdk/openai-compatible"

/** 账号 token 30 天有效；提前 1 天续 */
export const REFRESH_LEAD_MS = 24 * 60 * 60 * 1000

/** 每 1 元人民币对应的 quota（来自 /api/status 的 quota_per_unit） */
export const QUOTA_PER_CNY = 500_000

/** 100 灵石 = 1 元，即 1 灵石 = 5000 quota */
export const QUOTA_PER_STONE = 5_000

/** 签到窗口：北京时间 08:00–22:00 */
export const CHECKIN_WINDOW = { startHour: 8, endHour: 22 }

/** 图标 —— auth.icon 与 package.json 的 magpie.icon 必须一致 */
export const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMWYyOTM3Ii8+PHBhdGggZD0iTTMyIDQ4cTMyLTMwIDY0IDB2MzJxLTMyIDMwLTY0IDB6IiBmaWxsPSIjNjBhNWZhIi8+PGNpcmNsZSBjeD0iNjQiIGN5PSI2NCIgcj0iMTQiIGZpbGw9IiMxZjI5MzciLz48L3N2Zz4="

/**
 * 模型表 —— [id, 显示名, 上下文窗口, 是否图片输入]
 *
 * 上下文窗口是**保守值**，不是官方标称值的复读：
 *   - DeepSeek V4.1 Flash / V4 Pro：1M 上下文、384K 输出
 *   - Qwen 3.8 系：1M
 *   - GLM 5.x：1M
 *   - Kimi K3：1M
 *   - 豆包 Seed 2.1：256K
 *   - 混元 3：256K；混元 4 Preview：1M
 *   - MiMo v2.5 Pro：256K
 *
 * ⚠ 图片输入按 trustoken 的 `/v1/models` 声明写死：
 *   只有 qwen3.8-flash 与 kimi/kimi-k3 标了 image。
 *   deepseek-flash 虽然官方支持图片，但 trustoken 这边没开（实测带图会被路由到
 *   glm-5.3-flash）—— 所以这里写 false，绝不把图片发出去。
 */
export const MODELS = [
  ["auto", "Auto（动态优选）", 1_000_000, false],
  ["deepseek-flash", "DeepSeek V4.1 Flash", 1_000_000, false],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, false],
  ["qwen3.8-flash", "Qwen 3.8 Flash", 1_000_000, true],
  ["qwen3.8-max", "Qwen 3.8 Max", 1_000_000, false],
  ["glm-5.3-flash", "GLM 5.3 Flash", 1_000_000, false],
  ["glm-5.2", "GLM 5.2", 1_000_000, false],
  ["Doubao-Seed-2.1-Turbo", "Doubao Seed 2.1 Turbo", 256_000, false],
  ["Doubao-Seed-2.1-Pro", "Doubao Seed 2.1 Pro", 256_000, false],
  ["hy3", "Hunyuan 3", 256_000, false],
  ["hy4-preview", "Hunyuan 4 Preview", 1_000_000, false],
  ["kimi/kimi-k3", "Kimi K3", 1_048_576, true],
  ["xiaomi/mimo-v2.5-pro", "MiMo v2.5 Pro", 256_000, false],
]

import { rateOf } from "./rates.mjs"

/** 模型条目的统一工厂 */
export function modelEntry(id, name, vision, { rate = 0, context = 0 } = {}) {
  return {
    id,
    name,
    api: { id, url: BASE, npm: SDK },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: context || 1_000_000, output: Math.min(384_000, context || 1_000_000) },
    capabilities: {
      temperature: true,
      reasoning: true,
      toolcall: true,
      attachment: !!vision,
      input: { text: true, image: !!vision, audio: false, video: false, pdf: false },
      output: { text: true },
    },
    ...(Number(rate) > 0 ? { rate: Number(rate) } : {}),
  }
}

/** 静态模型表（未登录 / 拉取失败时兜底） */
export function staticModels() {
  const out = {}
  for (const [id, name, context, vision] of MODELS) {
    out[id] = modelEntry(id, name, vision, { context, rate: rateOf(id).input })
  }
  return out
}

/** 框里所有小插头拿到的同一份上下文 */
export const ctx = {
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  WEB,
  SDK,
  ICON,
  REFRESH_LEAD_MS,
  QUOTA_PER_CNY,
  QUOTA_PER_STONE,
  CHECKIN_WINDOW,
  MODELS,
  staticModels,
}
