## 0.3.19 — 2026-10-31

- **依赖键必须是「无空格」的名字**：0.3.18 用纯 npm 名（`magpie-trustoken-auth`）虽然能让 update 跑通，但卡片标题又变回 npm 名。实测 bun 能解析**中文但无空格**的依赖名（`爱派AiPy`），**空格才是致命字符**（`unrecognised dependency format`）。
  - `package.json.name` / `magpie.name` → **`爱派AiPy`**（无空格，卡片标题）
  - `PROVIDER_NAME` 保留 **`爱派 AiPy`**（provider 名不是依赖键，允许空格）
  - npm 包名仍用 `magpie-trustoken-auth` 发布？—— 不：0.3.18 起已去掉换名脚本，`name` 即发布名；**npm 不能发中文名**，所以 0.3.19 需要 `publish-npm.mjs` 在发布时换回 `magpie-trustoken-auth`（恢复 0.3.16 的做法，但显示名改为无空格 `爱派AiPy`）。

## 0.3.18 — 2026-10-31

- **修复：带空格的显示名把 bun 依赖键弄坏，`magpie plugin update` 直接报 `unrecognised dependency format: 爱派AiPy Trustoken`**。
  根因：git 源安装时 bun 用 `package.json.name` 当依赖键（`~/.config/magpie/plugins/package.json` + `bun.lock`），而 0.3.16/0.3.17 把 `name` 改成了带空格的显示名。
  修复：**`package.json.name` 回到 npm 合法名 `magpie-trustoken-auth`（无空格）**，显示名只由 `magpie.name` 提供（magpie 的插件行读它，#3608）；`PROVIDER_NAME` 仍是 `爱派 AiPy`。删掉 0.3.16 引入的 `publish-npm.mjs`（不再需要换名发布）。
- 本机数据修复：`~/.config/magpie/plugins/package.json` 与 `bun.lock` 的依赖键改回 `magpie-trustoken-auth`，`node_modules/爱派AiPy Trustoken` 目录改名，`bun install --offline` 校验通过。

## 0.3.17 — 2026-10-31

- **显示名更正为 `爱派 AiPy`**（主人 2026-10-31 定稿：中文「爱派」与英文「AiPy」之间要有空格）。0.3.16 的 `爱派AiPy Trustoken` 作废。
  - `package.json.name` / `magpie.name` / `src/context.mjs PROVIDER_NAME` / `registry-entry.json` / README / MAINTENANCE / project.json 同步。
  - npm 包名仍是 `magpie-trustoken-auth`（`publish-npm.mjs` 不变）。

## 0.3.16 — 2026-10-31

- **显示名改成「中文 + 官方英文」**：`package.json.name` 与 `magpie.name`、provider `name` 统一为 **`爱派AiPy Trustoken`**。
  - 官方依据：AiPy 官网 `https://www.aipyaipy.com/` 的 `<title>爱派AiPy - 超级AI办工智能体工厂，AiPy Pro智能桌面助手` → 中文名「爱派AiPy」、英文照抄 `AiPy`；Trustoken 官网 `https://www.trustoken.cn/` 只有 `Trustoken CN` 与「Trustoken - AI大模型Token管理和分发平台」，**没有官方中文名**，英文照抄 `Trustoken`。
  - 不再直接显示 npm 包名（之前卡片标题是 `magpie-token-auth` 那种）。
- npm 包名保持不变（`magpie-trustoken-auth`，已装用户照旧收更新）：新增根目录 `publish-npm.mjs`（`PUBLISH_AS = "magpie-trustoken-auth"`）与 `npm run publish:npm`，发布时临时换名、发布后还原；`scripts/publish-npm.mjs` 是给 `release.yml` 的入口。
- 改了 `src/context.mjs` 的 `PROVIDER_NAME`、`registry-entry.json` 的 `name`、`README` / `MAINTENANCE` / `project.json` 的显示名。

## 0.3.15 — 2026-10-31

- chore(release): 0.3.14 卡在 npm staged 状态（`npm publish` 报 `Cannot publish over previously staged version "0.3.14"`，`npm stage list` 查不到可批准条目），**同代码重发 0.3.15** —— 与 0.3.3 → 0.3.4 的处理方式一致。功能内容与 0.3.14 相同（`locked` 纳入每日任务 gaps）。

## 0.3.14 — 2026-10-31

