/**
 * b 区 mock：r-s3（等你回答）、r-s6（出错）、s7（未载入的本机记录）、r-s8（离线设备）的转录。
 * 会话 id、标题、时间与 shared/mock.ts（§3.2）一致。
 */
import { NGINX_CONF } from "@/pi/dev/fixtures/gallery/bFiles"
import { NOW, tool } from "@/pi/dev/fixtures/gallery/bConvo"
import type { PiDialogCard, PiItem } from "@/components/pi/shared/types"

const S = 1000
const M = 60 * S
const H = 60 * M
const MODEL = "claude-sonnet-4-5"

/* ------------------------------------------------------------------ r-s3：等你回答 */

export const BACKFILL_TEST = [
  `import assert from "node:assert/strict"`,
  `import { test } from "node:test"`,
  `import { planBackfill } from "../ui/src/relay/history.ts"`,
  ``,
  `test("截断：只补到渲染窗的上沿", () => {`,
  `  const plan = planBackfill({ loaded: 300, total: 420, window: 300 })`,
  `  assert.deepEqual(plan, { from: 0, count: 120, truncated: true })`,
  `})`,
  ``,
  `test("到顶：没有更早的消息时不再请求", () => {`,
  `  assert.equal(planBackfill({ loaded: 42, total: 42, window: 300 }), null)`,
  `})`,
  ``,
].join("\n")

export const APPROVAL_DIALOG: PiDialogCard = {
  dialogId: "dlg-7f3",
  kind: "select",
  title: "允许 pi 运行这条命令吗？",
  message: "npm test -- history-backfill",
  options: ["允许一次", "这个会话里都允许", "拒绝"],
  timeout: 120_000,
  startedAt: NOW - 38 * S,
  answerable: true,
}

export const CONVO_APPROVAL: PiItem[] = [
  {
    kind: "user",
    key: "u-r3-6",
    text: "给 history-backfill 补几个测试，覆盖截断和补拉到顶两种情况。",
    images: [],
    timestamp: NOW - 190 * S,
    from: "remote",
    status: "delivered",
  },
  {
    kind: "assistant",
    key: "a-r3-7",
    model: MODEL,
    startedAt: NOW - 188 * S,
    durationMs: 14 * S,
    timestamp: NOW - 188 * S,
    usage: { totalTokens: 12_800 },
    stopReason: "toolUse",
    blocks: [
      { kind: "thinking", observedMs: 4 * S, text: "先读 history.ts 里的补拉规划函数，确认截断和到顶分别返回什么。" },
      tool("toolu_02Rd1a", "read", { path: "ui/src/relay/history.ts", offset: 1, limit: 160 }, "…"),
    ],
  },
  {
    kind: "assistant",
    key: "a-r3-8",
    model: MODEL,
    startedAt: NOW - 172 * S,
    durationMs: 30 * S,
    timestamp: NOW - 172 * S,
    usage: { totalTokens: 15_300 },
    stopReason: "toolUse",
    blocks: [
      {
        kind: "text",
        text: "两种情况都能直接构造…",
        prose: [{ p: ["两种情况都能在 ", { code: "planBackfill" }, " 里直接构造，写成一个新测试文件："] }],
      },
      tool("toolu_02Wr1b", "write", { path: "test/history-backfill.test.mjs", content: BACKFILL_TEST }, "Wrote 12 lines to test/history-backfill.test.mjs"),
    ],
  },
  {
    kind: "assistant",
    key: "a-r3-9",
    model: MODEL,
    startedAt: NOW - 41 * S,
    durationMs: 3 * S,
    timestamp: NOW - 41 * S,
    usage: { totalTokens: 16_100 },
    stopReason: "toolUse",
    blocks: [
      { kind: "text", text: "跑一下：", prose: [{ p: ["跑一下这个文件："] }] },
      // 扩展的确认框挡在执行前（dialog_open）。现在的协议里工具块停在 input-available（会显示成运行中）；
      // 这里用 ToolState 里预留的 waiting_approval，画出数据源给出这一态之后的样子（推断）
      tool("toolu_02Bs1c", "bash", { command: "npm test -- history-backfill" }, "", { state: "waiting_approval" }),
    ],
  },
]

/* ------------------------------------------------------------------ r-s6：对话里的错误 */

