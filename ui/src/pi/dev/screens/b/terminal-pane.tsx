import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhonePushed } from "@/pi/dev/frames/BFrames"
import {
  CHANGES_TOTAL,
  CONVO_STREAMING,
  LIVE_RUNNING,
  LIVE_SUBAGENTS,
  NOW,
  TERMINALS,
  TRAY_CHANGES,
  TRAY_TASKS,
  TRAY_TERMINAL,
} from "@/pi/dev/fixtures/gallery/b"
import { PiPaneTabs, PiPaneTitle } from "@/components/pi/conversation/PiPaneTabs"
import { PiTerminalPane, PiTerminalToolbar } from "@/components/pi/conversation/PiTerminalPane"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "terminal-pane",
  area: "b",
  title: "终端视图",
  states: [
    "还没运行过命令（「这个会话还没有运行命令」）",
    "结束后保留（「已结束 · 30 秒后移出」，失败 60 秒）",
    "连接断开结果未知（state unknown：灰字「连接断开，结果未知」）",
    "用户上滑（「↓ 最新」）",
  ],
  notes:
    "B10 B12 F03 K11。本会话 3 条命令（TerminalItem[]，与流里那 3 条 bash 同源）：git diff --stat 成功 0.4s、npm run lint 失败（stderr 红字，收起）、npm test -- mobile --grep 横屏 运行中（展开、贴底跟随）。结束的两条都还在保留期内（30 / 60 秒）。流内的运行中终端卡只露最后 4 行，完整输出只在这里展开（§1.8）。卡片运行 / 失败态推断；手机输出软换行（修 U-15）、行号默认关；手机工具行钉在顶栏下（PiPhonePage.subHeader，M-10）。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  // 手机：工具行钉在顶栏下（PiPhonePage.subHeader，M-10），pane 不再自带；行号默认关
  const pane = <PiTerminalPane items={TERMINALS} now={NOW} variant={phone ? "phone" : "desktop"} toolbar={!phone} />
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <BPhonePushed
          title={<PiPaneTitle active="terminal" />}
          subHeader={<PiTerminalToolbar items={TERMINALS} variant="phone" lineNumbers={false} />}
        >
          {pane}
        </BPhonePushed>
      ) : (
        <BDesktop
          roomId="r-s1"
          pane={
            <>
              <PiPaneTabs active="terminal" terminalRunning changes={CHANGES_TOTAL} />
              {pane}
            </>
          }
          dock={
            <PiComposerDock
              variant="desktop"
              state="S3"
              model={C_MODEL_LABEL}
              tray={[TRAY_TASKS, { ...TRAY_TERMINAL, active: true }, TRAY_CHANGES]}
              status={{ device: "MacBook Pro", branch: "main", delivery: "steer", running: true }}
            />
          }
        >
          <PiTranscript static items={CONVO_STREAMING} variant="desktop" now={NOW} running={LIVE_RUNNING} subagents={LIVE_SUBAGENTS} />
        </BDesktop>
      )}
    </PiRoot>
  )
}
