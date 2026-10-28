import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { A_OUTBOX } from "@/pi/dev/fixtures/gallery/a"
import { ADesktop, APhoneChat } from "@/pi/dev/frames/AFrames"
import { ADock, ATranscript } from "@/pi/dev/frames/AConversation"
import { CONVO_SHORT, TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { MOCK_LINK_WAITING, MOCK_RETRY_COUNT, piLinkSummary } from "@/pi/dev/fixtures/gallery/shared"
import { PiRoot, PiStatusLine, type PiItem } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "reconnecting",
  area: "a",
  title: "与服务器断开",
  states: [
    "正在重连（Spinner +「正在重连…」）",
    "断开满 30 秒（「已断开 · 立即重连」）",
    "恢复（「已重新连接」1 秒淡出，outbox 按顺序发出，cid + dedupeKey 不重复）",
    "第一次就连不上（「连不上服务器，8 秒后重试」）",
  ],
  notes:
    "A03 A04 K02 A07 K07。断线等第 3 次重连、4 秒后（LinkView waiting）；用户刚在离线时发了一条，进本页 outbox（待用户确认 5）：用户卡下灰字「等重连后发送」、tray「排队 1 · 等重连」。列表与流保留最后状态；连接状态只在顶栏下这一行表达（账户区第二行同口径），不进通知槽。v1.2（D-02）：composer 占位「写好先排队」，原因写进框下状态行「未连接服务器 · 发送会排队」（tone=warn）；手机只写原因，桌面后接「 · MacBook Pro · main」；手机仍是单行胶囊。推断：状态行样式、outbox 呈现。",
}

const OUTBOX_ITEMS: PiItem[] = A_OUTBOX.map((o) => ({
  kind: "user",
  key: `outbox-${o.cid}`,
  text: o.text,
  images: [],
  timestamp: o.at,
  from: "remote",
  cid: o.cid,
  outbox: true,
}))

const ITEMS: PiItem[] = [...CONVO_SHORT, ...OUTBOX_ITEMS]
const TRAY = [{ kind: "queue" as const, label: `排队 ${A_OUTBOX.length} · 等重连` }, TRAY_CHANGES]
/** v1.2（D-02，design §1.6）：占位只用短句，原因写进框下状态行 */
const PLACEHOLDER = "写好先排队"
const NOTE = "未连接服务器 · 发送会排队"

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const link = MOCK_LINK_WAITING.kind === "waiting" ? MOCK_LINK_WAITING : { seconds: 0, first: false }
  const statusLine = <PiStatusLine state="waiting" seconds={link.seconds} first={link.first} attempt={MOCK_RETRY_COUNT} />
  // 手机只写原因；桌面在原因后接「 · MacBook Pro · main」（§1.6）。这里自己按视口给字段，不依赖 c 的自动处理
  // v1.3（§12.3-4，R2-M-11）：PiStatusLine 已经 role="status" 播报连接状态，框下原因段 live: false 只作视觉，不重复播报
  const status = phone
    ? { note: NOTE, tone: "warn" as const, live: false }
    : { note: NOTE, tone: "warn" as const, device: "MacBook Pro", branch: "main", live: false }
  const dock = <ADock variant={variant} state="S5" tray={TRAY} placeholder={PLACEHOLDER} status={status} />
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <APhoneChat roomId="r-s1" statusLine={statusLine} dock={dock}>
          <ATranscript variant="phone" items={ITEMS} />
        </APhoneChat>
      ) : (
        <ADesktop selectedId="r-s1" link={piLinkSummary(MOCK_LINK_WAITING)} statusLine={statusLine} dock={dock}>
          <ATranscript variant="desktop" items={ITEMS} />
        </ADesktop>
      )}
    </PiRoot>
  )
}
