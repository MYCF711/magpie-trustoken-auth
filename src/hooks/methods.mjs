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

import { createHash, randomBytes } from "node:crypto"
import { fetchSelf, ensureApiKey } from "../api.mjs"
import { readTrustokenToken } from "../aipy-local.mjs"
import { exchangeOAuthCode } from "../oauth.mjs"
import { launchLoginBrowser, closeSession, evalInPage, solveSlider, dragSlider, waitForOAuthCode } from "../browser-login.mjs"
import { inviteToUse, rollInvite, modeHint, saveInviteChoice, isKnownAccount } from "../invite.mjs"
import { defaultGroup, pickGroup, saveGroup, headersFromGroup } from "../header-groups.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makePkce() {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

function headerHookCode(group) {
  return `
    const __h = ${JSON.stringify(headersFromGroup(group))};
    try {
      if (!window.__aipyHeaderHooked) {
        window.__aipyHeaderHooked = true;
        const __open = XMLHttpRequest.prototype.open;
        const __send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__aipyUrl = String(u); return __open.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function () {
          try {
            if (/\\/api\\/user\\//.test(this.__aipyUrl || "")) {
              for (const [k, v] of Object.entries(__h)) if (v) this.setRequestHeader(k, v);
            }
          } catch {}
          return __send.apply(this, arguments);
        };
        const __fetch = window.fetch;
        window.fetch = async function (...a) {
          try {
            const u = typeof a[0] === "string" ? a[0] : (a[0] && a[0].url) || "";
            if (/\\/api\\/user\\//.test(u)) {
              const init = a[1] || {};
              const hd = new Headers(init.headers || {});
              for (const [k, v] of Object.entries(__h)) if (v) hd.set(k, v);
              a[1] = { ...init, headers: hd };
            }
          } catch {}
          return __fetch.apply(this, a);
        };
      }
    } catch {}
  `
}