- **修复：每日任务补任务逻辑从不触发——`locked` 状态被漏掉**。`src/hooks/checkin.mjs` 的 `gaps` 过滤只认 `in_progress`，但服务端把「未开始」的每日任务标成 `locked`（本机 5 个号实测全是 `daily_ai_1: 0/1 locked`、`daily_ai_5: 0/5 locked`）→ `gaps` 永远为空 → `ensureAipyTasks` 一次都不调用。修复：`taskGaps()` 同时认 `in_progress` 和 `locked`，等待循环同步改。
- 实测（2026-10-31 02:47，AiPy Pro 2.1.1，端口 41970）：手动 `ensureAipyTasks({n:1})` 建 1 个任务，10 秒内 `daily_ai_1` 0/1 locked → **claimable 1/1**、`daily_ai_5` 0/5 locked → **in_progress 1/5**。⇒ `locked` = 未开始，不是锁死；建任务确实推进 progress。
- test: 新增 `tests/checkin-tasks.test.mjs` 5 条（locked 算 gap / in_progress 算 gap / claimable·claimed·已达标不算 / 空输入 / 源码锁两处都走 taskGaps）。

## 0.3.13 — 2026-10-31

- fix(test/CI): `tests/compliance.test.mjs` 的 `withHome` 补设 `HOME` —— ubuntu CI 上 `os.homedir()` 读的是 `HOME` 而不是 `USERPROFILE`，导致测试②把「旧版本写死身份」的文件写进临时目录、`defaultGroup()` 却去读真实的 `/home/runner/.cache/magpie`，断言 `expected '' actual '182238'`。这是 0.3.10 起 main 的 `rules` 一直红的原因（本机 Windows 不受影响，所以一直没发现）。
- 说明：0.3.12 的 npm 包与 tag 已发布，但 GitHub Release 因上述 CI 失败没有生成；0.3.13 是修好发布门禁后的正式版本，内容与 0.3.12 相同（仅测试修复）。

## 0.3.12 — 2026-10-31

- **修复：第一个号之后再也加不上号（点弹窗却报「本机 AiPy 当前登录的是…已经在 magpie 里了」，浏览器不弹）** —— 根因是**入口集合收缩导致 magpie 位置索引漂移**：旧口径（坑 28）「有账号 → 只留本机登录 1 条」，而 magpie 的登录页按 methods 的**位置**调插件（页面渲染时的 index）、插件每次 providers RPC 现算列表。第一个号加上后列表收缩成 1 条，用户点「弹窗」按钮（旧 index）就错配到现算列表的另一条——实测执行了本机登录的查重、读到 AiPy 客户端还登录着的第一个号、报「这个号已经在 magpie 里了」，浏览器根本不弹。**修订口径：入口集合恒定两条（本机登录 + 弹窗注册），与账号状态无关** —— 形状恒定 = 任何 index 永不漂移；这也是下载入口删除后坑 28 口径的必然结果（它防的「下载挡人」前提已不存在）。查重仍在本机登录 authorize() 里做，行为不变。
- test: `tests/login-methods.test.mjs` 测试 1 改为锁「0 账号和有账号输出完全一致（形状恒定）」；其余 3 条不动（本机登录 index 0 未变）。

## 0.3.11 — 2026-10-31

