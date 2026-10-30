// ② auth.methods[] —— 登录 / 添加账号的入口，按「本机有没有该供应商账号」自动分流
//
//   · 有账号（plugin-auth.json 里有 trustoken / trustoken#…）：
//       只留一个「本机登录（读取 AiPy 会话）」—— 点一下就把 AiPy Pro 客户端里
//       已经登录的号导入 magpie，无输入、无选择页。
//   · 没有账号：
//       ① 「首次使用：下载 AiPy Pro 客户端注册」（问邀请码模式 → 下载链接 → 轮询登录态）
//       ② 「本机登录（读取 AiPy 会话）」（客户端已经装好的人免下载）
//       ③ 「手机号登录（无头浏览器）」（已注册的手机号直接登录）
//
// 「有没有账号」只能只读 ~/.config/magpie/plugin-auth.json（magpie 不给插件账号列表
// API，理由与口径见 src/accounts.mjs 文件头）。读不到时保守按「有账号」处理。
//
// ⚠ label 一律稳定文案（magpie 在插件加载时读走并缓存，见 magicrew AGENTS 坑 31）；
//   动态信息（邀请码、本次会做什么）全部放进 authorize() 返回的 instructions。
// ⚠ 列表层是按账号状态现算的（index.mjs 的 `get methods()` + magpie 每次 providers RPC
//   都会读 auth.methods）；但**行为层还有第二道兜底** —— 下载入口的 authorize() 会
//   再判一次账号，有账号时绝不返回下载链接。
//
// 手机号登录流程（无账号时的入口之一）：
//   1. 用户在 magpie 里填手机号；
//   2. 插件在后台（headless Chromium）打开 Trustoken 官方登录页；
//   3. 自动填手机号、勾选协议、填邀请码；
//   4. 点「获取验证码」→ 自动解滑块 → 短信发出；
//   5. 用户在 magpie 里填验证码；
//   6. 插件自动填验证码、点「立即登录」，捕获登录响应，创建 API Key。

import { createHash, randomBytes } from "node:crypto"
import { fetchSelf, ensureApiKey } from "../api.mjs"
import { readTrustokenToken } from "../aipy-local.mjs"
import { execFileSync } from "node:child_process"
import { exchangeOAuthCode } from "../oauth.mjs"
import { launchLoginBrowser, closeSession, evalInPage, solveSlider, dragSlider, waitForOAuthCode } from "../browser-login.mjs"
import { inviteToUse, rollInvite, modeHint, saveInviteChoice, isKnownAccount } from "../invite.mjs"
import { hasAccounts } from "../accounts.mjs"
import { defaultGroup, pickGroup, saveGroup, headersFromGroup } from "../header-groups.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CLIENT_DOWNLOAD_URL = "https://promo.aipyaipy.com/downloads/aipy-pro-2.1.1-x64.exe"

function copyToClipboard(text) {
  try {
    if (process.platform === "win32") {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Value '${String(text).replace(/'/g, "''")}'`], { timeout: 5000, windowsHide: true })
    }
  } catch {}
}

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

