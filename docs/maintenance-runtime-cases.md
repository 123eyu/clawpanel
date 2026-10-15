# 每日维护：真实运行时 E2E 验收

## 先列失败场景，再实现脚本

此清单在编写脚本前建立。下表是失败判据，不是通过记录；实际执行状态以每次新建目录中的 `report.json` 为准。历史产物不作为本次通过证据。

| 场景 | 失败判据 / 应有行为 |
| --- | --- |
| HOME 隔离失败 | 子进程 `os.homedir()`、USERPROFILE、APPDATA、XDG、OPENCLAW_CONFIG_DIR、HERMES_HOME 不在本次目录内，立即失败，不启动安装 |
| 真实配置泄漏 | 不继承模型凭据、Cookie、SSH、npm 用户配置、代理或 Git 凭据；只使用新生成的本地测试值 |
| 安装失败 / 依赖缺失 | API 报错、超时、入口缺失或安装退出码非零，标 failed/missing 并退出非零；后续未执行项不得 passed |
| 版本不一致 | API 返回版本与仓库推荐常量、实际执行文件 `--version` 不一致，失败，不以“目录存在”代替核验 |
| Provider 未调用 | 必须收到实际引擎发往回环模拟 Provider 的正确模型与本次唯一提示词，且引擎回复包含本次回执；单纯配置回读不算聊天通过 |
| 消息截断 / 错误结束 | 两段流式正文、终止事件和完整内容均须核对；HTTP 200 但响应携带错误仍失败 |
| 停止失败 | 仅停止本次受管 PID/容器，核对实际 PID 退出和端口关闭；仍存活或清理未完成均使整体失败 |
| 端口冲突 | 随机申请回环端口；启动前再次检查；冲突即失败，绝不终止占用者 |
| 未执行 / 部分执行 | 所有必需阶段初始 missing，只有实际断言成功才 passed；总体初始 failed，全部必需阶段通过才 passed |
| Hermes 安装隔离不确定 | 官方安装阶段可能安装系统工具时，fail-closed，留下缺失的容器安装验收，不运行宿主安装器 |
| Docker 不可用 | 外层发行 Dockerfile smoke 与内层聊天验收分离；内层没有 Docker socket 是正常隔离条件，不用旧镜像或 handshake-only 冒充聊天通过 |
| 容器安装门禁（新增驱动前登记） | parent 必须同时看到可信环境变量 `MAINTENANCE_ISOLATED_RUNTIME=1`、Linux、`/.dockerenv`、非 root；并核对 NoNewPrivs/CapEff。仅设变量或 Issue 声称在容器中均不开放安装 |
| Hermes 容器契约失败（新增驱动前登记） | 精确版本/commit/hash、Profile、模型、Gateway 健康、run 终态和回复、Provider 回执、实际 PID 退出逐项断言；任何一项缺失均非零，未实测不等于通过 |
| OpenClaw 内层直装（新增驱动前登记） | 仅在上述隔离容器中，以独立 npm-prefix 精确装候选版本，生产 HTTP 写配置、真实 Gateway/聊天/历史/Provider/PID 均须验收；不要求 Docker socket，不用外层镜像 smoke 替代 |
| 首轮托管验收入口（本轮新增前登记） | main 的维护代码推送须执行三平台控制器回归；手工 runtime_selftest 应独立运行 Hermes/OpenClaw 基线容器验收，不依赖 AI Key/候选，缺少入口或任一真实阶段缺失均不作为可发 tag 证据 |
| Windows bind mount 的 Git 所有权（实测红灯后登记） | NTFS 挂载可能显示为 root；读取已校验 candidate 的 revision 时仅向本次 git 命令指定精确 safe.directory，不写全局信任、不使用通配符、不跳过 SHA 记录 |
| CI 凭据隔离（收紧前登记，用户已确认） | 测试/构建 job 须显式只读且 checkout 不持久化凭据；仅独立 publish-release 可写内容，防止仓库默认 write 权限进入候选安装/测试进程 |
| uv 安装隔离覆盖上游受管路径（实测红灯后登记） | UV_INSTALL_DIR 必须与官方安装器的 HERMES_HOME/bin 一致，仍位于本次 HOME；禁止由测试环境将 uv 重定向到另一目录再误报生产安装失败 |
| NTFS 上大量运行时文件（实测红灯后登记） | 本地 Linux 容器使用独立 Linux volume 存放测试 HOME/临时文件；不通过放宽生产启动等待或跳过安装掩盖 NTFS 冷启动延迟；导出报告不导出 HOME/依赖 |
| 最小镜像缺少进程/端口工具（实测红灯后登记） | Gateway 实际运行却无 PID 时停止验收；镜像须提供 ss/lsof/ps，不能把无 PID 的端口监听改写成可管理成功 |
| 长安装请求提前失联（实测红灯后登记） | 900 秒安装预算须贯穿 HTTP 请求，不能被 Node fetch 的隐式 header 等待限制在约 300 秒提前截断；改用本地原生 HTTP 请求保留显式 AbortSignal、回环和响应大小限制，不缩减安装/版本/聊天验收 |
| Gateway sidecar 尚未就绪（实测红灯后登记） | 仅对服务端明确返回 UNAVAILABLE/retryable=true 的启动中状态按 retryAfterMs 有界重试，保留回执；认证/签名错误不重试、不降级、不当成功 |
| Hermes 版本命令契约（实测红灯后登记） | 独立版本核验使用发行物真实支持的 --version，不将不存在的 version 子命令误报为安装失败；API 与实际 CLI 精确版本仍须一致 |
| Hermes 顶层模型被子配置污染（真实 HTTP 红灯后登记） | 同步 maintenance-model 后，即使模板后面含 stt.model/辅助模型与行尾注释，hermes_read_config 也须只返回顶层模型与同步的 base URL，不修改其余配置 |
| 原生 Linux 冷启动超过 10 秒（托管容器红灯后登记） | 首轮 GitHub 容器在 10.66 秒正常监听，生产 API 在第 10 秒提前失败。启动等待须异步且有界至 60 秒，已运行立即返回，超时仍保留本次日志；不重启、不重复拉起、不以测试重试掩盖生产错误。真实容器必须完成聊天、Provider 回执和停止验收 |

