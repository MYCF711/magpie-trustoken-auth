// ③ auth.refresh(auth) —— 续期
//
// Trustoken 的 access_token 30 天，**没有公开的 refresh 端点**（网页端也没有）。
// 所以这里不做网络续期：没到期就返回 undefined；到期就明确抛 signIn expired，
// 让用户重新手机号登录。
//
// ⚠ 返回的是「合并」语义：只回新字段会覆盖旧字段。这里什么都不回，最安全。

export function makeRefresh(c) {
  return async (auth) => {
    if (!auth) return undefined
    const expires = Number(auth.expires || 0)
    if (!expires) return undefined
    if (Date.now() < expires - 60_000) return undefined
    throw Object.assign(new Error("Trustoken 账号登录已过期，请重新登录"), { signIn: "expired" })
  }
}
