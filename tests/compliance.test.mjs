// tests/compliance.test.mjs —— 社区 review 的合规红线，锁死在测试里
//
//   node --test
//
// 背景（magpie-community/plugins PR #527 的 review，2026-10-30）：
//   ① 推荐码：主人自己的邀请码可以带（`AUTHOR_INVITE` 保留、可用环境变量覆盖）；
//      但**账号身份**不能带 —— 插件不能把谁家的 uid / accountId 当成默认值。
//   ② 插件拿自己的凭据只能走钩子，不能直接读 magpie 的私有账号 / 登录文件。
//   ③ 不能写死安装包直链。
//   ④ ⚠ 2026-10-30 主人**明确要求恢复**两处 review 里被点名、但属于插件能力的实现：
//      · 建 AiPy 任务 + filler 请求（`ensureAipyTasks` / `Aipy-Task-ID`）—— 主人原话「造任务和 filler 请求我要」
//      · 自动解滑块（`SOLVE_SLIDER` / `solveSlider` / `dragSlider`）—— 静默路径（「本机登录」）已成立，主人选了恢复
//      ⇒ 这两样**不在禁止清单里**，反而有正向用例钉住，别按 review 再删一遍。
//      理由见 docs/internals.md 12.6。
//
// 这一组测试分两层：
//   · 源码锁：这些字符串不许再出现在发布的代码里（谁改回来就红）；
//   · 行为测：defaultGroup / 下载入口 / 被恢复能力的真实存在性。

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
  "src/hooks/methods.mjs": ["promo.aipyaipy.com", "aipy-pro-2.1.1", "downloads/aipy"],
}

/** 临时把 HOME 指到空目录，测完还原（os.homedir() 在 Windows 上读 USERPROFILE） */
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "trustoken-compliance-"))
  const oldProfile = process.env.USERPROFILE
  const oldAppData = process.env.APPDATA
  const oldHome = process.env.HOME // ubuntu CI 上 os.homedir() 读的是 HOME，不是 USERPROFILE
  process.env.USERPROFILE = home
  process.env.APPDATA = join(home, "AppData", "Roaming")
  process.env.HOME = home
  try {
    return await fn(home)
  } finally {
    if (oldProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = oldProfile
    if (oldAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = oldAppData
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
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

test("④ 建任务 + filler 保持恢复（主人 2026-10-30 明确要）：正向锁，别按 review 再删", async () => {
  const checkin = read("src/hooks/checkin.mjs")
  const local = read("src/aipy-local.mjs")
  const daily = read("scripts/aipy-daily.mjs")

  // ① 本机任务接口：读 key / 找端口 / 建任务 / 上层封装
  for (const w of ["readAipyApiKey", "findAipyPort", "createAipyTask", "ensureAipyTasks"]) {
    assert.ok(local.includes(w), `src/aipy-local.mjs 少了「${w}」（主人要求保留建任务能力）`)
  }
  // ② checkin 里要真的调用它，并有带假任务头的 filler 兜底
  assert.match(checkin, /ensureAipyTasks/, "checkin 应调用 ensureAipyTasks 补每日任务")
  assert.match(checkin, /Aipy-Task-ID/, "checkin 应保留 filler 请求（假任务头）")
  assert.match(checkin, /chatOnce/, "checkin 的 filler 走 chatOnce")
  // ③ 导出真的存在（防止只留字符串、实现被掏空）
  const localMod = await import("../src/aipy-local.mjs")
  assert.equal(typeof localMod.ensureAipyTasks, "function", "ensureAipyTasks 必须真的导出")
  assert.equal(typeof localMod.readTrustokenToken, "function", "只读登录态那半也要在（本机登录用）")
  // ④ 独立脚本也要真有建任务路径
  assert.match(daily, /ensureAipyTasks/, "scripts/aipy-daily.mjs 应保留建任务路径")
})

test("⑤ 不再有下载入口；手机号入口走受控浏览器注册链路（弹窗）", () => {
  // 0.3.10：弹窗能直接注册新号，下载入口已删除；改为源码级断言（不依赖 makeMethods）
  const src = readFileSync(new URL("../src/hooks/methods.mjs", import.meta.url), "utf8")
  assert.ok(!/label:\s*`[^`]*首次使用：下载/.test(src), "不该再有下载入口的 label")
  assert.ok(src.includes("手机号注册 / 登录（弹窗）"), "手机号注册入口必须在")
})