function maskPhone(p) {
  return String(p || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")
}

function fillFormExpr(phone, affCode, group) {
  return `(() => {
    ${headerHookCode(group)}
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

function clickLoginExpr() {
  return `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='立即登录'); if(!b) return 'no-button'; b.click(); return 'clicked' })()`
}

function clickAgreeExpr() {
  return `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='同意'); if(b){b.click(); return 'agreed'} return 'none' })()`
}

function fillCodeExpr(code, group) {
  return `(() => {
    ${headerHookCode(group)}
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
    // 关键：AiPy 内嵌页有 window.aipy，登录成功后页面才会跳 /api/oauth/authorize 拿 code；
    // 纯浏览器里没有这个对象，只会跳 /token。给它一个空壳，Vr() 就会走 OAuth 回调。
    window.aipy = window.aipy || { send: () => {} };
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) cb.click();
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === "立即登录");
    if (b) b.click();
    return "submitted";
  })()`
}

async function completeSignIn(c, data, meta = {}) {
  const access = data?.access_token ?? data?.accessToken ?? data?.token
  if (!access) {
    throw new Error(`登录响应里没有 access_token（字段：${Object.keys(data || {}).join(", ")}）`)
  }

  const self = await fetchSelf(access, data?.user?.id ?? data?.id)
  const uid = self?.id ?? data?.user?.id ?? data?.id
  const phone = self?.username ?? data?.user?.username ?? data?.username ?? ""
  const apiKey = await ensureApiKey(access, uid)
  const expiresIn = Number(data?.expires_in ?? 2_592_000)

  const known = isKnownAccount(uid)
  const ownCode = await rollInvite({ accountToken: access, uid, accountId: maskPhone(phone) || String(uid ?? "") }, { roll: !known })
  try {
    if (meta.group) {
      saveGroup({
        ...meta.group,
        uid,
        accountId: maskPhone(phone) || String(uid ?? ""),
        affCode: ownCode || meta.affCode || meta.group.affCode,
      })
    }
  } catch {}

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
  const out = [
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
        const group = pickGroup()
        const { verifier, challenge } = makePkce()
        const authUrl = new URL(`${c.WEB}/login`)
        authUrl.search = new URLSearchParams({
          code_challenge: challenge,
          code_challenge_method: "S256",
          response_type: "code",
          redirect_uri: "aipy-pro://oauth",
          scope: "all",
          client_id: "aipy-pro",
          lang: "zh",
        }).toString()
        const authorizeUrl = authUrl.toString()

        let session = null
        try {
          session = await launchLoginBrowser(authorizeUrl, { headless: true })
        } catch {
          session = await launchLoginBrowser(authorizeUrl, { headless: false })
        }

        try {
          // OAuth 授权页是 302 → /login，页面可能在「短暂出现输入框 → 再跳一次」之间切换。
          // 所以这里不是「看到一次就填」，而是每次填完再确认一次；页面换了就重来。
          let filled = ""
          let fillError = ""
          for (let i = 0; i < 30; i++) {
            let state = ""
            try {
              state = await evalInPage(session, `JSON.stringify({ phone: !!document.querySelector('#phone-number'), tab: [...document.querySelectorAll('button')].some(x => x.innerText.trim() === '手机号'), text: document.body.innerText.slice(0, 160), url: location.href })`)
            } catch {}
            if (state) {
              let o = null
              try { o = JSON.parse(state) } catch {}
              if (o) {
                if (o.text.includes("无效的重定向地址")) throw new Error("OAuth 授权页提示：无效的重定向地址")
                if (!o.phone) {
                  if (o.tab) await evalInPage(session, `(() => { const t=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='手机号'); t && t.click(); return 'ok' })()`).catch(() => {})
                } else {
                  // 等 300ms 再填：页面这期间若发生跳转，下一轮会重新找到输入框
                  await sleep(300)
                  try {
                    const f = await evalInPage(session, fillFormExpr(phone, inviteCode, group))
                    if (f) {
                      const x = JSON.parse(f)
                      if (x.phone) { filled = f; break }
                    }
                  } catch (e) { fillError = String(e?.message ?? e) }
                }
              }
            }
            await sleep(500)
          }
          if (!filled) {
            const where = await evalInPage(session, "location.href").catch(() => "?")
            const body = await evalInPage(session, "document.body.innerText").catch(() => "")
            const inputs = await evalInPage(session, `JSON.stringify([...document.querySelectorAll('input')].map(i => ({ id: i.id, ph: i.placeholder, type: i.type })))`).catch(() => "[]")
            throw new Error(`登录页没找到手机号输入框（页面：${String(where).slice(0, 100)}；正文：${String(body).replace(/\s+/g, " ").slice(0, 160)}；输入框：${String(inputs).slice(0, 200)}；填充错误：${String(fillError).slice(0, 200)}）`)
          }
          await sleep(250)
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
          url: authorizeUrl,
          // ⚠ 必须是 true：这条链路的浏览器已经由插件自己拉起来了（headless 或降级可见），
          //    opened:false 会让 magpie 再开一次系统默认浏览器 —— 用户就会看到网页登录页。
          opened: true,
          method: "code",
          instructions: `验证码已发送到 ${maskPhone(phone)}。把短信里的验证码填到下面，插件会自动完成登录。邀请上级：${inviteCode || "无"}。`,
          async callback(code) {
            const c0 = String(code || "").replace(/\D/g, "")
            if (c0.length < 4) return { type: "failed", error: "验证码是 4~8 位数字" }
            try {
              await evalInPage(session, fillCodeExpr(c0, group))
              await sleep(800)

              // 未勾协议/服务端风控会弹「登录或者注册需要同意…」的二次确认；点头同意。
              // 实测：同意之后 OAuth 页会走 /api/user/register/mobile，而不是被
              // “新增账号需下载 AiPy Pro 客户端”拦住。
              for (let i = 0; i < 4; i++) {
                const body = await evalInPage(session, "document.body.innerText").catch(() => "")
                if (!body.includes("登录或者注册需要同意")) break
                await evalInPage(session, clickAgreeExpr()).catch(() => {})
                await sleep(900)
              }

              // 点「立即登录」后先看页面有没有直接给出业务错误（尤其是未注册号的拦截）。
              // 以前这里直接 waitForLogin 180 秒，页面明明已经弹了提示，magpie 还一直转。
              let policyError = ""
              let retriedRegister = false
              for (let i = 0; i < 12; i++) {
                let body = ""
                try { body = await evalInPage(session, "document.body.innerText") } catch { break }
                if (body.includes("新增账号需下载AiPy Pro客户端")) {
                  if (!retriedRegister) {
                    // 先走 login/mobile（已注册号）；被新号策略拦住时，再切 register/mobile 重试一次。
                    retriedRegister = true
                    await evalInPage(session, `sessionStorage.setItem("layout", "false")`).catch(() => {})
                    await evalInPage(session, clickLoginExpr()).catch(() => {})
                    await sleep(1200)
                    continue
                  }
                  policyError = "这个手机号在 Trustoken 侧还没注册。服务端已关闭网页注册：新号码必须在 AiPy Pro 客户端首次运行并完成注册后，才能用网页验证码登录。"
                  break
                }
                if (/验证码错误|验证码已过期|请输入正确的验证码/.test(body)) {
                  policyError = "验证码错误或已过期，请重新获取验证码。"
                  break
                }
                if (body.includes("登录或者注册需要同意")) {
                  await evalInPage(session, clickAgreeExpr()).catch(() => {})
                  await sleep(900)
                  continue
                }
                if (body.includes("登录成功")) break
                await sleep(500)
              }
              if (policyError) return { type: "failed", error: policyError }

              const authCode = await waitForOAuthCode(session, { timeout: 90_000 })
              if (!authCode) {
                const body = await evalInPage(session, "document.body.innerText").catch(() => "")
                if (body.includes("新增账号需下载AiPy Pro客户端")) {
                  return { type: "failed", error: "这个手机号还没注册；Trustoken 仍要求先在 AiPy Pro 客户端完成首次注册。" }
                }
                return { type: "failed", error: "没有拿到 OAuth 授权码：登录未完成或页面已关闭。" }
              }
              const data = await exchangeOAuthCode({
                code: authCode,
                verifier,
                redirectUri: "aipy-pro://oauth",
              })
              return await completeSignIn(c, data, { group, affCode: inviteCode })
            } catch (e) {
              return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
            } finally {
              await closeSession(session).catch(() => {})
            }
          },
        }
      },
    },
    {
      type: "api",
      keyless: true,
      label: `${c.PROVIDER_NAME} 本机登录（读取 AiPy 会话）`,
      async authorize() {
        const tok = await readTrustokenToken()
        if (!tok?.access_token) throw new Error("本机没有 AiPy 登录态：先在 AiPy Pro 客户端登录这个手机号")
        const self = await fetchSelf(tok.access_token, "")
        const uid = self?.id
        if (!uid) throw new Error("AiPy 会话无效：/api/user/self 没有返回用户")
        const apiKey = await ensureApiKey(tok.access_token, uid)
        await rollInvite({ accountToken: tok.access_token, uid, accountId: maskPhone(self?.username) || String(uid) }, { roll: false })
        return {
          type: "success",
          access: apiKey,
          refresh: tok.access_token,
          expires: Number(tok.expires_at) || Date.now() + 30 * 86400e3,
          accountId: maskPhone(self?.username) || String(uid),
          uid: String(uid),
          apiKey,
          accountToken: tok.access_token,
          username: self?.username,
          quota: self?.quota,
        }
      },
    },
  ]

  // 邀请码按钮：0/留空 = 自动（作者码/滚动码），1 = 当前首选账号。
  // 保存后再走手机号验证码，注册时读到的就是刚选的码。
  out.push({
    type: "oauth",
    label: `${c.PROVIDER_NAME} 邀请码`,
    get prompts() {
      return [{ type: "text", key: "invite", message: "邀请码", placeholder: modeHint() }]
    },
    async ask(inputs) {
      if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, "invite")) {
        return { type: "text", key: "invite", message: "邀请码", placeholder: modeHint() }
      }
      if (!Object.prototype.hasOwnProperty.call(inputs, "phone")) return out[0].prompts[0]
      return null
    },
    async authorize(inputs) {
      saveInviteChoice(inputs?.invite)
      return await out[0].authorize(inputs)
    },
  })
  return out
}