- **修复：弹窗注册报「没找到 Chromium 内核浏览器」，但机器上明明装了浏览器** —— 旧的 `browserCandidates()` 在 Windows 只查 5 条写死路径（Program Files / LOCALAPPDATA 下的 Chrome、Edge 的 `msedge.exe`），三处盲区全踩：① scoop 安装的 Chromium（`%USERPROFILE%\scoop\shims\chromium.exe`，且 scoop 会把 shims 加进 PATH，Windows 分支却完全不扫 PATH —— linux 分支用 `command -v` 扫了，Windows 漏了）；② 本机 Edge 主程序叫 `Microsoft Edge.exe` 而不是 `msedge.exe`（注册表 `App Paths\msedge.exe` 证实）；③ 用户照 magpie 生态文案设的 `MAGPIE_LINGXI_BROWSER` 环境变量插件根本不认。现在按优先级：**env 覆盖（`MAGPIE_LINGXI_BROWSER` / `MAGPIE_TRUSTOKEN_BROWSER`，分号分隔、不过滤存在性）→ 固定路径（Edge 双文件名 + scoop shim + Chromium 每用户 + Brave/360极速）→ Windows PATH 扫描 → 注册表 App Paths 兜底**。本机实测命中 Edge（改名）与 scoop Chromium 两个候选。
- test: 新增 `tests/browser-candidates.test.mjs` 10 条（env 覆盖三态、Edge 双名、PATH 扫描含引号/相对路径丢弃、App Paths 兜底触发与跳过、去重、本机 scoop 回归锁）。
- 报错文案与生态统一：找不到浏览器时教用户设 `MAGPIE_LINGXI_BROWSER`（原「本机没找到 Chrome / Edge」对用户没有出路）。
- **fix（回退）：打不开受控浏览器时给用户一条自己走的路**（主人 2026-10-31 要求）：`launchLoginWindow()` 失败（含一个浏览器都没找到）时，`authorize()` 返回 `{ url: <登录网址>, opened: false, method: "code" }` —— magpie 会按 `plugins.go:788` 用系统浏览器打开；同时把网址**复制到剪贴板**，instructions 里写明「网址已复制」。回退**不是默认路径**：能起窗口时仍走弹窗注册（那样才拿得到 session cookie）。
  登录态回收：系统浏览器拿不到 cookie，**通常不会自动导入** —— instructions 如实写明；若浏览器最终跳到 `aipy-pro://oauth?code=...`，用户可把整段粘回来，插件用这次的 verifier 换 token；否则请改用「本机登录（读取 AiPy 会话）」。
- fix(test/CI)：Windows 路径改用 `win32.join`（CI 跑在 ubuntu 上，`path.join` 会拼成正斜杠导致 10 条浏览器探测测试全红）；env 覆盖的路径允许带包裹引号。

## 0.3.10 — 2026-10-30

- **邀请码改成插件选项开关**（学 magicrew 的 `auth.options` 形式）：`auth.options: [{ key: "invite-first", label: "邀请码固定不滚动", description: "...", default: false }]`。开 = 新号注册固定用当前码（有 fixed/custom 记录就用它，否则作者码 `Chdr`）；关（默认）= 跟随最后一个登录 / 签到的账号的滚动码。magpie 的 `PluginOptions` 是 `map[string]map[string]bool`，只支持布尔，所以做不了「下拉选账号」。
- **删掉登录页的邀请码输入框**：`手机号注册 / 登录（弹窗）` 现在只问手机号；`saveInviteChoice()` / `modeHint()` 不再被调用。工厂改成 `async (input) => {...}`，`setInviteOptionReader(c.PROVIDER, key => input?.magpie?.option?.(c.PROVIDER, key) === true)` —— 传的是读取函数，拨一下立刻生效，不缓存布尔值。
- **下载入口确认删除**：0 账号时只剩「本机登录」+「手机号注册 / 登录（弹窗）」两条；`firstLoginMethod` 定义保留但不挂载（万一弹窗被上游封了可一行恢复）。
- test: 新增 `tests/invite-option.test.mjs` 5 条（默认滚动 / 开关开固定 / 读抛错当关 / index 的 `auth.options` 与 `input.magpie.option` 接线 / 登录页只剩 phone 一个 prompt）。

## 0.3.9 — 2026-10-30

- **手机号注册入口补上邀请码选择** —— 之前只有「首次使用：下载客户端注册」那条会问邀请码；手机号注册入口直接 `inviteToUse()`，用户无法在注册时临时指定码。现在手机号入口也带一个可选输入框：留空 = 自动（跟随最近登录/签到的号，否则用作者码 `Chdr`），填了 = 指定这个码。与 `saveInviteChoice()` 同一套策略，自动与指定两种模式都可用。

## 0.3.8 — 2026-10-30

- **修复：新号注册的邀请码丢了** —— `authorizeUrlFor()` 拼 OAuth 授权 URL 时没有 `aff` 参数，用户在注册窗口里注册的新号不会被记到邀请人名下。旧的 `beginOAuth` 一直带这个参数，注册流程漏了。现在 `authorizeUrlFor(challenge, redirectUri, aff)` 显式接收并在有值时拼 `aff=<邀请码>`，调用点传 `inviteToUse()`（`AUTHOR_INVITE="Chdr"` 或用户自填码）。新增测试 ⑧ 锁住。

## 0.3.7

