// tests/browser-candidates.test.mjs —— 浏览器探测的语义锁（AGENTS 坑 32）
//
// 2026-10-31 实测：一台装了 scoop Chromium + Edge（主程序叫 "Microsoft Edge.exe"）的机器，
// 旧探测函数 5 条固定路径全部落空 → 弹窗注册报「没找到浏览器」。本文件锁住修复后的判据：
//   ① env 覆盖（MAGPIE_LINGXI_BROWSER / MAGPIE_TRUSTOKEN_BROWSER）最优先、支持分号分隔、不过滤存在性
//   ② win32 固定路径：Edge 双文件名（msedge.exe + "Microsoft Edge.exe"）、scoop shim、Chromium 每用户
//   ③ Windows PATH 扫描（scoop 把 shims 加进 PATH 后 chromium.exe 必须能被找到）
//   ④ 注册表 App Paths 兜底在固定路径全落空时生效
//   ⑤ 去重 + 本机回归锁

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { browserCandidates, winBrowserCandidatePaths, winPathCandidatePaths } from "../src/browser-login.mjs"

const WIN_ENV = {
  ProgramFiles: "C:\\PF",
  "ProgramFiles(x86)": "C:\\PF86",
  LOCALAPPDATA: "C:\\LA",
  USERPROFILE: "C:\\Users\\t",
  PATH: "C:\\PF\\WindowsApps",
}

test("① env 覆盖最优先，且不做存在性过滤（路径写错让 spawn 报错真实可见）", () => {
  const out = browserCandidates(
    "win32",
    { ...WIN_ENV, MAGPIE_LINGXI_BROWSER: "D:\\nope\\my-browser.exe" },
    { queryAppPaths: () => [], exists: () => false },
  )
  assert.equal(out[0].path, "D:\\nope\\my-browser.exe")
  assert.equal(out[0].name, "my-browser")
})

test("① env 支持分号分隔多个候选，按顺序排前", () => {
  const out = browserCandidates(
    "win32",
    { ...WIN_ENV, MAGPIE_LINGXI_BROWSER: "D:\\a.exe; D:\\b.exe" },
    { queryAppPaths: () => [], exists: () => false },
  )
  assert.deepEqual(out.map((c) => c.path), ["D:\\a.exe", "D:\\b.exe"])
})

test("① MAGPIE_TRUSTOKEN_BROWSER 也能作为覆盖变量", () => {
  const out = browserCandidates(
    "win32",
    { ...WIN_ENV, MAGPIE_TRUSTOKEN_BROWSER: "D:\\x\\chromium.exe" },
    { queryAppPaths: () => [], exists: () => false },
  )
  assert.equal(out[0].path, "D:\\x\\chromium.exe")
})

test("② win 固定候选含 Edge 双文件名 + scoop shim + Chromium 每用户", () => {
  const paths = winBrowserCandidatePaths(WIN_ENV).map((c) => c.path)
  assert.ok(paths.includes("C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe"))
  assert.ok(paths.includes("C:\\PF86\\Microsoft\\Edge\\Application\\Microsoft Edge.exe"))
  assert.ok(paths.includes("C:\\PF\\Microsoft\\Edge\\Application\\Microsoft Edge.exe"))
  assert.ok(paths.includes("C:\\Users\\t\\scoop\\shims\\chromium.exe"))
  assert.ok(paths.includes("C:\\LA\\Chromium\\Application\\chrome.exe"))
})

test("③ Windows PATH 扫描：每个目录 × chrome/chromium/msedge/brave", () => {
  const out = winPathCandidatePaths({ PATH: 'C:\\scoop\\shims;"D:\\some dir";relative\\dir' }).map((c) => c.path)
  assert.ok(out.includes("C:\\scoop\\shims\\chromium.exe"))
  assert.ok(out.includes("D:\\some dir\\chrome.exe"))
  // 相对路径目录不可靠（相对 cwd），直接丢弃
  assert.ok(!out.some((p) => p.includes("relative\\dir")))
})

test("③ PATH 里的浏览器能被 browserCandidates 找到（scoop 场景）", () => {
  const out = browserCandidates(
    "win32",
    { ...WIN_ENV, PATH: "C:\\Users\\t\\scoop\\shims" },
    { queryAppPaths: () => [], exists: (p) => p === "C:\\Users\\t\\scoop\\shims\\chromium.exe" },
  )
  assert.equal(out[0].path, "C:\\Users\\t\\scoop\\shims\\chromium.exe")
})

test("④ 固定路径全落空时，注册表 App Paths 兜底生效（Edge 改名场景）", () => {
  const out = browserCandidates(
    "win32",
    { ...WIN_ENV, PATH: "" },
    { queryAppPaths: () => [{ name: "msedge", path: "C:\\Edge\\Microsoft Edge.exe" }], exists: () => false },
  )
  assert.ok(out.some((c) => c.path === "C:\\Edge\\Microsoft Edge.exe"))
})

test("④ 有固定候选命中时不再查注册表（省一次 reg 开销）", () => {
  let called = 0
  browserCandidates(
    "win32",
    { ...WIN_ENV },
    { queryAppPaths: () => { called++; return [] }, exists: (p) => p.endsWith("chrome.exe") },
  )
  assert.equal(called, 0)
})

test("⑤ 同一路径去重（固定路径与 PATH 扫描可能撞车）", () => {
  const out = browserCandidates(
    "win32",
    { ...WIN_ENV, PATH: "C:\\PF\\Google\\Chrome\\Application" },
    { queryAppPaths: () => [], exists: (p) => p.includes("Chrome") },
  )
  const hits = out.filter((c) => c.path === "C:\\PF\\Google\\Chrome\\Application\\chrome.exe")
  assert.equal(hits.length, 1)
})

test("⑤ 本机回归锁：装了 scoop chromium 的机器必须能找到（本次 bug 的场景）", () => {
  const shim = join(homedir(), "scoop", "shims", "chromium.exe")
  if (!existsSync(shim)) return // 没装的机器跳过
  const out = browserCandidates()
  assert.ok(out.some((c) => c.path === shim), JSON.stringify(out))
})