export const CONVO_ERRORS: PiItem[] = [
  {
    kind: "user",
    key: "u-r6-9",
    text: "跑一下对账脚本，对一下 9 月的退款。",
    images: [],
    timestamp: NOW - 44 * M,
    from: "remote",
    status: "delivered",
  },
  {
    kind: "assistant",
    key: "a-r6-10",
    model: MODEL,
    startedAt: NOW - 44 * M + 2 * S,
    durationMs: 6 * S,
    timestamp: NOW - 44 * M + 2 * S,
    usage: { totalTokens: 9_400 },
    stopReason: "toolUse",
    blocks: [
      { kind: "text", text: "先跑对账脚本：", prose: [{ p: ["先跑对账脚本："] }] },
      tool(
        "toolu_03Bs1a",
        "bash",
        { command: "node scripts/reconcile.mjs --month 2026-09" },
        "Reconciling refunds for 2026-09…\nConnecting to postgres://127.0.0.1:5432/billing",
        { state: "output-error", exitCode: 1, stderr: "Error: connect ECONNREFUSED 127.0.0.1:5432" },
      ),
    ],
  },
  {
    kind: "assistant",
    key: "a-r6-11",
    model: MODEL,
    startedAt: NOW - 43 * M,
    durationMs: 8 * S,
    timestamp: NOW - 43 * M,
    usage: { totalTokens: 10_900 },
    stopReason: "toolUse",
    blocks: [
      {
        kind: "text",
        text: "数据库连不上…",
        prose: [{ p: ["本机的 Postgres 没起来。先清掉上次导出的临时文件，再直接跑一遍检查 SQL："] }],
      },
      tool("toolu_03Bs1b", "bash", { command: "rm -rf tmp/exports" }, "Tool execution was blocked: 用户拒绝了这条命令", {
        state: "output-error",
        outcome: "denied",
      }),
      tool("toolu_03Bs1c", "bash", { command: "psql -f checks.sql", timeout: 120 }, "Command timed out after 120 seconds", {
        state: "output-error",
        outcome: "timeout",
      }),
    ],
  },
  // auto_retry_start / auto_retry_end 的落点（3 次都没成功之后的收据）
  { kind: "receipt", key: "rt-r6-12", text: "自动重试 3/3 都没成功", timestamp: NOW - 38 * M - 20 * S },
  {
    kind: "assistant",
    key: "a-r6-13",
    model: MODEL,
    startedAt: NOW - 38 * M - 12 * S,
    durationMs: 2 * S,
    timestamp: NOW - 38 * M - 12 * S,
    stopReason: "error",
    errorMessage: "overloaded_error",
    blocks: [],
  },
  {
    kind: "user",
    key: "u-r6-14",
    text: "数据库起来了，再试一次",
    images: [],
    timestamp: NOW - 37 * M,
    from: "remote",
    cid: "c-2b7q0",
    status: "sending",
    failed: "ack timeout",
  },
]

/* ------------------------------------------------------------------ s7：未载入的会话（本机记录，SessionArchiveView） */

/** s7 最后一个回合的起点（用户消息）：一天前；回合用时 3m 31s */
const T7 = NOW - 24 * H - 4 * M - 12 * S

