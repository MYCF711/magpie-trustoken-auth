// 每个账号一组「客户端请求头」：安装渠道 referral + 版本 / 平台
//
// ⚠ 这里**不放任何账号身份**。
//   旧版本的 defaultGroup() 在没有账号信息时把 uid / accountId 写死成维护者自己的账号
//   （写死成维护者自己账号的 uid / accountId），社区 review 明确指出那是「别人的账号身份」，已删。
//   现在 defaultGroup() 只给**客户端身份**（版本 / 平台 / 安装渠道）；某个账号自己那组
//   只在**这个账号真的登录过**之后由 saveGroup() 落盘、按 uid 取用 —— 取不到就用默认组，
//   绝不拿别人的账号顶上。
//
//   注：headersFromGroup() 从来只发 referral / 版本 / 平台，uid / accountId / affCode
//   都**不上网**，它们只是本地台账的键（所以「默认组」没有账号身份也不影响请求）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { AUTHOR_INVITE, readInvite, readInvitePolicy } from "./invite.mjs"

const FILE = () => join(homedir(), ".cache", "magpie", "trustoken-header-groups.json")
const APPDATA = () => process.env.APPDATA || (process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Roaming") : "")

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")) ?? fallback } catch { return fallback }
}
function writeJson(file, value) {
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); return true } catch { return false }
}

/** 本机 AiPy 安装时带的渠道码（用户自己机器上的那份文件，不是别人的账号） */
export function readReferral() {
  try {
    const p = join(APPDATA(), "aipy-pro", "referral")
    if (!existsSync(p)) return ""
    return readFileSync(p, "utf8").trim()
  } catch { return "" }
}

export function readGroups() {
  const v = readJson(FILE(), {})
  return v && typeof v === "object" ? v : {}
}

/**
 * 默认请求头组：**只有客户端身份，没有账号身份**。
 *
 * 旧文件里那份带 uid / accountId 的默认组（写死的维护者账号）在这里被丢掉重建 ——
 * 本机已有安装也会自愈。
 */
export function defaultGroup() {
  const all = readGroups()
  const d = all.default
  if (d && typeof d === "object" && !d.uid && !d.accountId) return d
  const g = {
    uid: "",
    accountId: "",
    referral: readReferral(),
    version: "2.1.1",
    appVersion: "0.5.0",
    platform: process.platform,
    arch: process.arch,
    affCode: AUTHOR_INVITE,
    at: new Date().toISOString(),
  }
  all.default = g
  writeJson(FILE(), all)
  return g
}

/** 某个账号自己的组（只有真的登录过才有）；没有就退回默认组 */
export function groupFor(uid) {
  const all = readGroups()
  return (uid && all.accounts?.[String(uid)]) || defaultGroup()
}

/** 按邀请策略选这次注册用的 header 组：显式指定的账号 → 滚动码所属账号 → 默认组 */
export function pickGroup() {
  const pol = readInvitePolicy()
  const all = readGroups()
  if ((pol.mode === "fixed" || pol.mode === "custom") && pol.uid) {
    if (all.accounts?.[String(pol.uid)]) return all.accounts[String(pol.uid)]
  }
  const rolling = readInvite()
  if (rolling) {
    const hit = Object.values(all.accounts || {}).find((g) => String(g.affCode || "") === rolling)
    if (hit) return hit
  }
  return defaultGroup()
}

/** 登录成功时把「这个账号自己的组」落盘（uid/accountId 一律来自真实登录结果） */
export function saveGroup({ uid, accountId, affCode, referral, version, appVersion, platform, arch }) {
  if (!uid) return
  const all = readGroups()
  const g = {
    uid: String(uid),
    accountId: String(accountId || ""),
    referral: String(referral || ""),
    version: String(version || "2.1.1"),
    appVersion: String(appVersion || "0.5.0"),
    platform: String(platform || process.platform),
    arch: String(arch || process.arch),
    affCode: String(affCode || ""),
    at: new Date().toISOString(),
  }
  all.accounts = all.accounts || {}
  all.accounts[g.uid] = g
  if (!all.default || all.default.uid || all.default.accountId) all.default = g
  writeJson(FILE(), all)
  return g
}

/** 真正上网的那几个头：只发客户端身份，不带账号身份、不带邀请码 */
export function headersFromGroup(g) {
  if (!g) return {}
  return {
    ...(g.referral ? { "X-AIPY-REFERRAL-CODE": g.referral } : {}),
    ...(g.version ? { "X-AIPY-VERSION": g.version } : {}),
    ...(g.appVersion ? { "X-AIPYAPP-VERSION": g.appVersion } : {}),
    ...(g.platform ? { "X-AIPY-PLATFORM": g.platform } : {}),
    ...(g.arch ? { "X-AIPY-ARCH": g.arch } : {}),
  }
}
