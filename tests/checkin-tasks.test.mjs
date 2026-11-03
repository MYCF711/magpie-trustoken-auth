// tests/checkin-tasks.test.mjs —— 每日任务 gap 判定（0.3.14）
//
// 2026-10-31 实测：trustoken 服务端把「未开始」的每日任务标成 `locked`，不是
// `in_progress`。旧代码只认 in_progress → gaps 永远为空 → ensureAipyTasks 从不触发。
// 实测建 1 个 AiPy 任务：locked 0/1 → claimable 1/1，locked 0/5 → in_progress 1/5。
//
//   node --test

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { taskGaps } from "../src/hooks/checkin.mjs"

const task = (status, progress, target, task_type = "daily_ai_1") => ({
  task_type,
  title: task_type,
  status,
  progress,
  target,
})

test("① locked 是未开始态：必须算 gap（0/1 和 0/5 都要触发补任务）", () => {
  const gaps = taskGaps([
    task("locked", 0, 1, "daily_ai_1"),
    task("locked", 0, 5, "daily_ai_5"),
  ])
  assert.deepEqual(gaps.map((t) => t.task_type), ["daily_ai_1", "daily_ai_5"])
})

test("② in_progress 且未达标也算 gap", () => {
  const gaps = taskGaps([task("in_progress", 1, 5, "daily_ai_5")])
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].task_type, "daily_ai_5")
})

test("③ claimable / claimed / 已达标都不算 gap", () => {
  const gaps = taskGaps([
    task("claimable", 1, 1, "daily_ai_1"),
    task("claimed", 1, 1, "daily_ai_1"),
    task("in_progress", 5, 5, "daily_ai_5"),
    task("locked", 1, 1, "daily_ai_1"),
  ])
  assert.equal(gaps.length, 0)
})

test("④ 空列表 / undefined 返回空", () => {
  assert.deepEqual(taskGaps([]), [])
  assert.deepEqual(taskGaps(undefined), [])
})

test("⑤ 源码锁：gaps 与等待循环都必须走 taskGaps（不许再写死 in_progress）", () => {
  const src = readFileSync(new URL("../src/hooks/checkin.mjs", import.meta.url), "utf8")
  assert.match(src, /t\.status === "in_progress" \|\| t\.status === "locked"/, "taskGaps 必须同时认 in_progress 和 locked")
  assert.ok(src.includes("const gaps = taskGaps(tasks)"), "gaps 过滤必须调用 taskGaps")
  assert.ok(src.includes("if (taskGaps(now).length === 0) break"), "等待循环必须调用 taskGaps")
  assert.ok(!src.includes('t.status === "in_progress" && Number(t.progress)'), "不许再保留只认 in_progress 的旧判断")
})

// ── 2026-11-04：本机 AiPy 只登录一个号，别的号补任务全建到它头上（4 号 × 5 个白烧）──

import { sameAipyAccount } from "../src/aipy-local.mjs"
import { progressSum, shouldStall, beijingDay } from "../src/hooks/checkin.mjs"

test("⑥ sameAipyAccount：本机回退建任务前必须比对登录账号", () => {
  assert.equal(sameAipyAccount({ id: 183131 }, "183131"), true)
  assert.equal(sameAipyAccount({ id: 183131 }, 183131), true)
  assert.equal(sameAipyAccount({ id: 183131 }, "182238"), false)
  assert.equal(sameAipyAccount(null, "182238"), null, "读不到 profile → null，由调用方决定放行")
})

test("⑦ shouldStall：补了任务但进度一格没动 → 当天封自动补", () => {
  const before = [task("locked", 0, 1, "daily_ai_1"), task("locked", 0, 5, "daily_ai_5")]
  const noMove = [task("locked", 0, 1, "daily_ai_1"), task("locked", 0, 5, "daily_ai_5")]
  const moved = [task("claimed", 1, 1, "daily_ai_1"), task("in_progress", 2, 5, "daily_ai_5")]
  assert.equal(shouldStall(before, noMove), true)
  assert.equal(shouldStall(before, moved), false)
  assert.equal(progressSum(moved), 3)
})

test("⑧ beijingDay：按北京日期分天（UTC 16 点 = 北京次日）", () => {
  assert.equal(beijingDay(new Date("2026-11-03T16:00:00Z")), "2026-11-04")
  assert.equal(beijingDay(new Date("2026-11-03T15:59:59Z")), "2026-11-03")
})

test("⑨ 源码锁：纯 API 主路径 + 本机回退闸门 + stalled 冷却", () => {
  const src = readFileSync(new URL("../src/hooks/checkin.mjs", import.meta.url), "utf8")
  assert.ok(src.includes("runRemoteTask"), "必须有纯 API 补任务主路径")
  assert.ok(src.includes("readAipyProfile"), "本机回退必须读 AiPy 登录账号")
  assert.ok(src.includes("match === false"), "账号不一致必须拦截本机建任务")
  assert.ok(src.includes("state?.stalled"), "必须有当日 stalled 冷却")
  assert.ok(src.includes("shouldStall(tasks, after)"), "无进展时必须写冷却")
})
