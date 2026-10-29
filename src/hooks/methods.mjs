// ② auth.methods[] —— 一个入口：无头浏览器内置登录
//
// 流程：
//   1. 用户在 magpie 里填手机号；
//   2. 插件在后台（headless Chromium）打开 Trustoken 官方登录页；
//   3. 自动填手机号、勾选协议、填邀请码；
//   4. 点「获取验证码」→ 自动解滑块 → 短信发出；
//   5. 用户在 magpie 里填验证码；
//   6. 插件自动填验证码、点「立即登录」，捕获登录响应，创建 API Key。
//
// 浏览器全程不弹窗（headless）；滑块由 solveSlider/dragSlider 在页面里完成。

import { fetchSelf, ensureApiKey } from "../api.mjs"
import { launchLoginBrowser, closeSession, evalInPage, solveSlider, dragSlider, waitForLogin } from "../browser-login.mjs"
import { inviteToUse, rollInvite } from "../invite.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function maskPhone(p) {
  return String(p || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")
}

function fillFormExpr(phone, affCode) {
  return `(() => {
    const setVal = (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    setVal("#phone-number", ${JSON.stringify(phone)});
    ${affCode ? `setVal("#aff-code", ${JSON.stringify(affCode)});` : ""}
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) cb.click();
    return JSON.stringify({ phone: !!document.querySelector("#phone-number"), aff: !!document.querySelector("#aff-code") });
  })()`
}

function clickSendExpr() {
  return `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='获取验证码'); if(!b) return 'no-button'; b.click(); return 'clicked' })()`
}

function fillCodeExpr(code) {
  return `(() => {
    const setVal = (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    setVal("#phone-code", ${JSON.stringify(code)});
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) cb.click();
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === "立即登录");
    if (b) b.click();
    return "submitted";
  })()`
}

async function completeSignIn(c, data) {
  const access = data?.access_token ?? data?.accessToken ?? data?.token
  if (!access) {
    throw new Error(`登录响应里没有 access_token（字段：${Object.keys(data || {}).join(", ")}）`)
  }

  const self = await fetchSelf(access, data?.user?.id ?? data?.id)
  const uid = self?.id ?? data?.user?.id ?? data?.id
  const phone = self?.username ?? data?.user?.username ?? data?.username ?? ""
  const apiKey = await ensureApiKey(access, uid)
  const expiresIn = Number(data?.expires_in ?? 2_592_000)

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

export function makeMethods(c) {
  return [
    {
      type: "oauth",
      label: `${c.PROVIDER_NAME} 手机号登录（无头浏览器）`,
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
        const inviteCode = inviteToUse()

        let session = null
        let headless = true
        try {
          session = await launchLoginBrowser(`${c.WEB}/login?aff=${encodeURIComponent(inviteCode)}`, { headless: true })
        } catch {
          headless = false
          session = await launchLoginBrowser(`${c.WEB}/login?aff=${encodeURIComponent(inviteCode)}`, { headless: false })
        }

        try {
          await sleep(800)
          await evalInPage(session, `(() => { const t=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='手机号'); t&&t.click(); return 'ok' })()`)
          await sleep(250)
          const filled = await evalInPage(session, fillFormExpr(phone, inviteCode))
          if (!filled || !JSON.parse(filled).phone) throw new Error("登录页没找到手机号输入框")
          await evalInPage(session, clickSendExpr())
          await sleep(600)

          // 自动过滑块：最多 15 秒，失败就抛
          let sent = false
          for (let i = 0; i < 15; i++) {
            const body = await evalInPage(session, "document.body.innerText")
            if (!body.includes("请拖动滑块完成拼图")) {
              if (/验证码发送成功|重新发送|\d+\s*秒后/.test(body)) sent = true
              break
            }
            const sol = await solveSlider(session)
            if (!sol) { await sleep(800); continue }
            await dragSlider(session, sol)
            await sleep(1100)
          }
          if (!sent) {
            const body = await evalInPage(session, "document.body.innerText")
            if (/验证失败|发送失败|错误：/.test(body)) {
              throw new Error(body.match(/错误：[^\n]*/)?.[0] || "滑块或短信发送失败")
            }
          }
        } catch (e) {
          await closeSession(session).catch(() => {})
          throw e
        }

        return {
          url: `${c.WEB}/login`,
          // ⚠ 必须是 true：这条链路的浏览器已经由插件自己拉起来了（headless 或降级可见），
          //    opened:false 会让 magpie 再开一次系统默认浏览器 —— 用户就会看到网页登录页。
          opened: true,
          method: "code",
          instructions: `验证码已发送到 ${maskPhone(phone)}。把短信里的验证码填到下面，插件会自动完成登录。邀请上级：${inviteCode || "无"}。`,
          async callback(code) {
            const c0 = String(code || "").replace(/\D/g, "")
            if (c0.length < 4) return { type: "failed", error: "验证码是 4~8 位数字" }
            try {
              await evalInPage(session, fillCodeExpr(c0))

              // 点「立即登录」后先看页面有没有直接给出业务错误（尤其是未注册号的拦截）。
              // 以前这里直接 waitForLogin 180 秒，页面明明已经弹了提示，magpie 还一直转。
              let policyError = ""
              for (let i = 0; i < 12; i++) {
                let body = ""
                try { body = await evalInPage(session, "document.body.innerText") } catch { break }
                if (body.includes("新增账号需下载AiPy Pro客户端")) {
                  policyError = "这个手机号在 Trustoken 侧还没注册。服务端已关闭网页注册：新号码必须在 AiPy Pro 客户端首次运行并完成注册后，才能用网页验证码登录。"
                  break
                }
                if (/验证码错误|验证码已过期|请输入正确的验证码/.test(body)) {
                  policyError = "验证码错误或已过期，请重新获取验证码。"
                  break
                }
                if (body.includes("登录成功")) break
                await sleep(500)
              }
              if (policyError) return { type: "failed", error: policyError }

              const got = await waitForLogin(session, { timeout: 90_000, interval: 1000 })
              if (!got?.access_token) {
                return { type: "failed", error: "登录没有返回 access_token：页面可能还在等验证码，或登录未成功。" }
              }
              return await completeSignIn(c, got)
            } catch (e) {
              return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
            } finally {
              await closeSession(session).catch(() => {})
            }
          },
        }
      },
    },
  ]
}
