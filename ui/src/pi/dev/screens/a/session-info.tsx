import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { ADesktop, APhoneChat, aHead } from "@/pi/dev/frames/AFrames"
import { ADock, ATranscript } from "@/pi/dev/frames/AConversation"
import { PiSessionInfoCard } from "@/components/pi/shell"
import {
  MOCK_BRANCH,
  MOCK_DEVICES,
  MOCK_MODEL,
  MOCK_THINKING_LEVEL,
  MOCK_USAGE,
  mockSession,
} from "@/pi/dev/fixtures/gallery/shared"
import {
  PiButton,
  PiRoot,
  PiSheet,
  PiTopBar,
} from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "session-info",
  area: "a",
  title: "会话信息（标题悬停卡）",
  states: [
    "无分支（get_git_branch 没有结果：整行不出现）",
    "窗口不可信（只写「上下文 61.8k tokens」，不画圆环）",
    "≥70%（圆环与数字变深）",
    "≥90%（圆环变红）",
    "手机 sheet 里的「重命名」",
  ],
  notes:
    "B03 B06 K09 E13。r-s1 的标题悬停卡（宽 320）：标题 → 设备 → 分支（get_git_branch）→ 工作目录 → 模型 · 思考级别 → 上下文圆环 30.9% · 61.8k / 200k → $3.84 · 缓存命中 87%（cacheRead / (input + cacheRead)）→ 会话 id → 用量明细。比 ch2/SessionHoverCard 多设备、费用、会话 id 三行，所以自组（参照其几何）。手机点标题出同内容的 sheet + 描边「重命名」/ 黑色「用量明细」。推断：图标、三档圆环色。",
}

const ROOM = "r-s1"

function card(variant: "desktop" | "phone") {
  const s = mockSession(ROOM)
  const device = MOCK_DEVICES.find((d) => d.id === s?.deviceId) ?? MOCK_DEVICES[0]
  return (
    <PiSessionInfoCard
      variant={variant}
      title={s?.title ?? ROOM}
      device={device}
      branch={MOCK_BRANCH}
      cwd={s?.cwd ?? ""}
      model={`${MOCK_MODEL.name} · ${MOCK_THINKING_LEVEL}`}
      usage={MOCK_USAGE}
      sessionId={s?.sessionId ?? ROOM}
    />
  )
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const head = aHead(ROOM)
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <APhoneChat
          roomId={ROOM}
          dock={<ADock variant="phone" />}
          sheet={
            <PiSheet
              static
              title="会话信息"
              footer={
                <>
                  <PiButton kind="outline" variant="phone" className="flex-1">
                    重命名
                  </PiButton>
                  <PiButton variant="phone" className="flex-1">
                    用量明细
                  </PiButton>
                </>
              }
            >
              {card("phone")}
            </PiSheet>
          }
        >
          <ATranscript variant="phone" />
        </APhoneChat>
      ) : (
        <ADesktop
          selectedId={ROOM}
          topBar={<PiTopBar static variant="desktop" title={head.title} platform={head.platform} hoverCard={card("desktop")} hoverCardOpen />}
          dock={<ADock variant="desktop" />}
        >
          <ATranscript variant="desktop" />
        </ADesktop>
      )}
    </PiRoot>
  )
}
