// tests/quota-fallback.test.mjs —— 登录令牌失效后「余额还能不能显示」
//
//   node --test
//
// 起因（2026-11-28 主人截图）：5 个 AiPy 账号里 3 个卡片写着
//   「暂时无法获取额度：无权进行此操作，access token 无效」
// 实测三件事：① 这 3 个号的登录 access_token 确实被上游作废（没有 refresh 可续）；
// ② 同一个号的网关 apiKey 仍能跑模型（/v1/models 200）；③ OpenAI 兼容计费端点
// 认这把 apiKey，换算出来的灵石与 /api/user/self 逐位相同。
// 这一组锁的是：余额改走计费口径、登录失效的定性文案、以及换算公式本身。

import test from "node:test"
import assert from "node:assert/strict"

import { ApiError, fetchBillingBalance, isAccountLoginDead } from "../src/api.mjs"
import { makeUsage, usageErrorText, LOGIN_DEAD_HINT } from "../src/hooks/usage.mjs"
import { setOptionReader, optionOn, markReloginOn, MARK_RELOGIN_OPTION } from "../src/flags.mjs"
import { usage } from "../src/quota.mjs"

const ctx = { PROVIDER: "trustoken", PROVIDER_NAME: "爱派 AiPy" }

/** 上游对作废登录令牌的原话（HTTP 200 + success:false） */
function deadTokenError() {
  return new ApiError("无权进行此操作，access token 无效", { status: 200, url: "https://www.trustoken.cn/api/user/self" })
}

function oauthAuth(over = {}) {
  return {
    type: "oauth",
    access: "GATEWAY_KEY",
    apiKey: "GATEWAY_KEY",
    refresh: "LOGIN_TOKEN",
    accountToken: "LOGIN_TOKEN",
    uid: "183101",
    accountId: "180****2361",
    username: "18000712361",
    ...over,
  }
}

// ── 换算公式（对着两个真实账号的逐值对拍） ────────────────────────────

test("billing: 剩余灵石 = hard_limit_usd × 100 − total_usage（实测 94 / 7347.3022）", async () => {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const body = String(url).endsWith("/dashboard/billing/subscription")
      ? { object: "billing_subscription", hard_limit_usd: 94, soft_limit_usd: 94 }
      : { object: "list", total_usage: 7347.3022 }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    const b = await fetchBillingBalance("GATEWAY_KEY")
    // /api/user/self 当时给的是 quota=10,263,489 ⇒ 2052.70 灵石
    assert.equal(b.stones.toFixed(2), "2052.70")
    assert.equal(b.used.toFixed(4), "7347.3022")
    assert.equal(calls.length, 2)
  } finally {
    globalThis.fetch = real
  }
})

test("billing: 另一个账号 96.5 / 7878.809 ⇒ 1771.19（self.quota 8,855,955）", async () => {
  const real = globalThis.fetch
  globalThis.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("/subscription") ? { hard_limit_usd: 96.5 } : { total_usage: 7878.809 },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  try {
    const b = await fetchBillingBalance("GATEWAY_KEY")
    assert.equal(b.stones.toFixed(2), "1771.19")
  } finally {
    globalThis.fetch = real
  }
})

test("billing: 没有令牌 / 字段缺失都抛，别静默返回 0（0 会被当「已耗尽」）", async () => {
  await assert.rejects(() => fetchBillingBalance(""), /没有可用的网关令牌/)
  const real = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ object: "nope" }), { status: 200, headers: { "content-type": "application/json" } })
  try {
    await assert.rejects(() => fetchBillingBalance("GATEWAY_KEY"), /hard_limit_usd/)
  } finally {
    globalThis.fetch = real
  }
})

// ── 定性：哪句文案才算「登录令牌作废」 ────────────────────────────────