## 范围

只增加 `scripts/maintenance-runtime-smoke.mjs` 与本文，不修改生产契约、既有测试或 CI。只测试当前检出代码的推荐版本；候选版本应先在独立适配分支修改生产版本策略，再运行此脚本。不会自动合并、打 tag 或发布。

## 执行与证据

```sh
node scripts/maintenance-runtime-smoke.mjs --engine pi
node scripts/maintenance-runtime-smoke.mjs --engine opencode --output .tmp/my-opencode-run
node scripts/maintenance-runtime-smoke.mjs --engine deepseek-harness
node scripts/maintenance-runtime-smoke.mjs --engine hermes
node scripts/maintenance-runtime-smoke.mjs --engine openclaw
# CI：验收器取自可信 tooling，生产后端、cwd、策略和内核取自 candidate
node tooling/scripts/maintenance-runtime-smoke.mjs --root candidate --engine pi --output .tmp/runtime
# 内层隔离容器：只读 tooling，可写 candidate 和 evidence，不挂 Docker socket
node /tooling/scripts/maintenance-runtime-smoke.mjs --root /candidate --engine deepseek-harness --output /evidence/runtime
```

默认 root 是验收器自身的项目，显式 `--root` 相对调用者 cwd 解析。候选必须通过 `package.json` / `package-lock.json`（name、type、version）、OpenClaw 版本策略及受管版本声明检查，缺文件或格式变化即失败。不 import 候选测试，不调用候选验收器；由可信脚本自身断言 candidate 的 HTTP/Provider 回执。版本常量从候选源码声明读取，不从 tooling 固定版本读取。

默认输出 `<root>/.tmp/maintenance-runtime-<engine>-<unique>`，显式 `--output` 相对调用者 cwd 解析。输出目录必须全新，避免覆盖历史证据。全新 HOME 默认位于输出中；Windows DSH 使用 `<candidate>/.tmp/mrh-<unique>` 的短新 HOME，避免 pnpm 生命周期的长路径问题。真实 HOME、用户 npm/git 配置、模型凭据、SSH/代理环境不继承；HERMES_HOME、OPENCLAW_CONFIG_DIR 和 XDG 等均独立设置。API 会回读实际配置目录，因为仅设置 OPENCLAW_CONFIG_DIR 并不代表生产后端会采纳它。

每份输出包含：

