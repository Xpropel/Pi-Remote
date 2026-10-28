/** b/session-archived：只点选了未载入的 s7（Mac Studio/infra，openable:false），正文是设备推过来的本机记录。 */
import { archiveView, type ArchiveSession } from "../../../../relay/sessionArchive.ts"
import { BASE, INFRA } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const S = 1000
const M = 60 * S
/** s7 最后一个回合的起点：一天前（replica mockOther T7） */
const T7 = MOCK_NOW - 24 * 3600 * S - 4 * M - 12 * S

/** attach 读会话文件推过来的本机记录（ArchiveSession 形状：只有 user / assistant 的文字，见缺口 G9） */
export const ARCHIVE_S7: ArchiveSession = { id: "s7",
  cwd: INFRA,
  name: null,
  firstMessage: "升级 nginx 配置",
  messageCount: 64,
  truncated: true,
  omitted: 22,
  messages: [
    { id: "u-s7-2", role: "user", text: "把 nginx 升到 1.27，配置里的 ssl_protocols 也顺便检查一下。", timestamp: T7 },
    { id: "a-s7-4", role: "assistant",
      text: "配置能过 `nginx -t`，但有三处建议一起改：\n\n| 项 | 现在 | 建议 |\n|---|---|---|\n| `ssl_protocols` | TLSv1 TLSv1.1 TLSv1.2 | TLSv1.2 TLSv1.3 |\n| `gzip` | off | on（text/css、application/json） |\n| `client_max_body_size` | 1m | 20m |",
      timestamp: T7 + 38 * S,
    },
    { id: "a-s7-7", role: "assistant",
      text: "## 灰度步骤\n\n1. 从负载均衡里摘掉 `web-2`，等连接数降到 0；\n2. 在 `web-2` 上装 1.27.2，换上新的 server 段，跑 `nginx -t`；\n3. 只放 5% 流量回来，看 10 分钟的 5xx 和 TLS 握手失败率；\n4. 没问题再放全量，按同样步骤处理 `web-1`。",
      timestamp: T7 + 3 * M + 10 * S,
    },
  ],
}

const fixture: PiLiveFixture = {
  id: "session-archived",
  now: MOCK_NOW,
  note: "replica 这一屏还有压缩摘要、本机 !nginx -t、扩展消息、过大图占位；ArchiveSession 只有 user / assistant 文字，这些条目出不来（缺口 G9）。",
  relay: {
    ...BASE,
    selectedDeviceId: "d-studio",
    roomId: "s7",
    online: false,
    lazySession: {
      id: "s7",
      title: "升级 nginx 配置",
      firstMessage: "升级 nginx 配置",
      path: "/Users/dev/.pi/agent/sessions/s7.jsonl",
      cwd: INFRA,
      online: false,
      busy: false,
      viewers: 0,
      messageCount: 64,
      updatedAt: MOCK_NOW - 24 * 3600 * S,
      openable: false,
      deviceId: "d-studio",
    },
    lazySend: null,
    sessionArchive: (sessionId: string) => (sessionId === "s7" ? archiveView(ARCHIVE_S7) : null),
    transcript: { items: [], liveKey: null, seq: 0, bashKey: null, pendingTools: {} },
    usage: null,
  },
}
export default fixture