test("classify: 上游原话判成登录失效；额度/网络类不误判", () => {
  assert.equal(isAccountLoginDead(deadTokenError()), true)
  assert.equal(isAccountLoginDead(new ApiError("token is invalid", { status: 200 })), true)
  assert.equal(isAccountLoginDead(new ApiError("未登录", { status: 401 })), true)
  assert.equal(isAccountLoginDead(new ApiError("余额不足，请充值", { status: 200 })), false)
  assert.equal(isAccountLoginDead(new ApiError("HTTP 502", { status: 502 })), false)
  assert.equal(isAccountLoginDead(new TypeError("fetch failed")), false)
})

test("classify: 登录失效的 error 文案不再说「暂时」", () => {
  const text = usageErrorText(deadTokenError())
  assert.equal(text, LOGIN_DEAD_HINT)
  assert.ok(!text.includes("暂时"))
  assert.ok(text.includes("重新登录"))
  assert.ok(text.includes("模型调用不受影响"))
  // 认不出的失败仍然原样带着上游原因，方便排障；
  // 也**不许**自己加「暂时无法获取额度：」—— 那是 magpie 给 usage.error 加的，
  // 自己再加一层就会在卡片上看到两遍。
  assert.equal(usageErrorText(new ApiError("HTTP 502", { status: 502 })), "HTTP 502")
})

// ── usage 钩子三段行为 ───────────────────────────────────────────────

test("usage: 账号接口正常时口径不变（余额来自 self.quota，不提计费）", async () => {
  const hook = makeUsage(ctx, {
    fetchSelf: async () => ({ quota: 10_263_489, used_quota: 36_736_511 }),
    fetchBilling: async () => {
      throw new Error("这条路径不该走计费")
    },
  })
  const u = await hook(async () => oauthAuth())
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].name, "灵石")
  assert.equal(u.windows[0].balance, 2052.6978)
  assert.equal(u.windows[0].used, undefined)
  assert.ok(!u.windows[0].display.includes("网关计费"))
  assert.equal(u.error, undefined)
})

test("usage: 登录令牌作废 → 改走网关计费，余额照常显示并写明签到要重新登录", async () => {
  const hook = makeUsage(ctx, {
    fetchSelf: async () => {
      throw deadTokenError()
    },
    fetchBilling: async (key) => {
      assert.equal(key, "GATEWAY_KEY")
      return { stones: 32_002.8444, used: 64_367.157 }
    },
  })
  const u = await hook(async () => oauthAuth())
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].balance.toFixed(2), "32002.84")
  assert.match(u.windows[0].display, /网关计费口径/)
  assert.match(u.windows[0].display, /签到不可用/)
  // 「登录已失效」放在 plan 徽标上（账号行最显眼的那格），display 不再重复一遍
  assert.match(u.plan, /无法签到/)
  assert.equal(u.error, undefined)
  // 窗口形状仍要过 quota.mjs 的五类拦截（钱包型不许给 used）
  assert.doesNotThrow(() => usage(u))
})

test("usage: 账号接口只是网络抖动 → 一样走计费，但不诬指登录失效", async () => {
  const hook = makeUsage(ctx, {
    fetchSelf: async () => {
      throw new TypeError("fetch failed")
    },
    fetchBilling: async () => ({ stones: 100, used: 1 }),
  })
  const u = await hook(async () => oauthAuth())
  assert.match(u.windows[0].display, /网关计费口径/)
  assert.ok(!u.windows[0].display.includes("登录令牌已失效"))
})

test("usage: 两条路都断 → 报根因（登录失效），而不是计费的次生错误", async () => {
  const hook = makeUsage(ctx, {
    fetchSelf: async () => {
      throw deadTokenError()
    },
    fetchBilling: async () => {
      throw new ApiError("HTTP 502", { status: 502 })
    },
  })
  const u = await hook(async () => oauthAuth())
  assert.deepEqual(u.windows, [])
  assert.equal(u.error, LOGIN_DEAD_HINT)
})

