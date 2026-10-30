// 邀请码 —— 学超级麦吉 0.3.32 的「邀请上级」实现
//
// 三份缓存，全在 ~/.cache/magpie（可整目录删，删了退回内置的推荐码）：
//   trustoken-invite.json          下一次注册带谁的码（滚动的）
//   trustoken-invite-policy.json   邀请上级策略：auto / custom（fixed 是旧版本留下的）
//   trustoken-invite-codes.json    见过哪些账号的码（登录 / 签到时记下来）
//
// Trustoken 的邀请码字段是 `/api/user/self` 的 `aff_code`，注册时字段名是 `aff_code`。
//
// ⚠ 只读**本插件自己的缓存**，不读 magpie 的私有文件。
//   旧版本会直接读 magpie 的私有账号文件去认「magpie 首选账号」，社区 review 指出
//   「A plugin gets its own credentials through the hooks」—— 已删。账号自己的码只能
//   从钩子拿（auth.checkin 里用该账号的 token 调 /api/user/self，见 rollInvite），
//   或者由用户显式填。
//   （唯一例外是 src/accounts.mjs 读 magpie 的账号表判断「本机有没有账号」——
//     那是「有没有」的存在性判断，不取任何账号身份。）

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

/**
 * 这次注册该带的码。
 *
 * 「magpie 首选账号」那套已删除：插件在钩子外面拿不到
 * 「哪个账号是首选」—— `getAuth()` 只给当前账号，`auth.methods` 不给任何账号信息。
 * 现在只有两种来源：用户显式指定的码（fixed / custom），或滚动码（auto，跟随最近
 * 登录 / 签到的那个号，那个码是 rollInvite() 用账号自己的 token 记下来的）。
 */
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

export function modeHint() {
  const pol = readInvitePolicy()
  if (pol.mode === "fixed" || pol.mode === "custom") return `当前：填了码 ${pol.code}（留空 = 自动）`
  return "留空 = 自动（跟随最近登录 / 签到的号）；也可直接填一个邀请码"
}

/** 登录弹窗里那一问的答案：留空 / 0 = 自动，其它 = 用户显式指定的邀请码 */
export function saveInviteChoice(raw) {
  const t = String(raw ?? "").trim()
  if (t && t !== "0" && t !== "1") {
    writeInvitePolicy({ mode: "custom", code: t })
    return
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
  // magpie 账号表的读法与口径只在 src/accounts.mjs 一处（登录方式分流也用同一份）
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
