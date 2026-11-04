// src/ua.mjs —— 全插件唯一的 User-Agent 常量
//
// 官方客户端是 AiPy Pro 桌面版（Electron）。服务端只认 UA 里的 `aipy-pro/<版本>`
// 应用标识：不带它的请求在注册链上直接回「新增账号需下载AiPy Pro客户端」。
//
// 本插件**每一处**出站请求都用这同一个值：
//   src/api.mjs            账号 API / 模型网关（headersFor）
//   src/hooks/loader.mjs   聊天请求的头（magpie 用它发上游）
//   src/browser-login.mjs  受控浏览器启动参数 + CDP 请求层覆盖
//   src/oauth.mjs          补签 authorize（UA 由调用方从 aipyUserAgent() 传入）
//
// 不要在别处再拼一份，更不要写成 `magpie-*` 形态：上游网关按 `<product>/<version>`
// 认第三方客户端，命中即 403。

/** AiPy Pro 客户端版本；与官方客户端同款，改它要连同 docs/internals.md 的基线一起改 */
export const AIPY_APP_VERSION = "2.1.1"

/**
 * AiPy 客户端同款 UA（文档第 1 节：服务端只认 `aipy-pro/*`）。
 * 平台段取运行时真实的 platform/arch —— Electron 应用自己报的就是这个形状。
 */
export function aipyUserAgent() {
  return `Mozilla/5.0 (${process.platform}; ${process.arch}) AppleWebKit/537.36 (KHTML, like Gecko) aipy-pro/${AIPY_APP_VERSION} Chrome/134.0.6998.179 Electron/34.3.3 Safari/537.36`
}

/** 一次算好：请求头里直接用这个常量，别每个请求重拼 */
export const AIPY_UA = aipyUserAgent()