- `report.json` / `report.md`：环境、版本、候选关键文件哈希、验收器哈希、各阶段预期/实际、总体状态、退出码、可重跑 argv。
- `commands.json`：实际子进程的程序、参数、candidate cwd、时间与退出码。
- `api-receipts.json`：真实生产 API / 内嵌代理请求响应；不保存认证 Header，内嵌会话 URL 脱敏。
- `provider-requests.json`：只来自本次模拟 Provider 的请求，核对模型、唯一提示词和认证存在性，不保存 Header 凭据。
- `logs/`：脱敏 Web、命令与引擎日志；失败原始回执保留。

上传证据建议白名单上述文件与 `logs/`，不上传 `home/`、`tmp/` 中的大体积依赖。受管配置只有本次生成的测试值，不包含用户账号。默认整体预算 20 分钟，可加 `--timeout-ms 180000`；安装/启动每 30 秒打印阶段耗时与报告路径。超时也执行有界 finally 清理，任何清理错误均非零退出。CI 应再设置外层 job 超时和 always 上传证据。

只有所有必需阶段实际 `passed` 且无故障注入时，整体才 `passed` / exit 0；`missing` 和 `failed` 均 exit 1。禁止使用 `continue-on-error` 或只检查文件存在来把不完整测试当作通过。

这是通过真实 Web 生产 HTTP 入口的服务端 E2E，不替代浏览器视觉验收、Tauri 原生端、真实渠道账号与收费模型验收。隔离环境不等于操作系统沙箱；上游安装包的生命周期脚本属于受信代码，CI 建议使用一次性虚拟机。

## Source ID 与能力边界

| `--engine`（传 selected.id，不是宽泛 engine 字段） | 当前驱动 |
| --- | --- |
| `pi` | 生产 API 安装、独立 CLI 版本核验、模型同步、只读 RPC 会话、两段流式回复、历史关闭/重开、Provider 回执、实际进程停止 |
| `deepseek-harness` | 生产 API 稳定通道安装、版本、认证与内嵌代理、模型同步、真实 Session RPC 与持久日志回读、Provider 回执、PID/端口停止 |
| `opencode` | 生产 API 安装、二进制版本、模型同步、内嵌代理健康/会话/聊天/历史、Provider 回执、PID/端口停止；发现代理错误会拦截 |
| `hermes` | 新增仅限隔离 Linux 容器的精确官方安装 API、版本/commit/安装器 SHA256、默认 Profile、模型同步、Gateway 健康/能力、run 回复与停止驱动；**本轮容器实跑通过**，普通宿主仍 missing，见末尾收尾记录 |
| `openclaw` | 新增隔离 Linux 容器模式：独立 npm-prefix 精确官方包安装，实际 CLI 版本与 config validate，生产 HTTP 配置/启动，candidate `/ws` 签名握手、chat.send/终态/chat.history、本地 Provider/PID/端口回执；**本轮容器实跑通过**，容器内不调用 Docker、不挂 socket；普通宿主 missing |
| `openclaw-zh` | 无针对汉化发行物的完整实测，独立 missing，不偷换为 official |
| `weixin` / `deepseek-harness-preview` | 高风险/真实账号或预览版验收缺口，独立 missing，不自动选择，不回退稳定版冒充 |

内层无 Docker socket 的 `runtime-verify` 可通过 **parent 可信环境**传入 `MAINTENANCE_ISOLATED_RUNTIME=1`。验收器还独立检查 Linux、`/.dockerenv`、非 root、`/proc/self/status` 的 NoNewPrivs=1/CapEff=0、无 Docker socket/DOCKER_HOST；任一不满足则 install missing，子进程不继承这个开关。Issue/PR/CLI/API/候选配置都不作为门禁来源。**不需要、也不应为此挂宿主 Docker socket。** 外层新 job 的 candidate Dockerfile 构建与可信 Docker smoke 是另一项证据，不替代内层 Provider 调用与聊天验收。

Hermes 调用实际生产契约名 `install_hermes`（不是 `hermes_install`）。官方 installer 自身做 pinned hash/commit 核验，测试又独立检查落盘安装器 SHA256 与 checkout commit；HOME/HERMES_HOME、npm-prefix、UV 安装/缓存/Python/tool/bin、pip 配置均隔离。本轮已在 WSL 的独立 Linux Docker Engine 非特权容器确认安装器和驱动契约；宿主拒绝分支及此前红灯仍保留，下面前一轮记录不冒充本轮结果。

## 前一轮执行记录（历史保留，Windows x64 / Node v24.15.0）

