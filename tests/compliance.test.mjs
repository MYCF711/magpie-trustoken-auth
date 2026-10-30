// tests/compliance.test.mjs —— 社区 review 的合规红线，锁死在测试里
//
//   node --test
//
// 背景（magpie-community/plugins PR #527 的 review，2026-10-30）：
//   ① 推荐码：主人自己的邀请码可以带（`AUTHOR_INVITE` 保留、可用环境变量覆盖）；
//      但**账号身份**不能带 —— 插件不能把谁家的 uid / accountId 当成默认值。
//   ② 插件拿自己的凭据只能走钩子，不能直接读 magpie 的私有账号 / 登录文件。
//   ③ 不能替用户刷厂商的推广任务（filler 请求 / 本机建任务）。
//   ④ 不能写死安装包直链；不能替用户解验证码（绕过风控）。
//
// 这一组测试分两层：
//   · 源码锁：这些字符串不许再出现在发布的代码里（谁改回来就红）；
//   · 行为测：defaultGroup / 下载入口的真实返回值。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")

// 各文件里**不许再出现**的字符串。
// 注意：`plugin-auth.json` 只在 accounts.mjs（「本机有没有账号」的存在性判断，社区 review 后仍保留）
// 里合法；其它文件不许读它。
const FORBIDDEN = {
  "src/header-groups.mjs": ["182238", "189****8051", "plugin-auth.json", "read189Auth"],
  "src/invite.mjs": ["logins.json", "plugin-auth.json", "preferredInvite"],
  "src/browser-login.mjs": ["solveSlider", "dragSlider", "SOLVE_SLIDER", "/api/captcha/check"],
  "src/hooks/methods.mjs": ["solveSlider", "dragSlider", "promo.aipyaipy.com", "aipy-pro-2.1.1", "downloads/aipy"],
  "src/hooks/checkin.mjs": ["createTask", "Aipy-Task-ID", "ensureAipyTasks", "chatOnce"],
  "src/aipy-local.mjs": ["createTask", "ensureAipyTasks", "readAipyApiKey", "findAipyPort"],
  "scripts/aipy-daily.mjs": ["ensureAipyTasks", "createTask", "CHEAPEST"],
}

/** 临时把 HOME 指到空目录，测完还原（os.homedir() 在 Windows 上读 USERPROFILE） */
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "trustoken-compliance-"))
  const oldProfile = process.env.USERPROFILE
  const oldAppData = process.env.APPDATA
  process.env.USERPROFILE = home
  process.env.APPDATA = join(home, "AppData", "Roaming")
  try {
    return await fn(home)
  } finally {
    if (oldProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = oldProfile
    if (oldAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = oldAppData
    rmSync(home, { recursive: true, force: true })
  }
}

test("① 推荐码可以带：AUTHOR_INVITE 保留且可被 TRUSTOKEN_INVITE 覆盖", async () => {
  const { AUTHOR_INVITE, inviteToUse } = await import("../src/invite.mjs")
  assert.equal(AUTHOR_INVITE, String(process.env.TRUSTOKEN_INVITE || "Chdr").trim())
  assert.ok(AUTHOR_INVITE.length > 0, "没有内置推荐码时也要能显式配置一个")
  assert.equal(typeof inviteToUse(), "string")
})

test("② defaultGroup：没有账号信息时 uid/accountId 为空；旧文件里的写死身份会被清掉", async () =>
  withHome(async (home) => {
    const { defaultGroup } = await import("../src/header-groups.mjs")

    const g = defaultGroup() // 全新 home：0 个账号
    assert.equal(g.uid, "", "没有账号信息时不该有 uid")
    assert.equal(g.accountId, "", "没有账号信息时不该有 accountId")

    // 模拟旧版本落盘过的「写死维护者账号」的默认组 —— 必须被丢掉重建
    const dir = join(home, ".cache", "magpie")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "trustoken-header-groups.json")
    writeFileSync(file, JSON.stringify({ default: { uid: "182238", accountId: "189****8051", affCode: "Chdr" } }))

    const healed = defaultGroup()
    assert.equal(healed.uid, "", "旧文件里的写死 uid 不能继续用")
    assert.equal(healed.accountId, "", "旧文件里的写死 accountId 不能继续用")
    const saved = JSON.parse(readFileSync(file, "utf8"))
    assert.equal(saved.default.uid, "")
    assert.equal(saved.default.accountId, "")

    assert.ok(!readFileSync(file, "utf8").includes("182238"))
  }))

test("③ 不读 magpie 私有登录文件：源码锁 + preferredInvite 已不存在", async () => {
  const invite = await import("../src/invite.mjs")
  assert.equal("preferredInvite" in invite, false, "preferredInvite 应已删除（它读 magpie 的私有文件）")
  for (const [file, words] of Object.entries(FORBIDDEN)) {
    const text = read(file)
    for (const w of words) {
      assert.equal(text.includes(w), false, `${file} 仍含「${w}」`)
    }
  }
})

test("④ checkin 不再刷推广任务：不建任务、不发 filler", () => {
  const checkin = read("src/hooks/checkin.mjs")
  const local = read("src/aipy-local.mjs")
  for (const w of ["ensureAipyTasks", "createTask", "Aipy-Task-ID", "chatOnce", "CHEAPEST_MODEL"]) {
    assert.equal(checkin.includes(w), false, `checkin.mjs 仍含「${w}」`)
  }
  for (const w of ["createTask", "ensureAipyTasks", "readAipyApiKey", "findAipyPort"]) {
    assert.equal(local.includes(w), false, `aipy-local.mjs 仍含「${w}」`)
  }
  const daily = read("scripts/aipy-daily.mjs")
  for (const w of ["ensureAipyTasks", "createTask", "CHEAPEST"]) {
    assert.equal(daily.includes(w), false, `scripts/aipy-daily.mjs 仍含「${w}」`)
  }
  assert.match(daily, /readTrustokenToken/, "看进度 / 领奖励这件事要留着")
  // 只读登录态这件事还留着（本机登录要用）
  assert.match(local, /readTrustokenToken/)
})

test("⑤ 下载页 + 不代解验证码：下载入口跳官方页，源码里没有解验证码那一套", async () =>
  withHome(async () => {
    const { makeMethods } = await import("../src/hooks/methods.mjs")
    const methods = makeMethods(
      { PROVIDER: "trustoken", PROVIDER_NAME: "Trustoken（AiPy）" },
      { hasAccounts: () => false, readToken: async () => null, copyToClipboard: () => {} },
    )
    const download = methods[0]
    assert.match(download.label, /首次使用/)
    const res = await download.authorize({ invite: "" })
    assert.equal(res.url, "https://www.aipyaipy.com/", "下载入口必须跳官方下载页")
    assert.ok(!/\.exe|downloads\//i.test(res.url), "不许再写死安装包直链")

    for (const w of ["solveSlider", "dragSlider", "SOLVE_SLIDER"]) {
      assert.equal(read("src/browser-login.mjs").includes(w), false)
      assert.equal(read("src/hooks/methods.mjs").includes(w), false)
    }
  }))
