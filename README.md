# Trustoken（AiPy）for magpie

**一个 key 用 13 个模型：DeepSeek / Qwen / GLM / 豆包 / Kimi / 混元 / MiMo，外加每天 100 灵石签到和 50+150 灵石每日任务。**

Trustoken（trustoken.cn）是 AiPy 的官方 token 分发商，`api.trustoken.cn/v1` 是 OpenAI 兼容网关。这个插件把它的账号体系接进 magpie：登录、模型目录、灵石余额、签到、每日任务。

```
13 个模型        DeepSeek V4.1 Flash / V4 Pro、Qwen 3.8 Flash / Max、GLM 5.3 Flash / 5.2、Doubao 2.1、Kimi K3、Hunyuan 3/4、MiMo 2.5
100 灵石/天      签到（08:00–22:00 北京时间；连续签到有阶梯加赠）
50 + 150 灵石    每日完成 1 次 / 5 次 AI 任务
0.7471           qwen3.8-flash 的输入倍率（quota/token），全表最低
```

---

## 功能

- **添加账号自动分流** —— 本机已有 Trustoken 账号时，添加账号**只显示「本机登录（读取 AiPy 会话）」一个入口**：点一下就把 AiPy Pro 客户端里已经登录的号导入 magpie，无输入、无选择页、不再拿下载链接挡人。只有本机 **0 个账号**时才出现「首次使用：下载 AiPy Pro 客户端注册」（邀请码 + 下载链接 + 自动等登录态）、「本机登录」和「手机号注册 / 登录」三条路。新号也可以直接用「手机号注册 / 登录」在插件里注册，不用装客户端。
- **手机号注册 / 登录** —— 插件直接调官方接口：你填手机号 → 收到短信 → 填验证码，**新号自动完成注册**、老号直接登录。不开浏览器窗口、不装/不启动 AiPy 客户端、不用人过滑块。只需要你两步：填手机号、填验证码。
- **模型目录** —— 登录后按账号实时拉 `/v1/models`，未登录用 13 个静态模型兜底。
- **灵石余额** —— `/api/user/self` 的 quota ÷ 5000，卡片上直接显示。
- **自动签到** —— 北京时间 08:00–22:00；窗口外返回失败，让 magpie 当天晚些时候重试。
- **每日任务** —— 自动领取 `claimable` 的奖励（50 / 150 灵石）；未完成的用最低价模型补请求。
- **邀请码** —— 注册新号时带 `aff_code`：默认作者码 `Chdr`（可用 `TRUSTOKEN_INVITE` 覆盖），也可在登录弹窗里填自己的码；每次登录 / 签到自动滚动当前账号自己的码。插件**不带任何账号身份**（不把谁家的 uid / accountId 当默认值）。
- **图片能力写死** —— 只有 `qwen3.8-flash` 与 `kimi/kimi-k3` 标记为可收图；其余模型一律 `image: false`，绝不把图片发出去被上游路由到别的模型。
- **模型错误 404** —— 单个模型不可用只搁置该模型，不误伤整个账号。
- **上游错误码翻译（不打断会话）** —— 上游偶发用 400 报「渠道自己坏了」（`bad response status code 400`）时，插件按语义翻译成 magpie 认得的码：渠道坏了 → **502**、钱不够（灵石/积分/余额/额度/充值/insufficient balance…）→ **402**、模型不存在/未开通/无权 → **404**、400 里明说每分钟的限流 → **429** ⇒ 智能路由换下一个账号重试，而不是把 400 摔给客户端把会话打断。上下文过长与请求格式错误**原样放行** —— 换账号一样失败，还要留着让 agent 去压缩上下文。

---

## 模型

**DeepSeek / Qwen / GLM / 豆包 / Kimi / 混元 / MiMo** —— 登录后跟随平台目录上下架。

| 发行商 | 代表模型 | 上下文 | 图片 | 倍率（输入/输出 quota per token） |
|---|---|---|---|---|
| DeepSeek | `deepseek-flash`（V4.1 Flash） | 1M | ✗ | 0.7498 / 2.9984 |
| DeepSeek | `deepseek-v4-pro` | 1M | ✗ | ≈0.75 / ≈3.0 |
| Qwen | `qwen3.8-flash` | 1M | ✓ | **0.7471 / 2.2538** |
| Qwen | `qwen3.8-max` | 1M | ✗ | ≈0.75 / ≈3.0 |
| 智谱 | `glm-5.3-flash` | 1M | ✗ | ≈0.75 / ≈3.0 |
| 智谱 | `glm-5.2` | 1M | ✗ | ≈0.75 / ≈3.0 |
| 豆包 | `Doubao-Seed-2.1-Turbo` | 256K | ✗ | 2.2498 / 11.5001 |
| 豆包 | `Doubao-Seed-2.1-Pro` | 256K | ✗ | ≈2.25 / ≈11.5 |
| Kimi | `kimi/kimi-k3` | 1M | ✓ | ≈0.75 / ≈3.0 |
| 混元 | `hy3` | 256K | ✗ | 0.7517 / 2.9996 |
| 混元 | `hy4-preview` | 1M | ✗ | ≈0.75 / ≈3.0 |
| 小米 | `xiaomi/mimo-v2.5-pro` | 256K | ✗ | ≈0.75 / ≈3.0 |

