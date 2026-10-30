// ⑥ auth.checkin(getAuth, provider) —— 签到 + 领取已经到手的每日任务奖励
//
// Trustoken 每天 08:00–22:00（北京时间）可签到：
//   POST /api/user/checkin            → data.total_reward（quota）
//   GET  /api/user/daily_tasks/status → 每日任务进度与可领取状态
//   POST /api/user/daily_tasks/claim  → 领奖励
//
// ⚠ 这里**只做两件事**：按厂商自己的接口签到；把服务端已经标成 `claimable` 的奖励领掉。
//   旧版本还会「补每日任务」：读本机 AiPy Pro 的本地 API 新建任务（会话），再用最低价
//   模型发一批带假任务头的 filler 请求去把进度刷上去。社区 review 指出那是在
//   「farms a vendor's promotion on the user's account」，已整段删除（含
//   src/aipy-local.mjs 里的本机任务接口那套）。进度只能靠用户自己在 AiPy 客户端里干活涨，
//   涨到可领时这个钩子才领。
//
// 进度照实上报，不谎报：message 里写服务端真实进度。

import { checkinStatus, doCheckin, dailyTaskStatus, claimDailyTask } from "../api.mjs"
import { QUOTA_PER_STONE, CHECKIN_WINDOW } from "../context.mjs"
import { rollInvite } from "../invite.mjs"

const stones = (quota) => Number(quota || 0) / QUOTA_PER_STONE

function beijingHour(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600_000).getUTCHours()
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

      // ── ② 领取服务端已经标成可领的每日任务奖励 ────────────────────
      //
      // 只领「已经 claimable」的：那是用户自己在 AiPy 客户端里干出来的进度换来的奖励，
      // 这个钩子只是替他点一下官方的领取按钮。**不推进度**（见文件头）。
      const tasks = await dailyTaskStatus(token, uid)
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
      const progress = tasks
        .filter((t) => Number(t.target) > 0)
        .map((t) => `${t.title} ${Number(t.progress)}/${Number(t.target)}`)
      if (progress.length) parts.push(`每日任务进度 ${progress.join("、")}（在 AiPy 客户端里做任务才会涨）`)

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
