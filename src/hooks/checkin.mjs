// ⑥ auth.checkin(getAuth, provider) —— 签到 + 每日任务
//
// Trustoken 每天 08:00–22:00（北京时间）可签到：
//   POST /api/user/checkin            → data.total_reward（quota）
//   GET  /api/user/daily_tasks/status → 每日任务进度与可领取状态
//   POST /api/user/daily_tasks/claim  → 领奖励
//
// 每日任务（daily_ai_1 / daily_ai_5）的 progress 由 trustoken 服务端统计「AI 任务」。
// 实测：普通 /chat/completions 请求、带 Aipy-Task-ID 的请求，都不增加 progress；
// 只有 AiPy 客户端里真正完成的任务才算。
// 2026-10-31 实测：任务未开始时服务端返回 `locked`（不是 `in_progress`），建 AiPy 任务会推进它
// —— `locked` 必须算 gap，否则 ensureAipyTasks 永远不触发（0.3.14 修复）。所以插件在这里做的是：
//   ① 领取已经可领的奖励（确定有效）
//   ② 用最低消费模型（qwen3.8-flash）补 gap 次极小请求（best effort）
//   ③ 把服务端实际进度写回 message —— 不谎报完成

import { randomBytes } from "node:crypto"
import { checkinStatus, doCheckin, dailyTaskStatus, claimDailyTask, chatOnce } from "../api.mjs"
import { QUOTA_PER_STONE, CHECKIN_WINDOW } from "../context.mjs"
import { CHEAPEST_MODEL } from "../rates.mjs"
import { rollInvite } from "../invite.mjs"
import { fileOf, readJson, writeJson, removeJson } from "../store.mjs"

const stones = (quota) => Number(quota || 0) / QUOTA_PER_STONE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function beijingHour(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600_000).getUTCHours()
}

