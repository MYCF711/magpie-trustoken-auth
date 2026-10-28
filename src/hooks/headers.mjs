// ⑧ "chat.headers"(input, output) —— 每个请求加头
//
// 只加一个会话 id，便于上游排障；不改 authorization（loader 已经给了 apiKey）。

export function makeHeaders(c) {
  return async (input, output) => {
    const providerID = input?.model?.providerID ?? input?.provider?.info?.id
    if (providerID !== c.PROVIDER) return
    if (!input?.sessionID) return
    output.headers["x-trustoken-session"] = String(input.sessionID).slice(0, 128)
  }
}
