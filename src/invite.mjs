// 邀请码 —— 学超级麦吉 0.3.32 的「邀请上级」实现
//
// 三份缓存，全在 ~/.cache/magpie（可整目录删，删了退回作者码）：
//   trustoken-invite.json          下一次注册带谁的码（滚动的）
//   trustoken-invite-policy.json   邀请上级策略：auto / fixed / custom
//   trustoken-invite-codes.json    见过哪些账号的码（登录时下拉框用）
//
// Trustoken 的邀请码字段是 `/api/user/self` 的 `aff_code`（当前账号是 "Chdr"），
// 注册时字段名是 `aff_code`（`POST /api/user/register/mobile`）。

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fetchSelf } from "./api.mjs"
import { isKnownUid } from "./accounts.mjs"

/** 作者（本仓库维护者 MYCF711）的 Trustoken 邀请码；可用环境变量覆盖 */
export const AUTHOR_INVITE = String(process.env.TRUSTOKEN_INVITE || "Chdr").trim()

function cacheDir() {
  return join(homedir(), ".cache", "magpie")
}

const INVITE_FILE = () => join(cacheDir(), "trustoken-invite.json")
const POLICY_FILE = () => join(cacheDir(), "trustoken-invite-policy.json")
const CODES_FILE = () => join(cacheDir(), "trustoken-invite-codes.json")

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8")) ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

// ── 滚动码 ────────────────────────────────────────────────────────────

export function readInvite() {
  const v = readJson(INVITE_FILE(), null)
  return typeof v?.code === "string" ? v.code.trim() : ""
}

export function writeInvite(code) {
  const c = String(code || "").trim()
  if (!c) return ""
  writeJson(INVITE_FILE(), { code: c, at: new Date().toISOString() })
  return c
}

// ── 邀请上级策略（0.3.32 那套） ──────────────────────────────────────

export function readInvitePolicy() {
  const v = readJson(POLICY_FILE(), null)
  const mode = ["auto", "fixed", "custom"].includes(v?.mode) ? v.mode : "auto"
  return {
    mode,
    code: String(v?.code || "").trim(),
    accountId: String(v?.accountId || "").trim(),
    uid: String(v?.uid || "").trim(),
    at: String(v?.at || ""),
  }
}

export function writeInvitePolicy(policy) {
  const mode = ["auto", "fixed", "custom"].includes(policy?.mode) ? policy.mode : "auto"
  writeJson(POLICY_FILE(), {
    mode,
    code: String(policy?.code || "").trim(),
    accountId: String(policy?.accountId || "").trim(),
    uid: String(policy?.uid || "").trim(),
    at: new Date().toISOString(),
  })
}

export function clearInvitePolicy() {
  try {
    unlinkSync(POLICY_FILE())
  } catch {}
}

/** 这次注册该带的码：锁定策略 → 滚动记录 → 作者码 */
export function inviteToUse(locked = true) {
  if (locked) {
    const pol = readInvitePolicy()
    if ((pol.mode === "fixed" || pol.mode === "custom") && pol.code) return pol.code
  }
  return readInvite() || AUTHOR_INVITE
}

export function authorInvite() {
  return AUTHOR_INVITE
}

/** magpie 账号页「首选」那个 trustoken 账号自己的邀请码 */
export function preferredInvite() {
  try {
    const logins = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "logins.json"), "utf8"))
    const rows = (Array.isArray(logins) ? logins : []).filter((r) => r && r.agent === "plugin:trustoken" && r.home)
    if (!rows.length) return null
    const first =
      rows.find((r) => r.first === true) ||
      rows.filter((r) => Number(r.order) > 0).sort((a, b) => Number(a.order) - Number(b.order))[0] ||
      rows[0]
    const auth = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))?.[String(first.home || "")]
    const uid = String(auth?.uid || "").trim()
    if (!uid) return null
    const v = readAccountCodes()[uid]
    if (!v?.code) return null
    return { code: v.code, accountId: String(v.accountId || uid), uid }
  } catch {
    return null
  }
}

