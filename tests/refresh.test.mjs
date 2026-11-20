// tests/refresh.test.mjs —— 锁死 refresh 钩子的语义（2026-11-20 事故）
//
//   node --test
//
// 事故：magpie 的 staleAccess() 对「未到期却被上游 401 拒掉」的 OAuth 账号
// 会把 plugin-auth.json 里的 expires 写成 1，等 refresh 去续。旧实现读到
// 1 就抛 signIn "expired"，五个号全部卡在「需要重新登录」，而令牌一直有效。
//
// 这一组锁的是：**判据以网关令牌的真实可用性为准，不是本地时间戳**。

import test from "node:test"
import assert from "node:assert/strict"

import { makeRefresh, RENEW_MS } from "../src/hooks/refresh.mjs"
import { ApiError } from "../src/api.mjs"

const DAY = 24 * 60 * 60 * 1000

function authWith(over = {}) {
  return {
    type: "oauth",
    access: "KEY",
    apiKey: "KEY",
    refresh: "LOGIN",
    accountToken: "LOGIN",
    uid: "182238",
    accountId: "189****8051",
    username: "18970098051",
    quota: 10110713,
    ...over,
  }
}

/** 记录 probe 调用 */
function probeOf(fn) {
  const calls = []
  const probe = async (key) => {
    calls.push(key)
    if (fn) return fn(key)
    return [{ id: "deepseek-flash" }]
  }
  probe.calls = calls
  return probe
}

test("① 没到期：不探网关、不返回任何字段", async () => {
  const probe = probeOf()
  const refresh = makeRefresh({}, { probe })
  const out = await refresh(authWith({ expires: Date.now() + 5 * DAY }))
  assert.equal(out, undefined)
  assert.equal(probe.calls.length, 0)
})

test("② 到期（宿主写的 expires = 1）+ 网关 200：续 30 天，不抛", async () => {
  const probe = probeOf()
  const refresh = makeRefresh({}, { probe })
  const before = Date.now()
  const out = await refresh(authWith({ expires: 1 }))
  assert.deepEqual(Object.keys(out), ["expires"], "只回 expires，其余字段由宿主合并保留")
  assert.equal(probe.calls.length, 1)
  assert.equal(probe.calls[0], "KEY")
  assert.ok(out.expires >= before + RENEW_MS - 1000, "续期窗口是 30 天")
  assert.ok(out.expires <= Date.now() + RENEW_MS + 1000)
})

test("③ 网关 401：令牌真失效，抛 signIn expired", async () => {
  const probe = probeOf(() => {
    throw new ApiError("API令牌无效", { status: 401 })
  })
  const refresh = makeRefresh({}, { probe })
  await assert.rejects(
    () => refresh(authWith({ expires: 1 })),
    (e) => e.signIn === "expired",
  )
})

test("④ 网关 403：同样按失效处理", async () => {
  const probe = probeOf(() => {
    throw new ApiError("forbidden", { status: 403 })
  })
  const refresh = makeRefresh({}, { probe })
  await assert.rejects(
    () => refresh(authWith({ expires: 1 })),
    (e) => e.signIn === "expired",
  )
})

test("⑤ 网络错 / 5xx：不标失效（否则一次抖动就把号打死）", async () => {
  for (const err of [new Error("ECONNRESET"), new ApiError("bad gateway", { status: 502 })]) {
    const probe = probeOf(() => {
      throw err
    })
    const refresh = makeRefresh({}, { probe })
    await assert.rejects(
      () => refresh(authWith({ expires: 1 })),
      (e) => e === err && e.signIn === undefined,
    )
  }
})

test("⑥ 只有 access（老账号没有 apiKey 字段）：用它探", async () => {
  const probe = probeOf()
  const refresh = makeRefresh({}, { probe })
  const a = authWith({ expires: 1 })
  delete a.apiKey
  const out = await refresh(a)
  assert.ok(out.expires > Date.now())
  assert.equal(probe.calls[0], "KEY")
})

test("⑦ 两个 key 都没有：直接判失效，不发请求", async () => {
  const probe = probeOf()
  const refresh = makeRefresh({}, { probe })
  const a = authWith({ expires: 1 })
  delete a.apiKey
  delete a.access
  await assert.rejects(
    () => refresh(a),
    (e) => e.signIn === "expired",
  )
  assert.equal(probe.calls.length, 0)
})

test("⑧ 没有 expires / auth 为空：不动（renewAt 也不会排它）", async () => {
  const probe = probeOf()
  const refresh = makeRefresh({}, { probe })
  assert.equal(await refresh(undefined), undefined)
  assert.equal(await refresh(authWith({ expires: 0 })), undefined)
  assert.equal(await refresh(authWith({ expires: undefined })), undefined)
  assert.equal(probe.calls.length, 0)
})