# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页。读完再读 `AGENTS.md`、`docs/internals.md`。
> **每次干完活回来更新「当前状态」与「下一步」。**

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `magpie-trustoken-auth` |
| 包内 name | `Trustoken`（npm：`magpie-trustoken-auth`） |
| 当前版本 | `0.3.2`（在 `fix/error-classify` 分支，未合并到 main） |
| 承载供应商 | 爱派AiPy（显示名；provider id `trustoken`，npm 包名 `magpie-trustoken-auth`） |
| 上游门户 | `api.trustoken.cn` |
| 现状负责人 | `trustoken-400` 专员（2026-10-30） |

## 二、当前状态（2026-10-30 17:xx）

```
main              7d301f8 ci: require pull request checks before release (#1)
fix/error-classify 552fc29 feat(0.3.2): 上游 400/422 按语义翻译…
PR #2             OPEN / rules pass / MERGEABLE / 未合并
```

**已合并进分支、已推、已提 PR，等你（Lead）决定合并与发版。**

## 三、这一版做了什么

主人报的问题：「这个供应商插件会出现 400 报错问题，然后打断 dsh 里面的正常运行，而不是被 magpie 智能路由跳过」。

根因（有原件）：插件原本**没有自定义 `fetch`**，`loader.mjs` 只返回 `baseURL + apiKey`，上游 400 直传 magpie；magpie 的 `retryable()` 对 `case 400,422` 只认 quotaWords/unservedWords 等词表，而实际文案是 `bad response status code 400`（new-api 渠道自己坏了），一个词都不命中 ⇒ 不换号 ⇒ 错误直达客户端。

修法：新增 `src/status.mjs` 做**语义翻译**，`loader` 增加 `fetch(input, init)` 包装（不改请求体/Authorization/头）：

| 上游 400/422 内容 | 翻成 | magpie 后果 |
|---|---|---|
| 钱（灵石/积分/余额/额度/欠费/充值） | **402** | 换号 + 该号按「没钱」休息 30 分钟 |
| 渠道坏（`bad response status code` / 无可用渠道 / 上游错误） | **502** | 换号 + 1 分钟起步 backoff（**不冤枉成欠费**） |
| 模型不存在/未开通/无权 | **404** | 换号；**绝不 401**（401 = 登录失效，整号被停） |
| 自己明说「每分钟 / too many requests」 | **429** | 换号 + 按限流退队尾 |
| 上下文过长 / `invalid_text_request` / 其它 | **原样** | 该压缩就压缩，该报错就报错 |
| 非 400/422 | **同一个 Response 对象** | 一个字都不读（200 是 SSE 干流） |

## 四、下一步

1. **合并 PR #2**（rules 已绿）→ 从与 `origin/main` 一致的提交发版（tag + Release + npm）
2. **装进 magpie 验 live 端到端**（唯一未验证项）：

```bash
curl -s http://127.0.0.1:3425/v1/magpie/trace
# 看 trustoken 的 try 里出现 status: 502 / fail: "other" / rest.by: "backoff"
# 且路由继续问下一个账号，不再 done=true 直接收尾
```

3. 主人后续需求（排在 400 之后）：
   - **签到 + 每日任务自动化**：AiPy 有 1 个签到（每日 8:00–22:00）+ 2 个每日 AI 任务（1 次给 50 灵石、5 次给 150 灵石）；要求把签到做成「自动完成每日任务」
   - **登录流程简化**：现在「添加账号」有 4 个按钮（手机号无头/本机登录/复制邀请码下载客户端/邀请码），太复杂；应该插件自动判断——**有账号就不该弹下载安装包链接**；且用户要在软件里自己填邀请码注册新号，然后走插件导入桌面登录态
   - **无头模式操控桌面软件加账号**：AiPy Pro 软件底部有「切换账号 → 添加账号」，走那里能正确填邀请码、过人机验证、拿新登录态；主人说「如果非要有这个软件，那么无头模式应该是静默操控这个软件进行添加账号」

## 五、硬约束

- **禁止直推 main**：功能分支 → PR → `rules` 全绿 → 合并 → 发版
- **绝不关闭 magpie**（本会话自己走它的网关 `127.0.0.1:3425`），只允许 Stop-Process 后立刻 Start-Process 同一个 exe
- `src/api.mjs` 的 `asModelError` / `asSignInExpired` / `isAuthFailure` **仍是死函数（零调用）**，属另一件事，别顺手接
- `src/chat.mjs` 的 `passThrough` / `withUsage` / `singleShotToSSE` 也是死代码，同样先放着
- `loader.mjs` 的 `user-agent` 还写着 `magpie-trustoken-auth/0.1.0`（包已是 0.3.x），**待修**

## 六、交付自检

```bash
node --test                                  # 26 pass
node tests/error-classify.mjs                # 25 通过
node "D:/主工作区/projects/magpie-plugin-scaffold/scripts/check.mjs" .   # 29 通过 / 0 失败
npm pack --dry-run
```

## 七、给接手者的最短路径

1. 读本文件
2. `git log --oneline -5` + `git status` 核实现状（别信台账里的旧快照）
3. 读 `docs/internals.md` 第十节「实测：上游 400 为什么打断会话，怎么修的」
4. 干活 → 自检 → 更新本文件 → 回报 Lead