> 倍率是 2026-10-29 对 `https://api.trustoken.cn/v1` 的实测值（解二元一次方程，prompt 带随机串避免缓存）；完整测量方法见 [docs/internals.md](./docs/internals.md)。`≈` 是与实测模型同档（`/api/pricing` 的 `model_ratio` 同为 37.5）但未单独测的条目。
>
> 换算：500,000 quota = 1 元；`qwen3.8-flash` 的输入约 ¥1.49 / 1M token、输出约 ¥4.51 / 1M token。

**最低消费模型是 `qwen3.8-flash`** —— 输入与 hy3/deepseek-flash 同价，输出便宜 25%。插件补每日任务时固定用它。

---

## 签到 / 每日任务（任务 = 会话）

- **签到**：每天北京时间 08:00–22:00，`POST /api/user/checkin`，基准 100 灵石；连续签到按阶梯加赠。magpie 每账号每天调一次 `auth.checkin`，失败当天会重试。
- **每日任务**：`daily_ai_1`（完成 1 次 AI 任务，50 灵石）、`daily_ai_5`（完成 5 次，150 灵石）。**trustoken 的「AI 任务」= AiPy Pro 的一个任务（会话）**：实测在 AiPy 里新建并执行一个任务，`daily_ai_5` 的 progress +1（3 → 4 → 5）。
- **插件怎么补任务**：`auth.checkin` 通过 **AiPy 本机 API** `POST /api/aipy/createTask`（body 必须带 `force:true`，否则会复用最近那个空任务）自动创建缺口数量的任务，模型固定用最低价 `qwen3.8-flash`；创建后等 trustoken 结算进度，再把 50 / 150 灵石领掉。
- **前提**：AiPy Pro 正在运行（Windows）。没运行时会降级为纯 API 补发（实测不推进进度），消息里会如实写。
- **独立脚本**：`node scripts/aipy-daily.mjs`（加 `--dry-run` 只看进度）。适合 Windows 任务计划每天 08:05 跑一次。

---

## 邀请码

- **自动带码**：注册新号时用 `inviteToUse()`（默认作者码 `Chdr`）作为 `aff_code`。
- **滚动**：每次登录成功、每天签到时，把当前账号自己的 `aff_code` 写进 `~/.cache/magpie/trustoken-invite.json`，下一次注册自动用它。
- **奖励口径**：活动页原文——邀请人 **1,000 灵石**，被邀请人 **2,500 灵石**（对应 `/api/status` 的 `quota_for_inviter=5,000,000` / `quota_for_invitee=2,500,000`）。

> 当前版本没有「邀请上级」UI（之前照抄超级麦吉的入口位置不对，已移除）；码的滚动仍然生效。

---

## 安装

在 magpie 的 **插件 → 发现** 搜 `magpie-trustoken-auth`，点安装。

### 命令行

```bash
# 从仓库源码（当前推荐，npm 尚未发布）
magpie plugin add github:MYCF711/magpie-trustoken-auth

# 本地目录（自己改了代码）
magpie plugin add D:\主工作区\projects\magpie-trustoken-auth
```

装完在 magpie 里：

1. 供应商列表会多一行 **Trustoken（AiPy）**；
2. 点登录 → 选 **手机号注册 / 登录（短信验证码）**，填手机号；
3. 登录后模型目录、灵石余额、签到按钮都会出现。

---

## 常见问题

- **点登录没反应？** 插件直接调官方短信接口发码，不开浏览器；收不到短信就看 magpie 里返回的报错（风控 / 号码格式 / 频率限制）。
- **新号能注册吗？** 能。服务端 `enabled_phone_register=true`，注册端点直接调是通的；网页上不让注册只是网页 UI 的 `WebRegisterEnabled=false`。详见 [docs/internals.md](./docs/internals.md) 十三。
- **有账号还让我下载客户端？** 不会。本机已有 Trustoken 账号时，登录入口只留「本机登录（读取 AiPy 会话）」一个，点一下就把 AiPy Pro 客户端里已登录的号导入。
- **签到一直失败？** 看北京时间是不是在 08:00–22:00 之外。窗口外插件返回失败，magpie 当天会重试。
- **每日任务进度不动？** 先确认 AiPy Pro 正在运行。trustoken 只认 AiPy Pro 客户端创建的任务（会话）；插件通过 `POST /api/aipy/createTask` 自动建。AiPy 没运行时会降级为纯 API 补发，那种请求实测不推进进度。
- **图片发不出去？** 插件把图片能力写死在 `qwen3.8-flash` / `kimi/kimi-k3`；用其他模型发图会被拒绝，这是故意的 —— trustoken 对不支持的模型会静默换模型，比报错更难查。

---

## 参考源

| 来源 | 用在哪 |
|---|---|
| [magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold) | 插件骨架、九项钩子、`src/quota.mjs` / `src/chat.mjs` / `src/store.mjs`、check 与语义测试 |
| [magpie-magicrew-auth](https://github.com/MYCF711/magpie-magicrew-auth) | `index.mjs` 只装配 + hooks 拆分结构、独立浏览器/CDP 登录骨架（本仓库 0.3.6 起手机号登录改走官方接口，已不再带这套骨架）、`completeSignIn` 的返回形状 |
| trustoken.cn 网页前端（`/assets/main-*.js`） | 签到 / 每日任务 / 令牌 / 登录端点与字段 |
| Trustoken 活动中心与 `/api/status` | 灵石换算（500,000 quota = 1 元；100 灵石 = 1 元） |

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)

---

## 许可

MIT
