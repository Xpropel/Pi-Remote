# 更新记录（Changelog）

本项目所有值得注意的变更都记在这里，按版本倒序。版本号遵循语义化版本。

## 2.0.1 — 2026-10-28

### 新功能

- **二维码设备链接（`device.qr-link`）**：在运行 pi 的电脑上执行 `attach --link` 即可链接这台设备，不必再先去网页生成配对码、手抄到目标机器。
  - attach 向 relay 申请与手输码同表、同 10 分钟有效、同一次性语义的配对码，在终端打印字符二维码、完整链接与 `XXXX-XXXX` 对照码，并同时打开一个本机窗口页出示同样的码（待扫码 / 处理中 / 成功 / 过期四态）。
  - 手机扫码打开网页确认页：展示设备名、平台、剩余有效期与 **2 位核对字**（由 relay 对码统一派生，电脑端与手机端同显，核对一致再批准）；批准必须过管理员令牌门（与生成配对码同一道门）。
  - 码绑定申请它的那条等待连接：连接断开即删码；被截图或转发也只能替这台正在等待的设备完成链接，无法把别人的设备配进账号。批准后 relay 沿等待连接下发设备令牌，attach 复用 `--pair` 的同一落盘段写入 `.env`（0600）。
  - 协议新增帧 `pair_request` / `pair_request_result` / `pair_lookup` / `pair_lookup_result` / `pair_approve` / `pair_claimed`（`pair_result` 复用），已同步进 `protocol/v4.json` 单一事实源与三处副本。
  - 二维码编码器为内置的单文件实现（qrcode-generator 1.4.4，MIT，位于 `deploy/qrcode.js`），**不新增任何 npm 依赖**。终端太窄、链接过长或编码器缺失时自动降级为只打印链接与对照码；relay 太旧不认识新帧时明确提示改用 `--pair`。
  - 原有手输配对码流程（网页生成码 + `attach --pair`）完整保留，两条路径长期并存。

### 修复

- **viewer 鉴权空令牌守卫缺失**：relay 的 viewer 通道比对令牌时未做非空校验，当 viewerToken 未配置（空串）且客户端也发空 token 时会误判通过（正常启动入口有缺 token 拦截，直接以编程方式启动 relay 时可达）。已改为与 local / admin 通道一致的非空守卫口径。
- **会话清理可能误广播**：`purge` 调用会话索引的 `forgetSession` 时只捕获异常、未检查其失败返回值（该函数失败时返回 `false` 而不抛错），索引没清掉也会广播 `session_removed`，旧会话会在清单里以空壳形式残留。已改为返回值失败时不计入已删、不广播，留待下一轮清理重试。
- **广播序列化无兜底**：`wire.broadcast` 的 `JSON.stringify` 没有异常保护，遇到不可序列化的帧会把异常抛到定时器 / setImmediate 路径。已与单发 `send` 对齐：出错记日志并跳过本次广播。

### 打包修复

- **v2.0.0 设备包解压后 attach 无法启动**：三个设备包都漏放 attach 顶层依赖的 `protocol/v4.json`，Linux 包另漏 `deploy/session-library.cjs`，且包内没有 `package.json`（文档流程的 `npm install` 无从执行）。干净解压实测 v2.0.0 的 attach 会因找不到模块直接退出。本版设备包已补齐上述文件，并新增 `deploy/qrcode.js`；每个包均经干净解压 + 实际运行验证。

### 测试

- 新增测试文件并全部登记进 `npm test` 清单：`test/pair-qr-link.test.js`（链接全链路、管理员门、过期、断线删码、重配旧令牌校验、限速与上述三项修复的回归）、`test/attach-link.test.js`、`test/qrcode.test.js`、`test/pi-pair-link.test.mjs`。
- 全套 2044 个测试通过；另有 6 个真 tmux / doctor 用例在沙盒 root 环境下失败，已用 v2.0.0 原始代码同环境对照，失败集合完全一致，属既有环境性失败、非本次引入。
- 上线前另在独立测试机完成真链路冒烟：真 relay + 真 `attach --link`（出码、窗口四态、核对字一致、错误管理员令牌被拒、批准后令牌落盘 0600）与真 `attach --pair` 回归，共 18 项检查全过。

## 2.0.0 — 2026-10-28

- 首个公开发布：relay 中转服务（双端口、设备配对、会话镜像与命令通道）、pi 扩展、桌面与移动双端网页界面（六套皮肤）、Windows / macOS / Linux 设备包与部署脚本。