编写前确实先建立本文失败清单；以下是之后重新执行的结果，不采用旧版本验收产物。基线 `5144ae5`，工作区其他维护任务的修改保留，本文不代表已提交或发布。

| 实跑 | 实际结果与本地证据 |
| --- | --- |
| Pi 默认 root | 完整 HTTP 链路 exit 0，约 38 秒；`.tmp/maintenance-final-pi/report.json`，Provider 1 次 |
| tooling/candidate 分离 | exit 0，约 32 秒；`.tmp/root-e2e-5fb3a9da/receipt/report.json`。临时 candidate 版本为 `0.22.1-root-e2e`，候选自带验收器被设为抛错；可信 tooling 仍成功验收候选真实后端，证明未误跑候选验收器或 tooling 后端 |
| 同上加源码哈希/重跑记录 | exit 0；`.tmp/maintenance-final-root-pi/report.json`，候选关键源码与版本均来自临时 candidate |
| 同上加实际 RPC PID 退出核对 | 最终复测 exit 0；`.tmp/maintenance-final-pid-root-pi/report.json`，只计入私有 CLI 的真实 RPC PID，close/reopen 两个 PID 均退出，cleanup passed |
| DSH 稳定版 `0.2.0-rc.2` | 完整 HTTP + 真实 DSH RPC + 持久日志 + Provider 回执 + 实际 PID/端口停止 exit 0；`.tmp/maintenance-pid-dsh/report.json`。早一轮 `.tmp/maintenance-final-dsh2/report.json` 约 85 秒、Provider 2 次 |
| OpenCode `1.18.21` | **exit 1 / failed**；`.tmp/maintenance-final-opencode/report.json`。实装、同步、健康通过并收到 Provider 完整回复，但内嵌历史接口返回 gzip 而无 Content-Encoding；保留字节前缀 `1f8b` 与 API 回执，不在测试端补解压来掩盖真实浏览器问题 |
| OpenCode 修复后同一入口复测 | 主任务修改生产代理后，`.tmp/maintenance-opencode-fixed/report.json` **exit 0 / passed**，安装/版本/同步/健康/聊天/历史/Provider/PID/端口与 cleanup 全通过；本子任务没有改生产文件。修复前完整 headers 与前 64 bytes 的独立红灯保留 `.tmp/maintenance-opencode-headers64/api-receipts.json` |
| Hermes 初版拒绝分支 | exit 1 / missing；`.tmp/maintenance-final-hermes/report.json`。模型同步回读通过，未执行宿主安装器；新增容器驱动后宿主在 install 阶段更早拒绝 |
| OpenClaw 初版 Docker 检测（已由内层直装模式替代） | exit 1 / missing；`.tmp/maintenance-final-openclaw/report.json`。本机 Docker daemon 不在线，没有构建镜像，没有宣称官方内核握手/聊天通过 |
| 汉化版 / 微信 / DSH-preview | 均实际执行 source-id 路由并 exit 1 / missing；`.tmp/maintenance-runtime-openclaw-zh-89c053a7-0ab0-453a-b47a-d6472832004c/`、`.tmp/maintenance-runtime-weixin-85f93430-6a7d-43e6-85c7-21354170bb27/`、`.tmp/maintenance-runtime-deepseek-harness-preview-f778ca39-1105-4fa8-bf29-f96c85a24f6b/` |
| 非 ClawPanel candidate | exit 1 / candidate-schema failed；`.tmp/invalid-root-1792081477002/receipt/report.json`，未执行安装 |
| 整体超时 | `--timeout-ms 1000` 实际非零，cleanup passed；`.tmp/maintenance-final-timeout/report.json` |
| 伪造容器变量的宿主拒绝 | Windows parent 即使设置 `MAINTENANCE_ISOLATED_RUNTIME=1`，Hermes/OpenClaw 仍 install missing、exit 1、cleanup passed；`.tmp/maintenance-hermes-host-guard/`、`.tmp/maintenance-openclaw-host-guard/`，未执行安装。非特权 Linux 容器正向分支本轮未运行 |
| 新增容器驱动后的 Pi 回归 | `.tmp/maintenance-final-pi-container-drivers/` 和 `.tmp/maintenance-frozen-pi/` 均完整 passed；后者还验证 Provider 收到的 Bearer 值精确等于本次同步的测试值，只记录匹配布尔值，不保存 Header |
| 最新 OpenCode 凭据精确匹配复测 | `.tmp/maintenance-frozen-opencode/report.json` passed / exit 0，约 134 秒，Provider 请求 Bearer 精确匹配、聊天/历史、实际 PID 退出与 cleanup 通过 |
| DSH 最新强化回归的停止竞态（失败保留） | `.tmp/maintenance-frozen-dsh/report.json` failed / exit 1，约 148 秒；模型、完整回复、终态与测试 Bearer 匹配均通过，首次 stop 状态为 running=false/portOpen=true/error=fetch failed，随后 cleanup 回读正常并确认进程/端口退出。未把这次失败改写成 passed |
| DSH 同入口最终复测并冻结 | `.tmp/maintenance-dsh-final-stop-state/report.json` **passed / exit 0**，94 秒；全部必需阶段 passed，Provider 2 次且凭据精确匹配，实际 PID 退出、端口关闭、最终 running=false/portOpen=false/error 为空、cleanup passed。`freeze.json` 独立回读核对报告与当前验收脚本哈希一致，旧 red receipt 完整保留 |