export function modeHint() {
  const pol = readInvitePolicy()
  if (pol.mode === "auto" || !pol.code) return "当前模式：自动，输入 1 切换：首选"
  return "当前模式：首选，输入 0 切换：自动"
}

export function saveInviteChoice(raw) {
  const t = String(raw ?? "").trim()
  if (t === "1") {
    const pick = preferredInvite()
    if (pick) {
      writeInvitePolicy({ mode: "fixed", code: pick.code, accountId: pick.accountId, uid: pick.uid })
      return
    }
  }
  writeInvitePolicy({ mode: "auto" })
}

// ── 见过哪些账号的码 ─────────────────────────────────────────────────

export function readAccountCodes() {
  const v = readJson(CODES_FILE(), {})
  return v && typeof v === "object" ? v : {}
}

export function isKnownAccount(uid) {
  const u = String(uid || "").trim()
  if (!u) return false
  if (readAccountCodes()[u]) return true
  // plugin-auth.json 的读法与口径只在 src/accounts.mjs 一处（登录方式分流也用同一份）
  return isKnownUid(u)
}

export function noteAccountCode(key, code, accountId = "") {
  const k = String(key || "").trim()
  const c = String(code || "").trim()
  if (!k || !c) return
  const all = readAccountCodes()
  all[k] = { code: c, accountId: String(accountId || ""), at: new Date().toISOString() }
  writeJson(CODES_FILE(), all)
}

// ── 滚动：登录成功 / 每日签到时，把当前账号自己的码记下来 ─────────────

/** 最多等 6 秒 —— 登录/签到不能被它拖死 */
const INVITE_TIMEOUT_MS = 6000

export async function rollInvite(auth, { roll = true } = {}) {
  const token = auth?.accountToken || auth?.refresh
  if (!token) return ""
  try {
    const self = await Promise.race([
      fetchSelf(token, auth.uid),
      new Promise((_, reject) => setTimeout(() => reject(new Error("超时")), INVITE_TIMEOUT_MS)),
    ])
    const code = String(self?.aff_code || "").trim()
    if (!code) return ""
    if (roll) writeInvite(code)
    noteAccountCode(auth.uid || auth.accountId, code, auth.accountId || self?.username || "")
    return code
  } catch {
    // 滚动失败不影响登录 / 签到
    return ""
  }
}

// ── 给 UI 用的文案与选项 ─────────────────────────────────────────────

export function describePolicy(pol = readInvitePolicy(), locked = true) {
  if (!locked) return "自动（锁定已关闭）"
  if (pol.mode === "fixed" && pol.code) return (pol.accountId || "指定账号") + "（" + pol.code + "）"
  if (pol.mode === "custom" && pol.code) return "自定义码 " + pol.code
  return "自动（跟随最后一个登录 / 签到的号）"
}

export function inviteTag(getLock = () => true) {
  if (getLock() === false) return ""
  const pol = readInvitePolicy()
  if (pol.mode === "fixed" && pol.code) return `（上级 ${pol.accountId || pol.code}）`
  if (pol.mode === "custom" && pol.code) return `（上级 ${pol.code}）`
  return ""
}

/** prompts 的 options 必须同步生成 —— 这里只读缓存，不发网络请求 */
export function inviteChoices(getLock = () => true) {
  const pol = readInvitePolicy()
  const codes = readAccountCodes()
  const author = AUTHOR_INVITE
  const locked = getLock() !== false
  const out = []
  if (author) {
    out.push({
      label: `我的（作者 MYCF711）：${author}`,
      value: "__author__",
      hint: locked && pol.mode === "fixed" && pol.code === author ? "当前" : "作者码",
    })
  }
  out.push({
    label: "自动（跟随最后一个登录 / 签到的号）",
    value: "__auto__",
    hint: locked && pol.mode === "auto" ? "当前" : "会漂移",
  })
  for (const [key, v] of Object.entries(codes)) {
    if (!v?.code || v.code === author) continue
    out.push({
      label: `${v.accountId || key}（${v.code}）`,
      value: v.code,
      hint: locked && pol.mode === "fixed" && pol.code === v.code ? "当前固定" : key,
    })
  }
  return out
}
