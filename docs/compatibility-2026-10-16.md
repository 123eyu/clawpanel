# 2026-10-16 维护风险门禁与 OpenClaw 兼容边界

## 本轮范围

维护者明确批准：先修复巡检风险漏判，再隔离适配官方 OpenClaw `2026.10.3`，验收和同一提交 CI 通过后发布。此批准不覆盖 OpenCode、其他高风险升级、独立官网同步或打开 GitHub AI/PR/自动发布开关。

新安装推荐由 `2026.9.8` 改为 `2026.10.3`，已安装内核不会因面板更新自动被升级。汉化版及历史面板版本锁定策略保持原样。

官方精确来源：

- [OpenClaw v2026.10.3](https://github.com/openclaw/openclaw/releases/tag/v2026.10.3)，tag commit `59cb44796b0f1f0daa0e37af8b1495abb45d9bc1`。
- [npm 精确版本元数据](https://registry.npmjs.org/openclaw/2026.10.3)，Node 要求仍为 `>=24.16.0 <25 || >=26.1.0`。
- [固定 tag 的完整 Changelog](https://github.com/openclaw/openclaw/blob/v2026.10.3/CHANGELOG/2026.10.3.md)。认证、凭据、进程执行及受保护网络变化按高风险处理，不因本轮获批改成低风险。

## 维护门禁

巡检不再只扫描最终 Release 简述：收集升级区间说明，对完整 Changelog 做有界回读，记录精确 tag、Git blob、SHA256 与缺口。裸链、引用式链接、分片目录、中间版本、材料错误与等价版本排序均有黑盒回归。材料来自固定官方 API，不向输入 URL 发送凭据，不执行说明或反馈中的指令。

自动候选仍须数据完整且非高风险；分页、文件或字节预算耗尽、范围未覆盖时停止自动挑选。本规则是保守筛查，不是完整上游源码安全审计。

## 真实运行证据

本轮预提交候选快照已在 Node `24.16.0`、非特权 Linux 容器、全新 HOME 下分别运行官方 `2026.10.3` 与旧版 `2026.9.8`：

- 两版各 11 阶段：精确安装、版本、生产 Web API 配置保存、真实 CLI 校验、真实 Gateway、模拟 Provider 请求、完整回复/历史、停止与清理。
- 两版各 8 项协议补充：正确 Token、同设备重连、错误 Token、错误签名、不允许 Origin、负向后恢复、配置完整性与资源清理。协议 4、v3 Ed25519；未关闭认证、放宽 Origin 或更改配对权限。
- 旧版采用独立候选副本，仅把默认目标显式设为 `2026.9.8`；它是向后兼容 fixture，不是发布默认，也不冒充新版本的同 SHA 验收。
- 实际发行 Dockerfile 已完成构建和 Web 健康、131072 上下文保存回读、配置校验及协议 4 握手。
- 真实 Chromium 已从聊天界面发送唯一提示词并收到对应的完整中文回复，强制断开原生 WebSocket 后自动重连，刷新页面恢复历史；独立 Provider 回执确认该提示词只请求一次，没有自动重放。截图与 trace 保留在本轮证据目录。

本地证据位于 `.tmp/openclaw-20261003-approved/`：`acceptance-plan.md`、`runtime-evidence/`、`auth-summary.json`、`production-smoke-retry.log` 及维护门禁红/绿报告。预提交快照使用旧面板版本号，不等于已发布的旧版本发行包；发布前仍必须重新核对最终提交 SHA 的三平台 CI、维护控制器、OpenClaw/Hermes 容器和发行 Docker 报告。

## 重跑与未覆盖范围

```powershell
node --test tests/*.test.js
node scripts/test-pi-runtime.mjs
node scripts/test-maintenance.mjs --output .tmp/maintenance-recheck-<new-id>
npm run build
cd src-tauri
cargo fmt --check
cargo check --locked
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

真实安装仅在受限的一次性 Linux 容器执行，可信验收器只读；参考维护工作流的 `runtime_selftest` 和 `Runtime Compatibility`。不能用宿主全局安装或模拟 RPC 替代容器运行报告。

这里没有声称三平台原生 GUI、macOS/Windows 原生 OpenClaw 进程、真实消息渠道账号、收费模型或全部上游功能都已验收。其他内核目标不变；未批准的高风险候选继续通知人工确认。
