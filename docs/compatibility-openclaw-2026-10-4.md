# OpenClaw 2026.10.4 隔离适配

## 授权和发布边界

维护者于2026-10-16明确批准官方 `2026.10.4` 的隔离适配，新旧版本完整复测。本日不追加 tag 或 Release；验收和同 main SHA 的必需 CI 全过后，后续日期按每日最多一版发布。只发布 GitHub，不触发独立官网同步。

新安装推荐从 `2026.10.3` 调整为 `2026.10.4`。已安装内核不因面板更新自动升级；汉化版、历史面板锁定值及其他引擎目标不变。GitHub 控制器 AI/PR/autoRelease 保持关闭，其他高风险升级和既有安全依赖告警不在本次批准范围。

## 精确上游依据

- [正式 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.10.4)，签名 tag 的代码提交为 `383c124cc32ffee3f8e56f549b88da94d269a4af`。
- [npm 精确版本](https://registry.npmjs.org/openclaw/2026.10.4)，Node 要求仍为 `>=24.16.0 <25 || >=26.1.0`，与10.3相同；安装固定版本，不依赖浮动 latest。
- 本版涉及 Tlon group DM owner 识别、MCP OAuth loopback 回调、独立插件启动和 Gateway 生命周期等改动，仍按高风险对待；本次批准不把它们降为低风险。
- 上游 [Tlon身份边界](https://github.com/openclaw/openclaw/pull/165801)、[MCP OAuth](https://github.com/openclaw/openclaw/pull/170876)、[独立插件启动](https://github.com/openclaw/openclaw/pull/171330) 与 [Gateway ownership heartbeat](https://github.com/openclaw/openclaw/pull/170790) 分别复核。面板不复制、绕开或削弱上游授权逻辑；不跟随自动扫描材料中的任意外部链接。
- GitHub compare 的文件列表到300项上限，不能当作全部变更审计；重点接口回读、精确包与实际运行验收分别留证，不用发行说明替代运行结论。

## 验收契约

执行前先记录失败场景并保留推荐版本不一致的红灯。保留已有测试及全部断言，验证新默认在版本策略、前端、Linux、发行Docker、Compose一致。

实际内核矩阵为 `2026.10.4`、原 `2026.10.3` 和历史 `2026.9.8`：每个版本使用独立候选/HOME/随机回环端口，非特权容器、无capabilities、NoNewPrivs、可信验收器只读、无Docker socket。旧版目标覆盖必须明确标为测试fixture，不冒充发行默认。

各版本验证生产Web实际安装、版本、配置同步、模型Provider请求、完整流式终态、停止和清理；另验错误Token/签名/Origin拒绝、正常重连及真实Chromium唯一回复/断线重连/刷新历史不重放。发行Docker按实际Dockerfile另行构建和验证。

运行报告、原始失败及复测、环境/输入/命令/期望/实际、截图和trace保存到本地验收目录 `.tmp/openclaw-20261004-approved/`；托管CI与容器报告绑定本轮提交。文档列的是验收契约，不是事先声明所有步骤已通过，实际状态以该目录检查点和对应Actions为准。

## 不冒充已覆盖的范围

模拟Provider不等于收费模型；Linux容器和三平台编译/回归不等于原生Tauri GUI、Windows/macOS实际内核或真实消息渠道账户。Tlon账户、真实OAuth服务器、Tailscale尾网及上游全部功能不由本轮面板接入验收冒充通过。
