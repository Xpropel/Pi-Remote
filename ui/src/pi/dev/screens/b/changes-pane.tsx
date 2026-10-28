import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhonePushed } from "@/pi/dev/frames/BFrames"
import { CHANGED_FILES, CHANGES_TOTAL, CONVO_DONE, NOW, TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiChangesPane } from "@/components/pi/conversation/PiChangesPane"
import { PiPaneTabs, PiPaneTitle } from "@/components/pi/conversation/PiPaneTabs"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "changes-pane",
  area: "b",
  title: "改动视图",
  themes: ["light", "dark"],
  states: [
    "没有改动（「这个会话还没有编辑文件」）",
    "加载中",
    "同一文件多次编辑（按先后列出「第 2 次编辑」）",
    "write 新文件展开（全绿 + New）",
    "编辑失败（行尾红字「未生效」）",
  ],
  notes:
    "G7（新增）D14 B05。r-s1 的会话改动（由 edit / write 记录汇总，不是 git 状态）：3 个文件 +32 −9，第一个文件展开为单列 unified diff + 「N 行未改动」折叠条（行数由 hunk 头算）。行号一列（kit UnifiedDiff 与 Cursor #15 都是一列：增 / 上下文行写新号，删行写旧号）；设计写的「双行号」记 kit 请求。没有勾选、撤销、Commit & Push（§8）。手机 diff 软换行（推断）。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const pane = <PiChangesPane files={CHANGED_FILES} total={CHANGES_TOTAL} variant={phone ? "phone" : "desktop"} />
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <BPhonePushed title={<PiPaneTitle active="changes" />}>{pane}</BPhonePushed>
      ) : (
        <BDesktop
          roomId="r-s1"
          pane={
            <>
              <PiPaneTabs active="changes" changes={CHANGES_TOTAL} />
              {pane}
            </>
          }
          dock={
            <PiComposerDock
              variant="desktop"
              state="S0"
              model={C_MODEL_LABEL}
              tray={[{ ...TRAY_CHANGES, active: true }]}
              status={{ device: "MacBook Pro", branch: "main" }}
            />
          }
        >
          <PiTranscript static items={CONVO_DONE} variant="desktop" now={NOW} />
        </BDesktop>
      )}
    </PiRoot>
  )
}