- feat: **手机号入口改成弹窗注册链路，新号可以在插件里注册了**（推翻 0.3.6 的「只能客户端注册」结论）。三道门：① 窗口 UA 必须带 `aipy-pro/*`（服务端靠它认客户端，否则新号被拒）；② 必须从 `/api/oauth/authorize` 307 到 `/oauth/login` 的**同一个标签页**（该页把 `sessionStorage.layout` 置 `false`，前端才走 `/api/user/register/mobile`）；③ 登录后走 OAuth PKCE 换 `access_token`。
- feat: 重建 `src/browser-login.mjs`（受控 Chromium + CDP）：`--remote-debugging-port` + 一次性 `--user-data-dir` + `--user-agent=<AiPy UA>`；轮询 `localStorage.user` 判登录完成；`Storage.getCookies` 拷 trustoken 的 `session`；关窗删 profile。
- feat: `src/oauth.mjs` 新增纯函数 `makePkce` / `authorizeUrlFor` / `codeFromLocation` / `fetchOAuthCode`（node 里 `redirect:"manual"` 读 302，因为 `aipy-pro://` 导航 CDP 拦不到）/ `readJsonBody`（body 只读一次）/ `tokenExpiry`。
- fix: **verifier 落盘**（文档坑 5.2）：`src/store.mjs` 的 `fileOf("oauth-pkce", {siteId:"trustoken", account})`，同一手机号 10 分钟内复用同一对 PKCE；成功后才删。
- fix: **UA 覆盖升级到请求层**（Jet 2026-10-30 提示）：启动参数 `--user-agent` 只覆盖导航请求，页面里的 XHR/fetch 可能仍带浏览器 UA。现在每个 page target 都挂 `openUaGuard`：`Network.setUserAgentOverride` + `Emulation.setUserAgentOverride` + `Fetch.enable`/`Fetch.continueRequest` 逐请求重写 `User-Agent`；`waitForLogin` 断言 `navigator.userAgent` 含 `aipy-pro/`，覆盖失败当场报错。实机烟测：`intercepted=17`（Fetch 确实在拦）。
- test: 新增 `tests/register-flow.test.mjs` 7 条（PKCE 长度与 SHA256、AiPy UA、session cookie、302 Location 前缀、`expires_in ≈ 2592000`、body 只读一次、UA 请求层覆盖与头重写）。
- docs: `docs/internals.md` 新增第十四节（三道门 / 实现 / 七个坑 / 判据 / 未验证），第十三节标注「已被推翻，保留作历史」。

## 0.3.6

- feat: **手机号入口改成官方注册接口（当前不可用，保留待研究）**：`sendSmsCode` → `loginMobile` / `registerMobile`。实测结论：网页点「获取验证码」先弹滑块（`/api/captcha` → `/api/captcha/check`），过完仍提示要 AiPy 客户端；直接 POST `/api/sms/code` 缺滑块 token 恒 400 `{"success":false}`（请求头 / UA / TLS 伪装均无效，不是头的问题）。注册端点 `/api/user/register/mobile` 本身通（假验证码返回「验证码错误或已过期」），但拿不到真验证码。**新号请用 AiPy Pro 客户端注册后走「本机登录」。**
- refactor: 删除 `src/browser-login.mjs`（951 行，自建 Chromium profile + CDP + 自动解滑块）—— 那条路只能登录已注册的号，正是主人说的「没意义」；`methods.mjs` 里对应的 PKCE / 表单注入 / OAuth 回调辅助函数一并删除。
- feat: **恢复造任务 + filler**（主人 2026-10-30 明确「造任务和 filler 请求我要」）：`src/aipy-local.mjs` 恢复 `readAipyApiKey` / `findAipyPort` / `createAipyTask` / `ensureAipyTasks`（与 0.3.4 逐字一致），`src/hooks/checkin.mjs` 恢复补任务块与带 `Aipy-Task-ID` 的 filler 循环，`scripts/aipy-daily.mjs` 恢复刷任务器形态。
- test: `tests/compliance.test.mjs` 更新口径 —— 取消对 `createTask` / `Aipy-Task-ID` / `ensureAipyTasks` / `solveSlider` 等的禁止，改成**正向锁**（造任务 + filler 必须在）；保留「账号身份 / magpie 私有文件 / 写死安装包直链」的禁止；新增「手机号入口走官方注册接口、浏览器登录链已删除」的断言。
- docs: `docs/internals.md` 第十三节改为**如实记录「当前不可用」**：现状（服务端要求滑块 + 客户端身份）、已知尝试（直调注册端点 / `POST /api/sms/code` 恒 400 / 请求头伪装无效）、未验证（后台操控 AiPy 壳，没做、不要再做）、造任务恢复的决策记录。