### 实际执行的负向场景

```sh
node scripts/maintenance-runtime-smoke.mjs --engine pi --fault isolation
node scripts/maintenance-runtime-smoke.mjs --engine pi --fault install
node scripts/maintenance-runtime-smoke.mjs --engine pi --fault version
node scripts/maintenance-runtime-smoke.mjs --engine pi --fault provider
node scripts/maintenance-runtime-smoke.mjs --engine pi --fault stop
node scripts/maintenance-runtime-smoke.mjs --engine pi --fault not-executed
```

这些命令预期均非零，不是成功验收模式。实际已执行：

- HOME 被子进程实际改向本次新目录，`os.homedir()` 与预期不同，失败且未安装：run `e175408a-39ed-43f7-b791-ca906a11237c`。
- 安装失败：第一次 HTTP registry 被生产校验拒绝；之后改为回环 HTTPS/TLS 失败，使真实 npm 安装返回 ECONNRESET，exit 1；最终证据 `.tmp/maintenance-final-install-failure/report.json`。
- 已安装 Pi 的实际版本为 `1.1.0`，与注入的期望 `0.0.0` 不符，版本门禁失败：run `2be3543a-7876-4eac-8fb8-f71de5726932`。
- 只同步配置并开会话，不发送 prompt，真实 Provider 请求数为 0，provider-receipt 失败：run `41572523-2bbf-4526-b7e3-b823779fb2ee`。
- 不执行正常停止，真实 activeSessions 为 1，停止门禁失败，finally 清理成功：run `bd7d494c-586f-477f-9be8-558be06f1b93`。
- 开会话后故意结束执行，chat/provider-receipt 保持 missing，整体 missing / exit 1：run `414e137b-b45c-48a2-a729-e5e75c776d1a`。

除特别写出的路径外，负向 run 位于 `.tmp/maintenance-runtime-pi-<run>/`。新增实际 PID 核对时，第一轮把 Windows ConsoleHost 等辅助子进程也计入，产生停止超时，失败保留于 `.tmp/maintenance-pid-root-pi/`；后续只枚举生产 Web 的私有 Pi CLI `--mode rpc` 子进程，不采集其他用户进程命令行。

### 已发现但未修改的生产缺口

OpenCode 内嵌代理的响应编码：真实聊天 POST 有完整文本，但历史 GET 原始 gzip 字节透传且编码 Header 丢失。主任务已独立修复生产代理，本子任务对同一实际入口重跑通过。旧故障 API 为 `GET /__opencode/<session-token>/session/<session-id>/message`，200/application-json/Content-Length=691/Content-Encoding 缺失，前 64 bytes：

```text
1f8b080000000000000abd53cb72d33014fd17ad9d8ee447627b4993a174789429e53155a673635d2526b62424853474fc07b064c50c2bd6acf8a5f21d8c9d06
```

预期是编码 Header 与正文一致，浏览器可以直接解析 JSON；验收器没有添加 identity 绕开旧故障，也没有补解压假装通过。

DSH 第一轮长 HOME 下的 pnpm 安装实际报 `readStream must be readable`，保留 `.tmp/maintenance-runtime-deepseek-harness-a1c29ca1-6005-4b44-a90a-f22dff5edb8d/`。换本次独立短 HOME 后实装成功；Session 参数也根据实际安装包的 Typert 描述从 `args.cwd` 校正为 `args.request.cwd`，失败回执保留 `.tmp/maintenance-final-dsh/`，之后完整复测通过。

