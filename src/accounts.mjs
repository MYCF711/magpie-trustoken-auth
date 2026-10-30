// src/accounts.mjs —— 读 magpie 本机账号表（只读）
//
// 为什么只能读文件：magpie **没有**给插件「账号列表」的 API。
//   · `auth.loader/usage/checkin(getAuth, provider)` 的 getAuth() 只给**当前账号**；
//   · `auth.methods` 不带任何参数；插件工厂拿到的 input 里也没有账号
//     （internal/plugin/host.js:1210-1224 的 `{ client, project, directory, worktree,
//       serverUrl, $, magpie: { option, options } }`）。
//
// magpie 自己的账号列表就存在 `~/.config/magpie/plugin-auth.json`：
//   internal/plugin/providers.go:632 每次 `Cached()` 都 `p.Accounts = accountsOf(readAuth(), p.ID)`，
//   `accountsOf`（:686-707）按 `ProviderOf(key) == provider` 过滤 ⇒ 本插件是
//   `trustoken` 与 `trustoken#<slot>` 两组 key。
// 所以插件侧唯一可靠口径 = **只读**这个文件，且口径与 magpie 完全一致。
//
// ⚠ 读失败一律按「有账号」处理 —— 宁可少显示下载入口，也**不要**把下载链接挡在
//   有账号的人面前（主人的原话：有账号就不应该弹出下载安装包连接）。
//   本仓库 src/invite.mjs 的 isKnownAccount() 早就在读同一个文件（老做法），这里把它
//   收成一处；两个调用点（邀请码滚动、登录方式分流）共用同一口径。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * magpie 的数据目录，口径照 internal/appdir/appdir.go:226-234 的 `Config()`：
 *   XDG_CONFIG_HOME（绝对路径）/magpie → ~/.config/magpie
 * ⚠ portable 模式（exe 旁边带数据）插件侧拿不到 magpie 的 exe 路径，无法还原；
 *   但 portable 用户的账号也不会写进 ~/.config/magpie —— 这是已知限制，写进 AGENTS 坑 28。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function magpieConfigDir(env = process.env) {
  const xdg = String(env?.XDG_CONFIG_HOME || "")
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(xdg)) return join(xdg, "magpie")
  return join(homedir(), ".config", "magpie")
}

/**
 * 读 plugin-auth.json。
 * @returns {{ ok: true, store: Record<string, any> } | { ok: false, store: null }}
 *   ok=false 表示「不知道」（读不了 / 坏 JSON），与「文件不存在 = 0 个账号」不同。
 */
export function readAuthStore(dir = magpieConfigDir()) {
  let text
  try {
    text = readFileSync(join(dir, "plugin-auth.json"), "utf8")
  } catch (e) {
    // 文件不存在 = 这台机器还没有任何插件账号，就是 0 个
    if (e && e.code === "ENOENT") return { ok: true, store: {} }
    return { ok: false, store: null }
  }
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, store: null }
    return { ok: true, store: v }
  } catch {
    return { ok: false, store: null }
  }
}

/**
 * provider 的账号 key：`trustoken` 与 `trustoken#xxx`（与 magpie 的 accountsOf 同口径）。
 * @param {Record<string, any>} store
 * @param {string} provider
 * @returns {string[]}
 */
export function accountKeysOf(store, provider) {
  if (!store || !provider) return []
  return Object.keys(store).filter((k) => (k === provider || String(k).startsWith(`${provider}#`)) && store[k])
}

let warned = false

/**
 * 本机有没有该供应商的账号。
 * @param {string} provider
 * @param {{ dir?: string }} [opts]
 * @returns {boolean} 读不到就保守回 true（理由见文件头）
 */
export function hasAccounts(provider, opts = {}) {
  const { ok, store } = readAuthStore(opts.dir ?? magpieConfigDir())
  if (!ok) {
    if (!warned) {
      warned = true
      // 只喊一次：这个方法每次 providers RPC 都会被调
      console.warn(`[trustoken] 读不了 plugin-auth.json：按「已有账号」处理，不显示下载入口（${opts.dir ?? magpieConfigDir()}）`)
    }
    return true
  }
  return accountKeysOf(store, provider).length > 0
}

/**
 * uid 是否已经在本机 magpie 里（查重：避免把同一个号再「添加」一遍）。
 * 读不到时回 false —— 宁可不拦，也不要把正常导入挡掉。
 * @param {string|number} uid
 * @param {{ dir?: string }} [opts]
 * @returns {boolean}
 */
export function isKnownUid(uid, opts = {}) {
  const u = String(uid ?? "").trim()
  if (!u) return false
  const { ok, store } = readAuthStore(opts.dir ?? magpieConfigDir())
  if (!ok || !store) return false
  return Object.values(store).some((v) => String(v?.uid ?? "") === u)
}