## 0.3.5

合规整改 —— `magpie-community/plugins` 收录 PR #527 的 review。收录被拒可以接受（Trustoken 是中转站），但 review 指出的插件自身问题必须修。主人的口径：**推荐码可以带，账号身份不能带。**

- fix: `src/header-groups.mjs` 的 `defaultGroup()` 不再在「本地没有账号信息」时写死 `uid: "182238" / accountId: "189****8051"`（维护者自己的账号身份），改成**空身份**的客户端组；旧版本落盘过的那份带身份的默认组会被丢掉重建（已有安装自愈）。同时删掉 `read189Auth()`（按手机号前缀从 magpie 账号表挑账号借身份）。
- fix: 删掉 `src/invite.mjs` 的 `preferredInvite()` —— 它直接解析 magpie 的 `logins.json` + `plugin-auth.json` 去认「magpie 首选账号」。**这个功能保不住**：magpie 的钩子（`getAuth()`）只给当前账号，拿不到「哪个账号是首选」。邀请码只剩两种来源：用户显式填的码、滚动码（最近登录 / 签到的账号自己的码，由 `rollInvite()` 用该账号 token 在钩子里记下）。登录弹窗提示同步改为「留空 = 自动；也可直接填一个邀请码」。`AUTHOR_INVITE`（维护者自己的推荐码）按新口径保留，仍可用 `TRUSTOKEN_INVITE` 覆盖。
- fix: `auth.checkin` 不再刷厂商推广 —— 删掉「用最低价模型补每日任务」的全部逻辑（读本机 AiPy key / 端口 → `POST /api/aipy/createTask` 批量建任务；再发一批带假任务头的 filler 请求）。现在只做：签到 + 领服务端**已经标成 `claimable`** 的奖励。`src/aipy-local.mjs` 只留只读的 `readTrustokenToken()`，建任务那半整段删除；`scripts/aipy-daily.mjs` 改成「看进度 + 领已到手的奖励」。
- fix: 下载入口不再写死 `aipy-pro-2.1.1-x64.exe`，改跳官方下载页 `https://www.aipyaipy.com/`。
- fix: **删除自动解滑块**（`SOLVE_SLIDER` / `cdpInput` / `solveSlider` / `dragSlider`，以及 `waitForLogin()` 里的自动拖拽分支）—— 代替用户完成风控验证属于绕过风控。手机号登录改为打开**可见**窗口：出现滑块时提示用户本人拖动，短信发出后再填验证码。
- test: 新增 `tests/compliance.test.mjs` 5 条（源码锁 + 行为测）覆盖上述五条：推荐码可带 / 账号身份不可带、不读 magpie 私有账号文件、不刷推广任务、下载跳官方页、不代解验证码。

## 0.3.4 — 2026-10-30

- **重新发布**：0.3.3 在 npm 侧卡在一个 staged 状态（registry 查 404，但 publish 报 409 "Cannot publish over previously staged version"），代码相同，改以 0.3.4 发布。功能与 0.3.3 完全一致：登录入口按「本机是否已有账号」自动分流

## 0.3.3

- feat: 添加账号按「本机有没有 Trustoken 账号」自动分流（读 `~/.config/magpie/plugin-auth.json` 的 `trustoken` / `trustoken#…`，只读）：**有账号 → 只留「本机登录（读取 AiPy 会话）」一个入口**，点一下就把 AiPy Pro 客户端里登录的号导入 magpie，无输入、无选择页；**0 账号 → 才出现**「首次使用：下载 AiPy Pro 客户端注册」（邀请码模式 → 下载链接 → 自动等登录态）+「本机登录」+「手机号登录」。有账号时不再弹下载安装包连接。
- fix: 删掉重复的「邀请码」入口（原来和下载入口 100% 同一实现）；删掉下载流程里手填「安装包下载链接」的输入框（用户不需要填 URL，链接直接放进 instructions）。
- fix: `methods[].label` 全部改成稳定文案 —— 原先 label 里拼了 `inviteToUse()` 的动态邀请码，会被 magpie 在插件加载时缓存住、永远显示旧码（magicrew AGENTS 坑 31 同族）；动态邀请码改到 `authorize()` 的 `instructions` 现算。
- fix: 「本机登录」查重：当前客户端登录的号已经在 magpie 里时明确报错并要求先在客户端切换，不再静默替换旧账号。
- test: 新增 `tests/login-methods.test.mjs` 5 条 —— 入口集合（0 账号 3 个 / 有账号 1 个）、`hasAccounts` 文件口径（含坏 JSON 保守按有账号）、**旧缓存下下载入口的行为层兜底（绝不返回下载链接）**、本机登录的两种明确报错、label 去动态化。