export const ARCHIVE: { items: PiItem[]; truncated: boolean; olderCount: number } = {
  truncated: true,
  olderCount: 22,
  items: [
    {
      kind: "summary",
      key: "sm-s7-1",
      title: "已压缩上下文",
      text: "之前讨论了 nginx 1.24 → 1.27 的升级顺序与证书路径。",
      tokensBefore: 132_000,
      tokensAfter: 18_000,
      timestamp: T7 - 5 * M,
    },
    {
      kind: "user",
      key: "u-s7-2",
      text: "把 nginx 升到 1.27，配置里的 ssl_protocols 也顺便检查一下。",
      images: [],
      timestamp: T7,
      from: "local",
    },
    {
      kind: "bash",
      key: "bs-s7-3",
      command: "nginx -t",
      label: "你运行了",
      output:
        "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful",
      timestamp: T7 + 25 * S,
    },
    {
      kind: "assistant",
      key: "a-s7-4",
      model: MODEL,
      startedAt: T7 + 38 * S,
      durationMs: 46 * S,
      timestamp: T7 + 38 * S,
      stopReason: "stop",
      blocks: [
        {
          kind: "text",
          text: "配置检查结果…",
          prose: [
            { p: ["配置能过 ", { code: "nginx -t" }, "，但有三处建议一起改："] },
            {
              table: {
                head: ["项", "现在", "建议"],
                rows: [
                  [{ code: "ssl_protocols" }, "TLSv1 TLSv1.1 TLSv1.2", "TLSv1.2 TLSv1.3"],
                  [{ code: "gzip" }, "off", "on（text/css、application/json）"],
                  [{ code: "client_max_body_size" }, "1m", "20m"],
                ],
              },
            },
            { p: ["改好的 server 段："] },
            { code: NGINX_CONF, lang: "plain" },
            {
              task: [
                { done: true, text: ["备份 ", { code: "/etc/nginx" }] },
                { done: false, text: ["先灰度一台"] },
              ],
            },
          ],
        },
      ],
    },
    {
      kind: "custom",
      key: "cu-s7-5",
      label: "命令输出 · remote-bash",
      text: "$ nginx -v\nnginx version: nginx/1.27.2",
      timestamp: T7 + 2 * M + 40 * S,
    },
    {
      kind: "assistant",
      key: "a-s7-6",
      model: MODEL,
      startedAt: T7 + 3 * M + 5 * S,
      durationMs: 4 * S,
      timestamp: T7 + 3 * M + 5 * S,
      stopReason: "toolUse",
      blocks: [
        tool(
          "toolu_04Rd1a",
          "read",
          { path: "docs/nginx-dashboard.png" },
          "",
          { images: [{ data: "", mimeType: "image/png", omitted: true, bytes: 2_516_582 }] },
        ),
      ],
    },
    {
      kind: "assistant",
      key: "a-s7-7",
      model: MODEL,
      startedAt: T7 + 3 * M + 10 * S,
      durationMs: 21 * S,
      timestamp: T7 + 3 * M + 10 * S,
      stopReason: "stop",
      blocks: [
        {
          kind: "text",
          text: "灰度步骤…",
          prose: [
            { h: ["灰度步骤"] },
            {
              ol: [
                ["从负载均衡里摘掉 ", { code: "web-2" }, "，等连接数降到 0；"],
                ["在 ", { code: "web-2" }, " 上装 1.27.2，换上新的 server 段，跑 ", { code: "nginx -t" }, "；"],
                ["只放 5% 流量回来，看 10 分钟的 5xx 和 TLS 握手失败率；"],
                ["没问题再放全量，按同样步骤处理 ", { code: "web-1" }, "。"],
              ],
            },
            { p: ["回滚：保留 ", { code: "/etc/nginx.bak-1024" }, "，出问题时换回旧配置并 ", { code: "nginx -s reload" }, "。"] },
            { quote: ["注意：TLSv1.1 关掉后，老的内部对账客户端（Java 7）会连不上，先确认它已经下线。"] },
          ],
        },
      ],
    },
  ],
}

/* ------------------------------------------------------------------ r-s8：离线设备上的最后快照（a 区 device-offline 用） */

export const CONVO_OFFLINE: PiItem[] = [
  {
    kind: "user",
    key: "u-r8-24",
    text: "导出地图时 tiles 的坐标偏了半格，看一下 exporter。",
    images: [],
    timestamp: NOW - 27 * H - 6 * M,
    from: "local",
  },
  {
    kind: "assistant",
    key: "a-r8-25",
    model: MODEL,
    startedAt: NOW - 27 * H - 5 * M,
    durationMs: 48 * S,
    timestamp: NOW - 27 * H - 5 * M,
    usage: { totalTokens: 14_200 },
    stopReason: "stop",
    blocks: [
      { kind: "thinking", text: "坐标偏半格，多半是像素中心和格子左上角混用了。" },
      tool("toolu_05Rd1a", "read", { path: "src/export/tiles.ts", offset: 1, limit: 140 }, "…"),
      {
        kind: "text",
        text: "找到了…",
        prose: [
          {
            p: [
              "找到了：",
              { code: "toTileCoord" },
              " 先加了 0.5 再取整，导出时又按格子中心算了一次，所以偏半格。去掉其中一次就行。",
            ],
          },
        ],
      },
    ],
  },
  {
    kind: "user",
    key: "u-r8-26",
    text: "先别改，等我回来再说",
    images: [],
    timestamp: NOW - 27 * H - 2 * M,
    from: "remote",
    status: "delivered",
  },
  {
    kind: "assistant",
    key: "a-r8-27",
    model: MODEL,
    startedAt: NOW - 27 * H - 2 * M + 3 * S,
    durationMs: 6 * S,
    timestamp: NOW - 27 * H - 2 * M + 3 * S,
    usage: { totalTokens: 14_900 },
    stopReason: "stop",
    blocks: [{ kind: "text", text: "好的，先不动。方案记在上面，回来说一声我就改。" }],
  },
]
