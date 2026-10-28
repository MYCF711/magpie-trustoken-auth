// ② auth.methods[] —— 三种登录方式
//
//   1. 手机号 + 短信验证码（完整功能：签到 / 余额 / 模型）
//   2. 直接粘 API Key（只调模型；签到与余额看不到）
//   3. 粘贴账号 access_token（从 AiPy 的 SQLite 或网页 localStorage 拿；完整功能）
//
// 铁律：authorize() 立刻返回，网络请求放在 callback()。

import { sendSmsCode, loginMobile, registerMobile, fetchSelf, ensureApiKey, fetchV1Models } from "../api.mjs"
import {
  inviteToUse,
  inviteChoices,
  rollInvite,
  writeInvitePolicy,
  readAccountCodes,
  authorInvite,
  inviteTag,
  describePolicy,
} from "../invite.mjs"

function maskPhone(p) {
  return String(p || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")
}

async function completeSignIn(c, data) {
  const access = data?.access_token ?? data?.accessToken ?? data?.token
  if (!access) {
    throw new Error(`登录响应里没有 access_token（字段：${Object.keys(data || {}).join(", ")}）`)
  }
  const user = data?.user ?? data
  const uid = user?.id ?? data?.id
  const phone = user?.username ?? user?.phone_number ?? data?.username ?? ""

  // 用 token 自查一次：确认 token 真的能用
  const self = await fetchSelf(access, uid)
  const apiKey = await ensureApiKey(access, uid)
  const expiresIn = Number(data?.expires_in ?? 2_592_000)

  // 登录成功 → 把这个账号自己的邀请码滚上去（失败不影响登录）
  await rollInvite({ accountToken: access, uid, accountId: maskPhone(phone) || String(uid ?? "") })

  return {
    type: "success",
    access: apiKey,
    refresh: data?.refresh_token ?? data?.refreshToken ?? access,
    expires: Date.now() + Math.max(3_600, expiresIn) * 1000,
    accountId: maskPhone(phone) || String(uid ?? "trustoken"),
    uid: String(uid ?? ""),
    apiKey,
    accountToken: access,
    username: phone,
    quota: self?.quota,
  }
}

export function makeMethods(c, getLock = () => true) {
  return [
    // ── ① 手机号验证码 ──────────────────────────────────────────────
    {
      type: "oauth",
      label: `${c.PROVIDER_NAME} 手机号验证码`,
      prompts: [
        {
          type: "text",
          key: "phone",
          message: "手机号",
          placeholder: "13800138000",
          validate: (v) =>
            /^1\d{10}$/.test(String(v || "").replace(/[\s-]/g, "")) ? undefined : "11 位手机号，只要数字",
        },
      ],
      async authorize(inputs) {
        const phone = String(inputs?.phone || "").replace(/[\s-]/g, "")
        if (!/^1\d{10}$/.test(phone)) throw new Error("手机号不完整")
        const inviteCode = inviteToUse(getLock())

        // 发码放在 callback 里（authorize 必须立刻返回）
        return {
          url: `${c.WEB}/login`,
          opened: true,
          method: "code",
          instructions: `点「继续」后会把验证码发到 ${maskPhone(phone)}（可能要先过一次图形验证）。邀请上级：${inviteCode ? inviteCode : "无"}。`,
          async callback(code) {
            const c0 = String(code || "").replace(/\D/g, "")
            if (c0.length < 4) return { type: "failed", error: "验证码是 4~8 位数字" }
            try {
              let body
              try {
                body = await loginMobile(phone, c0, inviteCode)
              } catch (e) {
                // 未注册 → 走注册（注册才接受 aff_code）
                if (/不存在|未注册|未找到|not found|33002|1001/i.test(String(e?.message ?? e))) {
                  body = await registerMobile(phone, c0, inviteCode)
                } else {
                  throw e
                }
              }
              return await completeSignIn(c, body?.data ?? body)
            } catch (e) {
              return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
            }
          },
        }
      },
    },

    // ── ② 直接粘 API Key ───────────────────────────────────────────
    {
      type: "api",
      label: `${c.PROVIDER_NAME} API Key（只调模型，不签到）`,
      placeholder: "UaylzhSfZgGeBq1IarQMeyQSLH2QjuU5WvvpyYJ4cbTHZs9C",
    },

    // ── ③ 粘贴账号 token（完整功能，绕过短信） ─────────────────────
    {
      type: "oauth",
      label: `${c.PROVIDER_NAME} 账号 Token（从 AiPy / 网页）`,
      prompts: [
        {
          type: "text",
          key: "access_token",
          message: "access_token",
          placeholder: "MDVJODQWNZCTZJFHYI0ZN2ZMLTHIYTITNTA0ZMI3NJEYMGQ0",
        },
        {
          type: "text",
          key: "api_key",
          message: "API Key（可留空自动创建）",
          placeholder: "Uayl…",
        },
      ],
      async authorize(inputs) {
        const token = String(inputs?.access_token || "").trim()
        if (!token) throw new Error("access_token 不能为空")
        const manualKey = String(inputs?.api_key || "").trim()

        return {
          url: `${c.WEB}/login`,
          opened: true,
          method: "auto",
          instructions: "正在验证账号 Token……",
          async callback() {
            try {
              const self = await fetchSelf(token, "")
              const uid = self?.id
              let apiKey = manualKey
              if (!apiKey) apiKey = await ensureApiKey(token, uid)
              // 至少验一次模型接口，避免存一个坏 key
              await fetchV1Models(apiKey)
              return {
                type: "success",
                access: apiKey,
                refresh: token,
                expires: Date.now() + 30 * 86400e3,
                accountId: maskPhone(self?.username) || String(uid ?? "trustoken"),
                uid: String(uid ?? ""),
                apiKey,
                accountToken: token,
                username: self?.username,
                quota: self?.quota,
              }
            } catch (e) {
              return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
            }
          },
        }
      },
    },

    // ── ④ 邀请上级（只存策略，不登录、不新增账号） ─────────────────
    {
      type: "api",
      keyless: true,
      label: `${c.PROVIDER_NAME} 邀请上级${inviteTag(getLock)}`,
      prompts: [
        {
          type: "select",
          key: "invite",
          message: "新号挂在谁的邀请码下？（决定拉新奖励进哪个账号）",
          options: inviteChoices(getLock),
        },
      ],
      async authorize(inputs) {
        const pick = String(inputs?.invite || "")
        if (!pick) return { type: "failed", error: "没有选择 —— 保持当前设置" }
        if (pick === "__author__") {
          writeInvitePolicy({ mode: "fixed", code: authorInvite(), accountId: "MYCF711" })
        } else if (pick === "__auto__") {
          writeInvitePolicy({ mode: "auto" })
        } else {
          const codes = readAccountCodes()
          const key = Object.keys(codes).find((k) => codes[k]?.code === pick) || ""
          writeInvitePolicy({ mode: "fixed", code: pick, accountId: codes[key]?.accountId || key })
        }
        return { type: "failed", error: `已保存：新号默认挂在 ${describePolicy(undefined, getLock())}` }
      },
    },

    // ── ⑤ 邀请上级：自定义码 ─────────────────────────────────────
    {
      type: "api",
      keyless: true,
      label: `${c.PROVIDER_NAME} 邀请上级：自定义码`,
      prompts: [
        {
          type: "text",
          key: "inviteCode",
          message: "邀请码（2–16 位字母数字；留空 = 保持当前）",
          placeholder: "例如 Chdr",
          validate: (v) => {
            const s = String(v || "").trim()
            return !s || /^[A-Za-z0-9]{2,16}$/.test(s) ? undefined : "邀请码是 2–16 位字母数字"
          },
        },
      ],
      async authorize(inputs) {
        const code = String(inputs?.inviteCode || "").trim()
        if (!code) return { type: "failed", error: "没有填码 —— 保持当前设置" }
        writeInvitePolicy({ mode: "custom", code })
        return { type: "failed", error: `已保存：新号默认挂在 ${describePolicy(undefined, getLock())}` }
      },
    },
  ]
}
