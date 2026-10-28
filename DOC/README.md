# DOC：设计文档

本目录是 pi-remote 的架构与设计说明，记录各模块为什么这样设计、接口怎么约定。

它不是接口契约本身——契约以 `protocol/` 与 `readyUI/data-interface.md` 为准；也不是部署手册——部署见 `deploy/README.md`。

| 文件 | 内容 |
|---|---|
| `10-relay-backend.md` | relay 应用逻辑：设备窗口、会话清单、命令路由 |
| `20-local-device.md` | 本地设备端：连接命令、扩展窗口门控与清单上报（Windows / macOS / Linux） |
| `30-server-ops.md` | 云服务器部署与运维设计 |
| `50-protocol-delta.md` | 协议增量：设备 / 连接窗口 / 会话清单的帧与状态机（已并入 data-interface v3.1，本文保留设计背景） |
| `71-protocol-v4.md` | 协议 v4：握手、错误码、消息 id、设备令牌 |
| `76-settings-write-bridge.md` | 设置写桥 `settings_set` 的设计与实现说明 |
| `device-harness.md` | 多设备与远程打开 pi 的总体设计 |
| `session-registry.md` | 会话登记：服务端索引层设计 |
