// ⑥ auth.checkin(getAuth, provider) —— 签到 + 每日任务
//
// Trustoken 每天 08:00–22:00（北京时间）可签到：
//   POST /api/user/checkin            → data.total_reward（quota）
//   GET  /api/user/daily_tasks/status → 每日任务进度与可领取状态
//   POST /api/user/daily_tasks/claim  → 领奖励
//
// 每日任务（daily_ai_1 / daily_ai_5）的 progress 由 trustoken 服务端统计「AI 任务」。
// 实测：普通 /chat/completions 请求、带 Aipy-Task-ID 的请求，都不增加 progress；
// 只有 AiPy 客户端里真正完成的任务才算。所以插件在这里做的是：
//   ① 领取已经可领的奖励（确定有效）
//   ② 用最低消费模型（qwen3.8-flash）补 gap 次极小请求（best effort）
//   ③ 把服务端实际进度写回 message —— 不谎报完成

import { randomBytes } from "node:crypto"
import { checkinStatus, doCheckin, dailyTaskStatus, claimDailyTask, chatOnce } from "../api.mjs"
import { QUOTA_PER_STONE, CHECKIN_WINDOW } from "../context.mjs"
import { CHEAPEST_MODEL } from "../rates.mjs"

const stones = (quota) => Number(quota || 0) / QUOTA_PER_STONE

function beijingHour(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600_000).getUTCHours()
}

function taskId() {
  return randomBytes(16).toString("base64url").replace(/[-_]/g, "x").slice(0, 21)
}

export function makeCheckin(c) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (!auth) return { outcome: "failed", message: "未登录" }
    if (auth.type === "api") {
      return { outcome: "ineligible", message: "API Key 登录不参与签到；请用手机号验证码登录" }
    }

    const token = auth.accountToken || auth.refresh
    const uid = auth.uid
    const apiKey = auth.apiKey || auth.access
    if (!token) return { outcome: "failed", message: "没有账号 token，请重新登录" }

    const parts = []
    let credit = 0
    let claimed = false
    let windowOpen = true

    try {
      // ── ① 签到 ───────────────────────────────────────────────────
      const st = await checkinStatus(token, uid)
      if (st?.checked_in_today) {
        parts.push("今天已签到")
      } else {
        const hour = beijingHour()
        if (hour < CHECKIN_WINDOW.startHour || hour >= CHECKIN_WINDOW.endHour) {
          // 窗口外仍然去领任务奖励；签到本身留给 magpie 当天重试
          windowOpen = false
          parts.push(`未到签到窗口（每日 08:00–22:00 北京时间，现在 ${hour} 点）`)
        } else {
          const r = await doCheckin(token, uid)
          if (r?.success) {
            const s = stones(r?.data?.total_reward)
            credit += s
            claimed = true
            parts.push(`签到 +${s} 灵石`)
          } else {
            parts.push(`签到未成功：${r?.message || "未知原因"}`)
          }
        }
      }

      // ── ② 领取可领取的每日任务奖励 ────────────────────────────────
      let tasks = await dailyTaskStatus(token, uid)
      for (const t of tasks) {
        if (t.status !== "claimable") continue
        const r = await claimDailyTask(token, uid, t.task_type)
        if (r?.success) {
          const s = stones(r?.data?.reward)
          credit += s
          claimed = true
          parts.push(`${t.title} 领取 +${s} 灵石`)
        } else {
          parts.push(`${t.title} 领取失败：${r?.message || "未知原因"}`)
        }
      }

      // ── ③ 用最低消费模型补每日任务（best effort） ─────────────────
      tasks = await dailyTaskStatus(token, uid)
      const gaps = tasks.filter(
        (t) => t.status === "in_progress" && Number(t.progress) < Number(t.target),
      )
      if (gaps.length && apiKey) {
        const need = Math.max(...gaps.map((t) => Number(t.target) - Number(t.progress)))
        let sent = 0
        for (let i = 0; i < need; i++) {
          try {
            await chatOnce(apiKey, {
              model: CHEAPEST_MODEL,
              content: `只回复 OK（${i + 1}）`,
              max_tokens: 4,
              headers: {
                "Aipy-Task-ID": `${taskId()}/2.1.1`,
                "Aipy-Task-Depth": "0",
                "Aipy-Task-Type": "task",
              },
            })
            sent++
          } catch {
            // 单次失败不影响签到
          }
        }
        const after = await dailyTaskStatus(token, uid)
        const progress = after.map((t) => `${t.progress}/${t.target}`).join("、")
        const stillOpen = after.some((t) => t.status === "in_progress")
        parts.push(
          `用最低价 ${CHEAPEST_MODEL} 发了 ${sent} 次；任务进度 ${progress}` +
            (stillOpen ? "（服务端只认 AiPy 客户端完成的任务）" : ""),
        )

        // 补完若变成可领取，再领一次
        for (const t of after) {
          if (t.status !== "claimable") continue
          const r = await claimDailyTask(token, uid, t.task_type)
          if (r?.success) {
            const s = stones(r?.data?.reward)
            credit += s
            claimed = true
            parts.push(`${t.title} 领取 +${s} 灵石`)
          }
        }
      }

      return {
        outcome: claimed ? "claimed" : windowOpen ? "done" : "failed",
        credit: credit || undefined,
        message: parts.join("；"),
      }
    } catch (e) {
      return { outcome: "failed", message: String(e?.message ?? e).slice(0, 400) }
    }
  }
}
