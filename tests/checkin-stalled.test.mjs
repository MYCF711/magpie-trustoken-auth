import test from "node:test"
import assert from "node:assert/strict"
import { makeCheckin, beijingDay } from "../src/hooks/checkin.mjs"
import { fileOf, writeJson, removeJson } from "../src/store.mjs"

for (const lateReward of [false, true]) {
  test(`stalled tasks return promptly and preserve late rewards: ${lateReward}`, async (context) => {
    const uid = `checkin-stalled-regression-${process.pid}-${lateReward}`
    const stateFile = fileOf("aipy-daily", { siteId: "trustoken", account: uid })
    writeJson(stateFile, { day: beijingDay(), stalled: true })
    const started = Date.now()
    let elapsed = 0
    let waits = 0
    let statusCalls = 0
    let claims = 0
    context.mock.method(Date, "now", () => started + elapsed)
    context.mock.method(globalThis, "setTimeout", (callback, delay) => {
      if (delay >= 12_000) waits++
      elapsed += 121_000
      callback()
      return 0
    })
    context.mock.method(globalThis, "fetch", async (url) => {
      const path = new URL(url).pathname
      if (path.endsWith("/checkin/status")) {
        return Response.json({ success: true, data: { checked_in_today: true } })
      }
      if (path.endsWith("/daily_tasks/status")) {
        statusCalls++
        const ready = lateReward && statusCalls >= 3
        return Response.json({ success: true, data: { tasks: [
          { task_type: "daily_ai_5", title: "daily task", status: ready ? "claimable" : "in_progress", progress: ready ? 5 : 4, target: 5 },
        ] } })
      }
      if (path.endsWith("/daily_tasks/claim")) {
        claims++
        return Response.json({ success: true, data: { reward: 750000 } })
      }
      if (path.endsWith("/self")) return Response.json({ success: true, data: {} })
      throw new Error(`Unexpected request: ${path}`)
    })
    try {
      const result = await makeCheckin({})(async () => ({ type: "oauth", accountToken: "test", uid }))
      assert.equal(result.outcome, lateReward ? "claimed" : "done")
      assert.match(result.message, /今天已签到/)
      assert.equal(waits, 0)
      assert.equal(claims, lateReward ? 1 : 0)
      assert.equal(result.credit, lateReward ? 150 : undefined)
    } finally {
      removeJson(stateFile)
    }
  })
}