## 0.3.2

- fix: 上游用 400 报「渠道自己坏了」（`bad response status code 400`）时，magpie 的 `retryable()` 不认这句话 ⇒ 不换号、400 直接摔给客户端，整个会话被它打断。`auth.loader` 现在带一个 `fetch`，按语义把 400/422 翻译成 magpie 认得的状态码：钱（灵石/积分/点数/余额/额度/欠费/充值/insufficient balance…）→ **402**；渠道坏了（`bad response status code` / `bad_response_status_code` / 无可用渠道）→ **502**；模型不存在/未开通/无权 → **404**；400 里明说「每分钟/每秒」的限流 → **429**。上下文过长与请求格式错误（`invalid_text_request`）**原样放行** —— 换号一样失败，还会把「该压缩上下文」的信号弄丢。
- fix: 只读 400/422 的响应体（且是 `clone()` 出来读的），其余状态码连 `clone()` 都不做、`Response` 原对象交回 —— 200 是 SSE 干流，读一下就废。不改请求体、不改 Authorization、不加头。
- test: 新增 `tests/error-classify.mjs`（25 条，报文取 2026-10-30 对 `api.trustoken.cn` 的实测原文），锁死四档翻译 + 「非 400/422 的响应体一个字都不读」+ 「判类读过 clone 之后原 Response 仍完整」；`npm test` 现在把它一起跑。`tests/semantics.test.mjs` 另加 5 条（4 条翻译 + 1 条「装配出来的 loader 必须带 fetch」）。

## 0.3.1

- feat: 首次登录下载按钮接入邀请码两种模式：先问 0/自动、1/首选，再给下载链接；选中的码复制到剪贴板。
- feat: 原「邀请码」按钮改为复用同一套下载+导入流程，不再走网页手机号注册。

## 0.3.0

- feat: 新增「复制邀请码（Chdr）并下载客户端登录」：弹出安装包下载链接输入框（默认 `https://promo.aipyaipy.com/downloads/aipy-pro-2.1.1-x64.exe`），自动复制邀请码；下载安装后在 AiPy Pro 客户端注册，插件轮询本机 `trustoken-token` 自动导入登录态（10 分钟超时）。

## 0.2.5

- fix: 默认先走 `/api/user/login/mobile`（已注册号可直接登录）；页面提示“新增账号需下载客户端”时才切 `layout=false` 走 `/api/user/register/mobile` 重试。避免已注册号被强制走注册端点误报。

## 0.2.4

- fix: header 注入脚本里 `/\/api\/user\//` 正则被模板字符串吃掉转义，页面抛 `SyntaxError: Unexpected token 'for'`，导致每轮填充都失败、最终误报“没找到手机号输入框”。
- test: 本地实际跑通 authorize，返回“验证码已发送到 199****0000”。

## 0.2.3

- fix: 不再打开 `/api/oauth/authorize`（它会 302 到 `/login`，headless 下输入框时有时无）；直接打开带 OAuth 参数的 `/login`，保留 PKCE/redirect_uri，登录后由 `window.aipy` 接管跳转。

## 0.2.2

- fix: OAuth 登录页 302/刷新时手机号输入框会短暂出现又消失；填充改为「填完再确认」，页面换了就重新找，不再一次失败就报“登录页没找到手机号输入框”。

## 0.2.1

- behavior: 自动档改为「最后一次新注册」，不是最后登录/签到。已有账号登录、每日签到都不再改写 `trustoken-invite.json`。

## 0.2.0

- feat: 账号 header 组落盘修正——登录成功后保存**新号自己的 aff_code**（不是注册时用的上级码）。
- feat: 自动模式按滚动码反查所属账号，切到该账号的 header 组；首选模式按 magpie 首选账号组。
- feat: 默认组 = 189 账号（referral + 自己的邀请码）；邀请码按钮 0=自动 / 1=首选，与超级麦吉最新版一致。

