// tests/login-methods.test.mjs —— 锁住「登录入口按本机账号状态自动分流」
//
//   node --test
//
// 为什么要有这一组：
//   · 主人原话：有账号就不应该弹出下载安装包连接；添加账号要插件自己判断。
//   · magpie **没有**给插件账号列表 API，只能只读 ~/.config/magpie/plugin-auth.json
//     （口径见 src/accounts.mjs 文件头）。
//   · magpie 在插件加载时会把 methods[].label 读走缓存（magicrew AGENTS 坑 31），
//     所以「列表随账号状态变化」不能只靠 label；还必须有一条**行为层兜底**：
//     即便旧缓存把「下载」入口显示给了有账号的人，authorize() 里也绝不返回下载链接。
//     第 3 条用例就是钉这一层 —— 不依赖任何 magpie 版本的缓存行为。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeMethods } from "../src/hooks/methods.mjs"
import { hasAccounts } from "../src/accounts.mjs"

const C = { PROVIDER: "trustoken", PROVIDER_NAME: "Trustoken（AiPy）" }

test("1) 入口集合：0 账号 → 3 个（下载/本机/手机号）；有账号 → 只剩「本机登录」", () => {
  const none = makeMethods(C, { hasAccounts: () => false })
  assert.deepEqual(
    none.map((m) => m.label),
    [
      "Trustoken（AiPy） 首次使用：下载 AiPy Pro 客户端注册",
      "Trustoken（AiPy） 本机登录（读取 AiPy 会话）",
      "Trustoken（AiPy） 手机号登录（无头浏览器）",
    ],
    "0 账号时应该露出下载注册这条路",
  )
  assert.equal(none[0].type, "oauth")
  assert.equal(none[1].type, "api")

  const some = makeMethods(C, { hasAccounts: () => true })
  assert.deepEqual(some.map((m) => m.label), ["Trustoken（AiPy） 本机登录（读取 AiPy 会话）"])
  for (const m of some) {
    assert.ok(!/下载|安装包|http/i.test(m.label), `有账号时不该出现下载相关入口：${m.label}`)
  }
})

test("2) hasAccounts：只认 trustoken / trustoken#…；没有文件=0；坏 JSON=保守按有账号", () => {
  const dir = mkdtempSync(join(tmpdir(), "trustoken-accounts-"))
  const file = join(dir, "plugin-auth.json")
  const write = (v) => writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v))
  const quiet = console.warn
  console.warn = () => {}
  try {
    write({ trustoken: { uid: "182238" } })
    assert.equal(hasAccounts("trustoken", { dir }), true, "裸 trustoken key 要算有账号")

    write({ "trustoken#hpq1jt": { uid: "182277" }, "trustoken#558mdj": { uid: "182452" } })
    assert.equal(hasAccounts("trustoken", { dir }), true, "trustoken#slot 也要算")

    write({ workbuddy: { uid: "1" }, "workbuddy#1": { uid: "2" } })
    assert.equal(hasAccounts("trustoken", { dir }), false, "别的供应商的号不算")

    rmSync(file)
    assert.equal(hasAccounts("trustoken", { dir }), false, "文件不存在 = 这台机器 0 个账号")

    write("{坏掉的 json")
    assert.equal(hasAccounts("trustoken", { dir }), true, "读不了 → 保守按有账号（不把下载链接挡在人面前）")
  } finally {
    console.warn = quiet
    rmSync(dir, { recursive: true, force: true })
  }
})

test("3) 行为层兜底：列表是旧的（0 账号时缓存）但已有账号 → 下载入口不给下载链接", async () => {
  let accounts = 0
  const methods = makeMethods(C, { hasAccounts: () => accounts > 0 })
  const download = methods[0]
  assert.match(download.label, /下载/)

  accounts = 1 // 模拟：列表渲染之后、点击之前，账号已经加上了（缓存没刷新）

  const res = await download.authorize({ invite: "0" })
  assert.equal(res.url, "", "有账号时 authorize 不该返回 URL")
  assert.ok(!JSON.stringify(res).includes("aipy-pro-2.1.1-x64.exe"), "instructions 里也不许出现下载链接")
  const done = await res.callback()
  assert.equal(done.type, "failed")
  assert.match(done.error, /已经有 Trustoken 账号/)
  assert.match(done.error, /本机登录/)
})

test("4) 本机登录：没有本机 AiPy 登录态 / 号已在 magpie 里 → 都要明确报错", async () => {
  const noToken = makeMethods(C, { hasAccounts: () => true, readToken: async () => null })
  await assert.rejects(() => noToken[0].authorize(), /本机没有 AiPy 登录态/, "没有客户端登录态要给出明确指引，而不是静默失败")

  const known = makeMethods(C, {
    hasAccounts: () => true,
    readToken: async () => ({ access_token: "tok" }),
    fetchSelf: async () => ({ id: 182238, username: "18970098051" }),
    isKnown: () => true,
  })
  await assert.rejects(() => known[0].authorize(), /已经在 magpie 里/, "同一个号再导一次要提示切换，不能让人以为新号加上了")
  await assert.rejects(() => known[0].authorize(), /189\*\*\*\*8051/, "报错里要说清当前客户端是哪个号")
})

test("5) label 去动态化：所有 label 都是稳定文案，不含动态邀请码", () => {
  const labels = [
    ...makeMethods(C, { hasAccounts: () => false }).map((m) => m.label),
    ...makeMethods(C, { hasAccounts: () => true }).map((m) => m.label),
  ]
  for (const l of labels) {
    assert.ok(!/邀请码[（(]/.test(l), `label 不该带动态邀请码（会被 magpie 缓存住）：${l}`)
    assert.ok(!/[A-Z0-9]{5}-[a-z0-9]{8}/.test(l), `label 不该带滚动邀请码：${l}`)
  }
})