export function makeMethods(c, deps = {}) {
  // 依赖可注入是给测试用的：入口集合必须能按「本机有没有该供应商账号」现算，
  // 测试不该去读这台机器真实的 plugin-auth.json / AiPy 客户端。
  const {
    hasAccounts: hasAccountsNow = () => hasAccounts(c.PROVIDER),
    isKnown: isKnownNow = (uid) => isKnownAccount(uid),
    readToken: readTokenNow = () => readTrustokenToken(),
    fetchSelf: fetchSelfNow = (token, uid) => fetchSelf(token, uid),
  } = deps
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
        const tok = await readTokenNow()
        if (!tok?.access_token) {
          throw new Error(
            "本机没有 AiPy 登录态：请先在 AiPy Pro 客户端登录要添加的手机号，再回来点「本机登录（读取 AiPy 会话）」。首次使用才需要下载客户端。",
          )
        }
        const self = await fetchSelfNow(tok.access_token, "")
        const uid = self?.id
        if (!uid) throw new Error("AiPy 会话无效：/api/user/self 没有返回用户")
        const accountId = maskPhone(self?.username) || String(uid)
        // 查重：客户端还停在一个已经在 magpie 里的号上时，别让用户以为「新号加上了」。
        // magpie 的 settle 遇到同 accountId+uid 是替换旧账号，不查重就是静默没变化。
        if (isKnownNow(uid)) {
          throw new Error(
            `本机 AiPy 当前登录的是 ${accountId}，这个号已经在 magpie 里了。要添加新号：先在 AiPy Pro 客户端切换到那个号，再点一次「本机登录（读取 AiPy 会话）」。`,
          )
        }
        const apiKey = await ensureApiKey(tok.access_token, uid)
        await rollInvite({ accountToken: tok.access_token, uid, accountId }, { roll: false })
        return {
          type: "success",
          access: apiKey,
          refresh: tok.access_token,
          expires: Number(tok.expires_at) || Date.now() + 30 * 86400e3,
          accountId,
          uid: String(uid),
          apiKey,
          accountToken: tok.access_token,
          username: self?.username,
          quota: self?.quota,
        }
      },
    },
  ]

  // 首次登录 = 下载 AiPy Pro 客户端并在客户端内注册，然后等本机 token 出现。
  // 不再走网页 /api/user/register/mobile（服务端对新号是硬拦截）。
  // 邀请码先选：0/留空 = 自动，1 = 当前首选；选完再给下载链接。
  //
  // ⚠ 这条路**只在「本机 0 个账号」时出现**（见函数末尾按 hasAccounts() 拼列表）。
  //   即便 magpie 的 providers 列表缓存还是旧的、把这个入口显示给了有账号的人，
  //   authorize() 里也会再判一次：有账号就**绝不返回下载链接**，直接给「请走本机登录」。
  //   这就是「缓存不刷新，行为层兜底仍然正确」的那一层。
  const firstLoginMethod = {
    type: "oauth",
    // label 必须是稳定文案：magpie 在插件加载时把 methods[].label 读走缓存，
    // 动态邀请码放进 authorize 的 instructions（magicrew AGENTS 坑 31）。
    label: `${c.PROVIDER_NAME} 首次使用：下载 AiPy Pro 客户端注册`,
    async ask(inputs) {
      // 有账号 → 一个问题都不问（理论上这个入口不会出现，兜住旧缓存）
      if (hasAccountsNow()) return null
      if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, "invite")) {
        return { type: "text", key: "invite", message: "邀请码", placeholder: modeHint() }
      }
      return null
    },
    async authorize(inputs) {
      // 行为层兜底：有账号时绝不再走下载（详见上面的注释）
      if (hasAccountsNow()) {
        return {
          url: "",
          opened: true,
          method: "auto",
          instructions: "你已经有 Trustoken 账号了：这次不会再走下载安装。",
          async callback() {
            return {
              type: "failed",
              error:
                "你已经有 Trustoken 账号了：请在 AiPy Pro 客户端登录要添加的号，再用「本机登录（读取 AiPy 会话）」导入；下载入口只给还没有账号的人。",
            }
          },
        }
      }
      saveInviteChoice(inputs?.invite)
      const code = inviteToUse()
      const url = CLIENT_DOWNLOAD_URL
      copyToClipboard(code)
      const first = await readTokenNow().catch(() => null)
      const firstToken = first?.access_token || ""
      return {
        url,
        opened: false,
        method: "auto",
        instructions: `邀请码 ${code} 已复制到剪贴板。
下载安装包后，在 AiPy Pro 客户端里用新手机号完成首次注册；登录成功后这个窗口会自动导入登录态，不用再回来点任何东西。
下载链接：${url}`,
        async callback() {
          const deadline = Date.now() + 10 * 60 * 1000
          while (Date.now() < deadline) {
            const tok = await readTokenNow().catch(() => null)
            if (tok?.access_token && tok.access_token !== firstToken) {
              return await completeSignIn(c, { access_token: tok.access_token, refresh_token: tok.refresh_token || tok.access_token }, { group: defaultGroup(), affCode: code })
            }
            await sleep(2000)
          }
          return { type: "failed", error: "等待 AiPy Pro 登录超时（10 分钟）：请确认客户端已登录新号" }
        },
      }
    },
  }

  // 入口集合按「本机有没有该供应商的账号」现算：
  //   有账号（≥1）→ 只留「本机登录」一条：主人原话「有账号就直接走软件登录」，不要再弹下载。
  //   没有账号     → 才露出「首次使用：下载客户端注册」，外加本机登录（客户端已装的人免下载）
  //                 和手机号登录（已注册的号）。
  // out = [手机号登录, 本机登录]
  if (hasAccountsNow()) return [out[1]]
  return [firstLoginMethod, out[1], out[0]]
}
