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
