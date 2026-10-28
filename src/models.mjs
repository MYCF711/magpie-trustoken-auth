// src/models.mjs —— 把 /v1/models 的原始条目转成 magpie 要的形状
//
// 三条实测规则：
//   ① 模型级错误用 404，不要 401（401 会停整个账号）
//   ② 图片能力按 trustoken 自己声明的 modalities 写死：声明里没有 image 就 false
//   ③ 上下文窗口：trustoken /v1/models 对 6 个模型返回 1e11（1000 亿）这类占位值，
//      不能直接用；超过 10M 的一律按静态表（1M / 256K）截断。

import { MODELS, modelEntry, BASE } from "./context.mjs"
import { rateOf } from "./rates.mjs"

const STATIC_CONTEXT = new Map(MODELS.map(([id, , ctx]) => [id, ctx]))
const STATIC_VISION = new Map(MODELS.map(([id, , , vision]) => [id, !!vision]))
const STATIC_NAME = new Map(MODELS.map(([id, name]) => [id, name]))

/** 不像 chat 模型的 id：embedding / rerank / 语音 —— 列出来选中必报错 */
const NOT_CHAT = /embed|rerank|tts|whisper|asr/i

/** 生图模型：chat 列表里不列（选中必 400） */
const IMAGE_LIKE = /(^|[-_/])(image|imagen|imagine|dall-e|flux|seedream|cogview|sdxl|stable-diffusion|wanx|kolors|hidream|banana)/i

export function isUsable(m) {
  const id = String(m?.id ?? "")
  if (!id) return false
  if (NOT_CHAT.test(id)) return false
  if (IMAGE_LIKE.test(id)) return false
  const tags = Array.isArray(m?.tags) ? m.tags : []
  if (tags.some((t) => /vip|lock|pay|premium/i.test(String(t?.value ?? t)))) return false
  return true
}

/**
 * 把上游的 features 翻成「能收图吗」。
 * trustoken 的 modalities.input 里有 image 才算；没写 / 没有 features 一律 false。
 * 这正好满足本项目的一条硬约定：deepseek-flash 官方支持图片，但 trustoken 没开，
 * 写 false 就不会把图片发出去（发出去会被路由到 glm-5.3-flash，见 README）。
 */
export function visionOf(m) {
  const mods = m?.features?.modalities?.input
  if (Array.isArray(mods)) return mods.includes("image")
  return STATIC_VISION.get(String(m?.id ?? "")) === true
}

/** 上下文：超过 10M 视为占位值，退回静态表 */
export function contextOf(m) {
  const raw = Number(m?.features?.limit?.context)
  if (Number.isFinite(raw) && raw > 0 && raw <= 10_000_000) return raw
  return STATIC_CONTEXT.get(String(m?.id ?? "")) ?? 1_000_000
}

export function nameOf(m) {
  return String(m?.name ?? STATIC_NAME.get(String(m?.id ?? "")) ?? m?.id ?? "")
}

/**
 * 组装 magpie 的模型表。
 * @param {object[]} live  /v1/models 的 data
 * @param {(id:string,name:string,vision:boolean,opts:object)=>object} entry
 */
export function buildModels(live, entry = modelEntry) {
  const out = {}
  for (const m of live || []) {
    if (!isUsable(m)) continue
    const id = String(m.id)
    const rate = rateOf(id).input
    out[id] = entry(id, nameOf(m), visionOf(m), { context: contextOf(m), rate })
  }
  return out
}

/**
 * 静态表 + 动态表合并：动态里有的用动态（补上静态里缺的模型）。
 * 这样账号没权限的模型不会凭空冒出来，接口抖动也不会把列表清空。
 */
export function mergeModels(live) {
  const out = {}
  for (const [id, name, context, vision] of MODELS) {
    out[id] = modelEntry(id, name, vision, { context, rate: rateOf(id).input })
  }
  for (const [id, model] of Object.entries(buildModels(live))) {
    out[id] = model
  }
  return out
}

export { modelEntry, BASE }
