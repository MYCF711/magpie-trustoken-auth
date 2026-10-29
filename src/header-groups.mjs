// 每个账号一组「请求头构成的信息源」：安装渠道 referral + 版本/平台 + 自己的邀请码
//
// 请求头不是写死的：默认取 189 账号那一组（本地 AiPy 的 referral 文件 + 189 的
// aff_code），登录新号成功后把新号这一组落盘，按 uid 绑定。

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

export function readReferral() {
  try {
    const p = join(APPDATA(), "aipy-pro", "referral")
    if (!existsSync(p)) return ""
    return readFileSync(p, "utf8").trim()
  } catch { return "" }
}

function read189Auth() {
  try {
    const p = join(homedir(), ".config", "magpie", "plugin-auth.json")
    const all = JSON.parse(readFileSync(p, "utf8"))
    for (const [k, v] of Object.entries(all || {})) {
      if (k === "trustoken" || k.startsWith("trustoken#")) {
        if (v?.accountId && String(v.accountId).startsWith("189")) return v
      }
    }
    const first = Object.entries(all || {}).find(([k]) => k === "trustoken" || k.startsWith("trustoken#"))
    return first?.[1] || null
  } catch { return null }
}

export function readGroups() {
  const v = readJson(FILE(), {})
  return v && typeof v === "object" ? v : {}
}

export function defaultGroup() {
  const all = readGroups()
  if (all.default) return all.default
  const auth = read189Auth()
  const g = {
    uid: String(auth?.uid || "182238"),
    accountId: String(auth?.accountId || "189****8051"),
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

export function groupFor(uid) {
  const all = readGroups()
  return (uid && all.accounts?.[String(uid)]) || defaultGroup()
}

/** 按邀请策略选这次注册用的 header 组：首选 → 该账号组；自动 → 滚动码所属账号组，没有则 189 默认组 */
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
  if (!all.default) all.default = g
  writeJson(FILE(), all)
  return g
}

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
