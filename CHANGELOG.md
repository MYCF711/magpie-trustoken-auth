# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。

## 0.1.0 — 2026-10-29

**Trustoken（AiPy）接入 magpie —— 登录、模型、额度、签到、每日任务一次到位**

- **登录**：参考超级麦吉的 `browser-login.mjs`，拉起独立 Chromium 窗口打开 Trustoken 官方登录页（手机号滑块+短信 / 微信 / 密码），在页面里捕获登录响应后自动完成。
- **模型目录**：登录后按账号实时拉 `GET /v1/models`；未登录用 13 个静态模型兜底。图片输入按 trustoken 自己的声明写死（只有 `qwen3.8-flash` / `kimi/kimi-k3` 标了 image）。
- **额度**：`GET /api/user/self` → 灵石余额（quota / 5000），卡片以钱包型窗口展示。
- **签到**：`POST /api/user/checkin`，北京时间 08:00–22:00 窗口；窗口外返回 `failed` 让 magpie 当天重试。
- **每日任务**：`GET /api/user/daily_tasks/status` → 自动领取 `claimable` 的奖励（`POST /api/user/daily_tasks/claim`）。
- **任务 = 会话**：实测 trustoken 的「AI 任务」= AiPy Pro 的一个任务（会话）。插件通过 AiPy 本机 API `POST /api/aipy/createTask`（`force: true`）自动创建缺口任务，模型用最低价 `qwen3.8-flash`；实测 progress 3 → 4 → 5，并成功领取 150 灵石。独立脚本 `scripts/aipy-daily.mjs`。
- **邀请码（学超级麦吉 0.3.32）**：注册新号自动带 `aff_code`；默认作者码 `Chdr`；「邀请上级」支持自动 / 固定 / 自定义三种策略；每次登录与每日签到自动滚动当前账号自己的码。缓存文件 `~/.cache/magpie/trustoken-invite*.json`。
- **最低消费模型**：`src/rates.mjs` 是 2026-10-29 的实测倍率表；`qwen3.8-flash` 最低（输入 0.7471 / 输出 2.2538 quota/token），插件用它补每日任务。
- **模型错误**：模型级错误统一翻译成 404，不误伤整个账号。