后续 DSH 强化回归还发现停止中间态：测试现区分“带诊断的状态对象”和纯 API error。只在 `dsh_stop/dsh_status` HTTP 200 且含 running/portOpen 类型字段时保留诊断继续核对；不重试停止动作，等待实际 PID 退出、TCP 端口关闭，再限时回读最终 running=false、portOpen=false、error 为空。最终状态未满足仍失败，全部中间回执保留。这个处理没有修改生产后端，也不把异常状态字段直接当作成功。

语法检查通过；现有 `deepseek-harness.test.js`、`opencode.test.js`、`pi-runtime.test.js` 共 20 项回归本次通过。未在本机执行 Linux/macOS、内层安全容器和外层发行 Dockerfile 构建；这些结果等待独立三平台工作流，禁止把 Windows 结果当作三平台通过。

## 前一轮交接（历史记录，非本次最终状态）

- 本轮仅编辑两个指定源文件；未提交、推送、打 tag 或发布。其他维护任务的已有改动保留。
- 冻结脚本 SHA256：`2d227e6bba903f98c63d58f8bb6192ea938104f64070d1f0768d56abb054466e`。
- 最终 DSH 回读证明：`.tmp/maintenance-dsh-final-stop-state/freeze.json`；最终报告：同目录 `report.json` / `report.md`。
- Pi、OpenCode 已通过的真实入口不再扩大测试范围；DSH 停止竞态修正后已按相同入口完成新一轮实装复测，不覆写历史失败。
- 剩余：Hermes 与 OpenClaw 非特权 Linux 容器正向安装/运行/聊天驱动尚未实际执行；只有宿主门禁拒绝已验证。Linux/macOS、内层隔离工作流及外层 candidate Dockerfile smoke 均不作本轮通过声明。

## 本轮首轮收尾（2026-10-16）

- 环境：WSL Ubuntu 24.04 / Docker Engine 29.1.3，官方 Node 24.16.0 验收镜像；UID 1000，cap-drop ALL、NoNewPrivs=1，无 Docker socket/用户 HOME，可信 tooling 只读。测试 HOME 使用本轮独立 Linux volume，导出只含报告与脱敏日志。
- OpenClaw 2026.9.8：全新精确安装、配置 validate、实际 PID、签名握手、chat.send/终态/完整历史、Provider、停止和清理 11/11 passed / exit 0，159 秒，Provider 1 次；证据 .tmp/maintenance-first-run-20261016/evidence/openclaw-linux3/。
- Hermes 0.21.5：全新官方 commit/hash 安装、实际 --version、默认 Profile、统一模型同步/回读、Gateway/API 能力、完整 run 回复、Provider、PID/端口停止和清理 11/11 passed / exit 0，576 秒，Provider 2 次；证据同目录 hermes-linux3/。复用旧 HOME 的 diagnostic2 仅用于定位，明确标记 missing，未当作全新安装证明。
- 实际发行 Dockerfile 镜像：0.22.2 Web 健康/模型配置回读/CLI validate/协议4握手均通过；production-smoke-native-final.log 保存真实 JSON 回执。首次 Docker Hub TLS 超时与各次红灯保留，未放宽 TLS 或握手认证。
- 发现并修复：最小镜像缺 ss/lsof/ps 导致 Gateway 无 PID；Hermes Web 顶层主模型被后续 stt.model 覆盖。验收器另修正明确的 CLI --version 契约、uv 受管路径、长 HTTP 安装预算和仅针对 retryable UNAVAILABLE 的 sidecar 启动等待；没有降低认证/签名门禁。
- 长材料：真实 Issue #332 的 16124 字节完整脱敏回读，巡检 complete=true、8项源均采集；黑盒 E2E 75/75，Node 713通过/2跳过，Rust383通过，Pi实际RPC/前端构建/完整Web打包通过。
- 本地证据基线为29a347a加本轮候选代码/文件hash；不是待发布提交的托管CI证明。发tag仍须 main 同SHA三平台CI、三平台controller、两引擎runtime-selftest与发行镜像 compatibility 实际执行成功，并下载报告核对 commit/hash；skipped不算通过。收费模型、真实消息渠道账号、Tauri原生GUI不在本轮真实HTTP验收范围。

手工托管复验入口：

```powershell
gh workflow run maintenance.yml --ref main -f runtime_selftest=true
gh workflow run compatibility.yml --ref main
```
