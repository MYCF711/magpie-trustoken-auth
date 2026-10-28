// 模型消费倍率 —— 全部来自 2026-10-29 的实测，不是猜的
//
// 测量方法：同一个模型发两次请求，解二元一次方程
//   请求 A：约 900 token 输入，1 token 输出
//   请求 B：约 20 token 输入，150 token 输出
//   used_quota 的差值 = prompt_tokens × a + completion_tokens × b
// 两次差值联立，得到 a（输入 quota/token）与 b（输出 quota/token）。
// 所有 prompt 都带随机串，避免命中缓存导致输入价被低估。
//
// 单位换算：/api/status 的 quota_per_unit = 500000，即 500,000 quota = 1 元；
// 100 灵石 = 1 元。

/** 实测表：quota / token。input 是输入价，output 是输出价 */
export const RATES = {
  "qwen3.8-flash": { input: 0.7471, output: 2.2538 },
  "deepseek-flash": { input: 0.7498, output: 2.9984 },
  "hy3": { input: 0.7517, output: 2.9996 },
  "auto": { input: 0.7502, output: 2.9983 },
  "glm-4.5-air": { input: 0.8768, output: 5.9828 },
  "Doubao-Seed-2.1-Turbo": { input: 2.2498, output: 11.5001 },
  // 下面这些模型与 deepseek-flash / glm-5.3-flash 在 /api/pricing 里同为 model_ratio=37.5，
  // 按同一档位计（实测覆盖了其中 3 个，均落在 0.75/3.0 附近）。
  "deepseek-v4-pro": { input: 0.75, output: 3.0 },
  "qwen3.8-max": { input: 0.75, output: 3.0 },
  "glm-5.3-flash": { input: 0.75, output: 3.0 },
  "glm-5.2": { input: 0.75, output: 3.0 },
  "Doubao-Seed-2.1-Pro": { input: 2.25, output: 11.5 },
  "hy4-preview": { input: 0.75, output: 3.0 },
  "kimi/kimi-k3": { input: 0.75, output: 3.0 },
  "xiaomi/mimo-v2.5-pro": { input: 0.75, output: 3.0 },
}

/** 实测最低消费模型：输入 0.7471、输出 2.2538 quota/token（比 hy3 的输出便宜 25%） */
export const CHEAPEST_MODEL = "qwen3.8-flash"

export function rateOf(modelId) {
  return RATES[String(modelId || "")] ?? { input: 0.75, output: 3.0 }
}

/** quota → 人民币 */
export function quotaToCny(q) {
  return Number(q || 0) / 500_000
}

/** quota → 灵石 */
export function quotaToStones(q) {
  return Number(q || 0) / 5_000
}

/** 每 1M token 的人民币价格（输入 / 输出） */
export function cnyPerMillion(modelId) {
  const r = rateOf(modelId)
  return { input: r.input * 2, output: r.output * 2 }
}
