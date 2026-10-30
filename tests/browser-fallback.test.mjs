// tests/browser-fallback.test.mjs —— 打不开受控浏览器时的回退（主人 2026-10-31 要求）
//
// 判据：
//   ① 找不到浏览器 / 启动失败 → authorize() 返回非空 url、opened:false（magpie 会用系统浏览器打开）、
//      instructions 里必须带完整网址，并且网址被复制到剪贴板；
//   ② 回退不是默认路径：能启动窗口时必须 opened:true / url:""，仍走弹窗注册（那样才拿得到 cookie）；
//   ③ instructions 必须如实写「通常不会自动导入」并给出「本机登录（读取 AiPy 会话）」的出路；
//   ④ 剪贴板失败不能把回退搞崩；
//   ⑤ 用户把 aipy-pro://oauth?code=... 粘回来时，会走 OAuth 换 token 的路径（这里只测空输入与失败引导）。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const C = { PROVIDER: "trustoken", PROVIDER_NAME: "Trustoken（AiPy）" }

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "trustoken-fallback-"))
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

async function phoneOf(deps) {
  const { makeMethods } = await import("../src/hooks/methods.mjs")
  const methods = makeMethods(C, { hasAccounts: () => false, readToken: async () => null, ...deps })
  return methods.find((m) => /手机号/.test(m.label))
}

test("① 浏览器启动失败 → url 非空 + opened:false + 网址进剪贴板 + instructions 带网址", async () =>
  withHome(async () => {
    const copied = []
    const phone = await phoneOf({
      copyToClipboard: (t) => copied.push(t),
      launchWindow: async () => {
        throw new Error("没有找到 Chromium 内核浏览器（Chrome / Edge / Brave / scoop 版 Chromium 等）")
      },
    })
    const res = await phone.authorize({ phone: "13800138000" })

    assert.ok(res.url, "回退必须给非空 url")
    assert.match(res.url, /^https:\/\/www\.trustoken\.cn\/api\/oauth\/authorize\?/)
    assert.match(res.url, /client_id=aipy-pro/)
    assert.match(res.url, /redirect_uri=aipy-pro%3A%2F%2Foauth/)
    assert.equal(res.opened, false, "opened:false 让 magpie 用系统浏览器打开")
    assert.equal(res.method, "code")
    assert.ok(res.instructions.includes(res.url), "instructions 必须包含完整可复制网址")
    assert.match(res.instructions, /已复制到剪贴板/)
    assert.match(res.instructions, /本机登录（读取 AiPy 会话）/, "要给出拿回登录态的出路")
    assert.match(res.instructions, /通常不会自动导入/, "不能假装能自动接上")
    assert.deepEqual(copied, [res.url], "剪贴板应收到完整网址")
  }))

test("② 回退不是默认路径：能启动窗口时 opened:true / url 为空，仍走弹窗", async () =>
  withHome(async () => {
    const phone = await phoneOf({
      copyToClipboard: () => {
        throw new Error("剪贴板不可用")
      },
      launchWindow: async () => ({
        waitForLogin: async () => ({ user: "{}" }),
        getCookies: async () => [],
        close: async () => {},
      }),
    })
    const res = await phone.authorize({ phone: "13800138000" })
    assert.equal(res.opened, true)
    assert.equal(res.url, "")
    assert.equal(res.method, "auto")
    assert.match(res.instructions, /已打开注册窗口/)
  }))

test("③ 剪贴板抛错也能返回回退（不能把主流程搞崩）", async () =>
  withHome(async () => {
    const phone = await phoneOf({
      copyToClipboard: () => {
        throw new Error("clipboard unavailable")
      },
      launchWindow: async () => {
        throw new Error("spawn chrome ENOENT")
      },
    })
    const res = await phone.authorize({ phone: "13800138000" })
    assert.ok(res.url)
    assert.equal(res.opened, false)
    assert.ok(res.instructions.includes(res.url))
  }))

test("④ 回退的 callback：没粘 code → 明确引导「本机登录」，不假装成功", async () =>
  withHome(async () => {
    const phone = await phoneOf({
      copyToClipboard: () => {},
      launchWindow: async () => {
        throw new Error("没找到浏览器")
      },
    })
    const res = await phone.authorize({ phone: "13800138000" })
    const done = await res.callback("")
    assert.equal(done.type, "failed")
    assert.match(done.error, /本机登录（读取 AiPy 会话）/)
  }))
