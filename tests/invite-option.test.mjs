// tests/invite-option.test.mjs —— 「邀请码固定不滚动」布尔开关（0.3.10）
//
// 学 magicrew 的形式：登录页不再问邀请码文本框，改成 magpie 供应商编辑器里的
// 一个 Off/On（`auth.options`）。magpie 的 PluginOptions 只支持布尔
// （map[provider]map[key]bool），装不下「选一个账号」或「填一个字符串」。
//
//   node --test

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "trustoken-invite-option-"))
  const oldProfile = process.env.USERPROFILE
  const oldHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
  try {
    return await fn(home)
  } finally {
    if (oldProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = oldProfile
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }
}

test("① 开关默认关：跟随滚动码；没有滚动码时退回作者码", async () =>
  withHome(async () => {
    const { inviteToUse, readInvite, writeInvite, authorInvite, setInviteOptionReader } = await import("../src/invite.mjs")
    setInviteOptionReader("trustoken", () => false)
    assert.equal(inviteToUse(), authorInvite(), "没有滚动码时应退回作者码")
    writeInvite("ROLL-123")
    assert.equal(readInvite(), "ROLL-123")
    assert.equal(inviteToUse(), "ROLL-123", "开关关 = 跟随滚动码")
  }))

test("② 开关打开：固定用当前码（有 fixed/custom 策略用它，否则作者码）", async () =>
  withHome(async () => {
    const { inviteToUse, writeInvite, writeInvitePolicy, authorInvite, setInviteOptionReader, INVITE_FIRST_OPTION } = await import("../src/invite.mjs")
    writeInvite("ROLL-999")
    setInviteOptionReader("trustoken", (k) => k === INVITE_FIRST_OPTION)
    assert.equal(inviteToUse(), authorInvite(), "没有指定码时用作者码，而不是滚动码")
    writeInvitePolicy({ mode: "custom", code: "FIX-777" })
    assert.equal(inviteToUse(), "FIX-777", "有指定码时固定用它")
  }))

test("③ 读不到 / 读抛错一律当关（保持默认滚动，不静默改道）", async () =>
  withHome(async () => {
    const { inviteToUse, writeInvite, setInviteOptionReader } = await import("../src/invite.mjs")
    writeInvite("ROLL-ABC")
    setInviteOptionReader("trustoken", () => {
      throw new Error("magpie 老版本没有 option")
    })
    assert.equal(inviteToUse(), "ROLL-ABC", "读开关抛错时必须退回滚动码")
  }))

test("④ index.mjs 声明 auth.options，并把 input.magpie.option 接给 inviteToUse", async () =>
  withHome(async () => {
    const { writeInvite } = await import("../src/invite.mjs")
    const { TrustokenAuthPlugin } = await import("../index.mjs")
    writeInvite("ROLL-555")

    const on = await TrustokenAuthPlugin({ magpie: { option: (provider, key) => provider === "trustoken" && key === "invite-first" } })
    assert.ok(Array.isArray(on.auth.options), "auth.options 必须是数组")
    const opt = on.auth.options.find((o) => o.key === "invite-first")
    assert.ok(opt, "必须有 invite-first 开关")
    assert.equal(opt.default, false, "默认关闭")
    assert.equal(typeof opt.label, "string")
    assert.ok(opt.label.length > 0)
    assert.equal(typeof opt.description, "string")
    assert.ok(opt.description.length > 0)
    const { inviteToUse, authorInvite } = await import("../src/invite.mjs")
    assert.equal(inviteToUse(), authorInvite(), "开关开 = 固定码（不是滚动码）")

    const off = await TrustokenAuthPlugin({ magpie: { option: () => false } })
    assert.ok(off.auth.options.length >= 1)
    assert.equal(inviteToUse(), "ROLL-555", "开关关 = 滚动码")

    // 老 magpie / 测试不传 input 时也不能炸
    const bare = await TrustokenAuthPlugin()
    assert.ok(bare.auth.options.length >= 1)
  }))

test("⑤ 登录页不再有邀请码输入框：手机号入口只问 phone", async () => {
  const { makeMethods } = await import("../src/hooks/methods.mjs")
  const methods = makeMethods(
    { PROVIDER: "trustoken", PROVIDER_NAME: "Trustoken（AiPy）" },
    { hasAccounts: () => false, readToken: async () => null },
  )
  const phone = methods.find((m) => /手机号/.test(m.label))
  assert.ok(phone)
  assert.deepEqual(phone.prompts.map((p) => p.key), ["phone"], "只保留手机号一个 prompt（邀请码交给开关）")
})
