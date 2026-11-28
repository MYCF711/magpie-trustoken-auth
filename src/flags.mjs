// src/flags.mjs —— 供应商编辑器里的布尔开关
//
// magpie 的 PluginOptions 是 `map[provider]map[key]bool`，**只支持布尔**。
// 开关本身不是插件画的：它是 `auth.options`（index.mjs 声明），插件通过
// `input.magpie.option(provider, key)` 读 —— 每次读都是当前值，拨一下立刻生效。
//
// 所以这里只存「怎么读」：index.mjs 在工厂里 `setOptionReader(PROVIDER, reader)`，
// 别的模块拿 key 来问。读不到（没注册 / 老 magpie 没这个 API / 抛错）一律当**关** ——
// 也就是「保持默认行为」，绝不让读开关失败把人家的账号状态改掉。

const readers = new Map()

/**
 * 「登录令牌失效时，把这个账号标记成需要重新登录」。
 *
 * ⚠ 这个开关有真实代价（官方文档「登录状态」写得很清楚：**标记之后 magpie 在账号恢复前
 *   不再往它发请求**）。而 AiPy 的账号令牌失效时，模型调用（走永久 apiKey）其实还是好的 ——
 *   所以默认**关**：卡片上用 plan 标注「登录已失效」，但不夺走这个号的模型调用。
 *   开 = 换那个「点此重新登录」按钮，代价是这个号在重新登录前不接请求。
 */
export const MARK_RELOGIN_OPTION = "mark-relogin"

/** 把「怎么读这个供应商的开关」交给 flags.mjs */
export function setOptionReader(siteId, read) {
  if (typeof read === "function") readers.set(siteId, read)
}

/** 某个开关现在是开的吗（读不到 = 关） */
export function optionOn(siteId, key) {
  const read = readers.get(siteId)
  if (!read) return false
  try {
    return read(key) === true
  } catch {
    return false
  }
}

/** 「登录失效时标记为需重新登录」开着吗 */
export function markReloginOn(siteId) {
  return optionOn(siteId, MARK_RELOGIN_OPTION)
}