## 0.1.9

- feat: 每个账号一组请求头源（referral/版本/平台/aff_code），默认 189 账号那组；登录新号成功后按 uid 落盘。
- feat: 新增「邀请码」登录按钮：0/留空=自动（作者码/滚动码），1=当前首选账号。

## 0.1.8

- feat: 注册/登录请求注入 AiPy 客户端同款 `X-AIPY-*` 请求头；`X-AIPY-REFERRAL-CODE` 读取 `%APPDATA%/aipy-pro/referral`（本机为 `BJ5OOSP-7xpn8zonzw`）。

## 0.1.7

- feat: 增加「本机登录（读取 AiPy 会话）」，在 AiPy Pro 客户端登录任意手机号后，插件可直接读 token 添加到 magpie。

## 0.1.6

- fix: 显式设置 `sessionStorage.layout="false"`，确保 OAuth 登录页走 `/api/user/register/mobile`，不被 `/api/user/login/mobile` 的“新号需下载客户端”策略拦截。

## 0.1.5

- fix: OAuth 授权页 302 到 /login 有渲染延迟，改为轮询等待手机号输入框（最多 15 秒），不再固定 800ms 后报「没找到手机号输入框」。

## 0.1.4

- fix: OAuth 登录点击后处理「登录或者注册需要同意《用户协议》和《隐私协议》」二次确认；
  实测同意后走 `/api/user/register/mobile`，不再被“新增账号需下载 AiPy Pro 客户端”拦截。

## 0.1.3

- feat: 改用 AiPy 客户端同款 OAuth 授权页（`client_id=aipy-pro` + `redirect_uri=aipy-pro://oauth` + PKCE）；
  登录页注入 `window.aipy`，登录成功后捕获 `aipy-pro://oauth?code=...` 并换 token。

## 0.1.2

- fix: 回调检测「新增账号需下载 AiPy Pro 客户端」等业务错误，立即返回原因，不再转圈 180 秒。

## 0.1.1

- fix: 无头登录返回 `opened: true`，避免 magpie 再开系统默认浏览器（用户看到网页登录页）。

# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。

## 0.1.0 — 2026-10-29

**Trustoken（AiPy）接入 magpie —— 登录、模型、额度、签到、每日任务一次到位**

- **登录**：无头 Chromium 内置登录——自动填手机号、勾协议、填邀请码、获取验证码、解滑块；用户在 magpie 里填短信验证码后自动提交并捕获登录响应。滑块用边缘梯度互相关，连续 10 次实测一次通过 10/10。
- **模型目录**：登录后按账号实时拉 `GET /v1/models`；未登录用 13 个静态模型兜底。图片输入按 trustoken 自己的声明写死（只有 `qwen3.8-flash` / `kimi/kimi-k3` 标了 image）。
- **额度**：`GET /api/user/self` → 灵石余额（quota / 5000），卡片以钱包型窗口展示。
- **签到**：`POST /api/user/checkin`，北京时间 08:00–22:00 窗口；窗口外返回 `failed` 让 magpie 当天重试。
- **每日任务**：`GET /api/user/daily_tasks/status` → 自动领取 `claimable` 的奖励（`POST /api/user/daily_tasks/claim`）。
- **任务 = 会话**：实测 trustoken 的「AI 任务」= AiPy Pro 的一个任务（会话）。插件通过 AiPy 本机 API `POST /api/aipy/createTask`（`force: true`）自动创建缺口任务，模型用最低价 `qwen3.8-flash`；实测 progress 3 → 4 → 5，并成功领取 150 灵石。独立脚本 `scripts/aipy-daily.mjs`。
- **邀请码（学超级麦吉 0.3.32）**：注册新号自动带 `aff_code`；默认作者码 `Chdr`；「邀请上级」支持自动 / 固定 / 自定义三种策略；每次登录与每日签到自动滚动当前账号自己的码。缓存文件 `~/.cache/magpie/trustoken-invite*.json`。
- **最低消费模型**：`src/rates.mjs` 是 2026-10-29 的实测倍率表；`qwen3.8-flash` 最低（输入 0.7471 / 输出 2.2538 quota/token），插件用它补每日任务。
- **模型错误**：模型级错误统一翻译成 404，不误伤整个账号。