/** 北京日期 YYYY-MM-DD —— 每日任务按北京时间跨天重置，冷却记录也按它分天 */
export function beijingDay(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 进度总和：比较「补任务前 / 后」有没有真的推进 */
export function progressSum(tasks) {
  return (tasks ?? []).reduce((s, t) => s + Number(t.progress || 0), 0)
}

/** 补了任务却一格进度都没动 → 当天别再自动补（防空转，见 0.4.0 CHANGELOG） */
export function shouldStall(before, after) {
  return progressSum(after) <= progressSum(before)
}

function taskId() {
  return randomBytes(16).toString("base64url").replace(/[-_]/g, "x").slice(0, 21)
}

/**
 * 哪些每日任务还需要「建 AiPy 任务」来推进。
 *
 * 2026-10-31 实测：服务端把未开始的任务标成 `locked`（不是 `in_progress`）——
 * 建 1 个 AiPy 任务后 locked 0/1 → claimable 1/1、locked 0/5 → in_progress 1/5。
 * 前端 bundle 的 `Jb` 组件也把 `locked` 落到「去完成」分支（点击打开 AiPy 主界面）。
 * ⇒ `locked` 是「今天还没开始」的正常初始态，必须和 `in_progress` 一样算 gap；
 *   漏掉它会让 ensureAipyTasks 一次都不触发（旧 bug）。
 */
export function taskGaps(tasks) {
  return (tasks ?? []).filter(
    (t) =>
      (t.status === "in_progress" || t.status === "locked") &&
      Number(t.progress) < Number(t.target),
  )
}

/**
 * 等每日任务结算并逐项领奖（0.4.1）。
 *
 * 任务完成是**异步结算**的：重放请求 12–20 秒常见，本机客户端任务更慢。
 * 旧代码只等 30 秒就判「没进展」并把当天封死 —— 奖励晚到账就永远没人领。
 * 这里按结算节奏轮询，一看到 `claimable` 立刻领，最多等 `maxWaitMs`；
 * 没等到也不算失败：任务已经发出去了，下一次签到会接着等、接着领。
 *
 * 依赖全部注入，便于离线测试（status / claim / sleepFn）。
 * 返回 { done, tasks, claimed: [{ title, reward }] }。
 */
export async function settleDailyTasks({
  status,
  claim,
  maxWaitMs = 120_000,
  intervalMs = 12_000,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const started = Date.now()
  const claimed = []
  let tasks = await status()

  for (;;) {
    for (const t of tasks) {
      if (t.status !== "claimable") continue
      const r = await claim(t.task_type)
      if (r?.success) {
        claimed.push({ title: t.title, reward: Number(r?.data?.reward || 0) })
        // 本地同步，避免同一轮里重复 claim
        t.status = "claimed"
        t.progress = t.target
      }
    }
    if (taskGaps(tasks).length === 0) return { done: true, tasks, claimed }
    if (Date.now() - started >= maxWaitMs) return { done: false, tasks, claimed }
    await sleepFn(intervalMs)
    tasks = await status()
  }
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

      // ── ③ 补每日任务：纯 API 完整形态优先，本机 AiPy 回退 ─────────
      //
      // 0.4.0（2026-11-04 抓包 + 对照实验）：trustoken 按**完整任务形态**的
      // /chat/completions 请求计数 —— OpenAI/Python SDK 头组 + aipy-task-id/depth
      // + x-aipy-task-id/x-aipy-task-type + 完整任务 prompt + stream(include_usage)。
      // 100% 重放可完成 daily_ai_1 / daily_ai_5 并领奖（实测 189 号 0/5 → 5/5 claimed）。
      // ⇒ 不再依赖 AiPy 客户端；本机 createTask 仅作无 apiKey / 纯 API 全失败时的回退。
      tasks = await dailyTaskStatus(token, uid)
      if (taskGaps(tasks).length) {
        const need = Math.max(...taskGaps(tasks).map((t) => Number(t.target) - Number(t.progress)))
        const stateFile = fileOf("aipy-daily", { siteId: "trustoken", account: uid })
        const today = beijingDay()
        const state = readJson(stateFile)
        const stalledToday = state?.day === today && state?.stalled === true
        let attempted = 0

        if (stalledToday) {
          // 今天补过、服务端一直没认：不再重复发任务（防空转），但本轮仍然等它晚到账并领奖
          parts.push("今日已补过任务、服务端尚未结算：本轮不再重复补，继续等待并领取")
        } else {
          // 主路径：纯 API 补任务（不读 AiPy 本机登录态，多账号各自独立）
          if (apiKey) {
            const { runRemoteTask, TASK_INTERVAL_MS } = await import("../aipy-remote.mjs")
            for (let i = 0; i < need; i++) {
              try {
                const r = await runRemoteTask({ apiKey, model: CHEAPEST_MODEL })
                if (!r.ok) {
                  parts.push(`补任务第 ${i + 1} 次请求失败（HTTP ${r.status}）`)
                  break
                }
                attempted++
              } catch (e) {
                parts.push(`补任务第 ${i + 1} 次请求异常：${String(e?.message ?? e).slice(0, 120)}`)
                break
              }
              // 结算节奏：过密会漏计（实测 35–40 秒间隔稳定每次 +1）
              if (i < need - 1) await sleep(TASK_INTERVAL_MS)
            }
            if (attempted > 0) {
              parts.push(`以完整任务形态补发 ${attempted} 个 AI 任务（${CHEAPEST_MODEL}，纯 API）`)
            }
          }

          // 回退：本机 AiPy 客户端建任务（需客户端登录的是同一个号，否则建了也记别人头上）
          if (attempted === 0) {
            const { ensureAipyTasks, readAipyProfile, sameAipyAccount } = await import("../aipy-local.mjs")
            const profile = await readAipyProfile()
            const match = sameAipyAccount(profile, uid)
            if (match === false) {
              parts.push(
                `AiPy 客户端当前登录的是 ${profile?.phone ? `${profile.phone.slice(0, 3)}****${profile.phone.slice(-4)}` : "另一个账号"}，` +
                  `与本账号不一致，跳过本机建任务（建了也只会记到那个号上）`,
              )
            } else {
              const local = await ensureAipyTasks({ n: need, model: CHEAPEST_MODEL })
              if (local.created > 0) {
                attempted = local.created
                parts.push(`用最低价 ${CHEAPEST_MODEL} 在 AiPy 建了 ${local.created} 个任务（会话）`)
              } else {
                parts.push(`AiPy 本机任务不可用（${local.reason}）`)
                // filler 兜底（主人要求保留；实测不推进进度，只作尽力而为）
                if (apiKey) {
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
                    } catch {}
                  }
                }
              }
            }
          }
        }

        // ── 等结算 + 逐项领奖（0.4.1）────────────────────────────────
        // 任务完成是异步结算的：实测 12–20 秒常见，慢的会更久。这里按结算节奏轮询，
        // 一看到 claimable 立刻领，最多等 2 分钟；没等到也不丢——当天记录已补过，
        // 下一次签到会接着等并与 ② 一起把晚到账的奖励领掉。
        const settle = await settleDailyTasks({
          status: () => dailyTaskStatus(token, uid),
          claim: (task_type) => claimDailyTask(token, uid, task_type),
        })
        for (const c of settle.claimed) {
          const s = stones(c.reward)
          credit += s
          claimed = true
          parts.push(`${c.title} 领取 +${s} 灵石`)
        }
        parts.push(`每日任务进度 ${settle.tasks.map((t) => `${t.progress}/${t.target}`).join("、")}`)

        if (settle.done) {
          removeJson(stateFile)
        } else if (attempted > 0) {
          // 有推进（只是没等满）→ 下次签到继续补剩余；一格没动 → 当天不再重复补
          if (shouldStall(tasks, settle.tasks)) writeJson(stateFile, { day: today, stalled: true, at: Date.now() })
          else removeJson(stateFile)
        }
      }

      // 每天顺带滚一次邀请码（学超级麦吉：签到是每天必跑的那个钩子）
      const ownInvite = await rollInvite(auth)
      if (ownInvite) parts.push(`邀请码 ${ownInvite}`)

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