test("usage: 没有账号 token 但有 apiKey → 仍能显示余额", async () => {
  const hook = makeUsage(ctx, {
    fetchSelf: async () => {
      throw new Error("不该被调用")
    },
    fetchBilling: async () => ({ stones: 12.5, used: 3 }),
  })
  const u = await hook(async () => oauthAuth({ accountToken: "", refresh: "" }))
  assert.equal(u.windows[0].balance, 12.5)
})

test("usage: API Key 登录不显示余额（口径不变）", async () => {
  const hook = makeUsage(ctx, {})
  const u = await hook(async () => ({ type: "api", key: "sk-x" }))
  assert.deepEqual(u.windows, [])
  assert.match(u.error, /API Key/)
})
test("usage: 既没有账号 token 也没有 apiKey → 直说重新登录，不用「暂时」兜", async () => {
  const hook = makeUsage(ctx, {})
  const u = await hook(async () => oauthAuth({ accountToken: "", refresh: "", apiKey: "", access: "" }))
  assert.deepEqual(u.windows, [])
  assert.equal(u.error, "没有账号 token，请重新登录")
})

// ── 「别人看起来像正常账号」：卡片上必须一眼看得出要重新登录 ──────────
//
// magpie 的账号行里最显眼的字段是 plan（截图里那个「灵石制」徽标），所以登录令牌
// 失效时 plan 必须带标注。**默认只改文案、不动账号状态** —— 标记会让 magpie 在
// 重新登录前不再往这个号发请求，而它的模型调用（永久 apiKey）其实一直是好的。

test("usage: 登录令牌失效 → plan 徽标带「无法签到」，默认不标记账号", async () => {
  const hook = makeUsage(ctx, {
    fetchSelf: async () => {
      throw deadTokenError()
    },
    fetchBilling: async () => ({ stones: 100, used: 1 }),
  })
  const u = await hook(async () => oauthAuth({ accountId: "189****8051" }))
  assert.match(u.plan, /无法签到/)
  assert.equal(u.signIn, undefined, "默认绝不能把账号标成 expired —— 那会让 magpie 停用这个号")
  assert.equal(u.windows.length, 1)
})

test("usage: 正常账号的 plan 不带标注（别给健康账号挂红牌）", async () => {
  const hook = makeUsage(ctx, {
    fetchSelf: async () => ({ quota: 10_000_000, used_quota: 1_000_000 }),
    fetchBilling: async () => ({ stones: 1, used: 1 }),
    option: () => true,
  })
  const u = await hook(async () => oauthAuth())
  assert.equal(u.plan, "灵石制")
  assert.equal(u.signIn, undefined)
})

test("usage: 开关开 → 返回 signIn: expired（换官方的「点此重新登录」按钮）", async () => {
  const seen = []
  const hook = makeUsage(ctx, {
    fetchSelf: async () => {
      throw deadTokenError()
    },
    fetchBilling: async () => ({ stones: 100, used: 1 }),
    option: (key) => {
      seen.push(key)
      return key === "mark-relogin"
    },
  })
  const u = await hook(async () => oauthAuth())
  assert.deepEqual(seen, ["mark-relogin"])
  assert.equal(u.signIn, "expired")
  assert.equal(u.windows.length, 1, "标记的同时余额仍然给（重新登录前用户还要看余额）")
  assert.match(u.plan, /无法签到/)
})

test("flags: 没有 reader / reader 抛错 一律当关（绝不让读开关失败改账号状态）", () => {
  assert.equal(optionOn("no-such-provider-xyz", "mark-relogin"), false)
  setOptionReader("p-throws", () => {
    throw new Error("old magpie")
  })
  assert.equal(optionOn("p-throws", "mark-relogin"), false)
  setOptionReader("p-on", (key) => key === "mark-relogin")
  assert.equal(optionOn("p-on", "mark-relogin"), true)
  assert.equal(markReloginOn("p-on"), true)
  assert.equal(markReloginOn("no-such-provider-xyz"), false)
})
