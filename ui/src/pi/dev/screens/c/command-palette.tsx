import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiComposerDock } from "@/components/pi/composer"
import { CDesktop, CPhoneChat, CTranscript } from "@/pi/dev/frames/CFrames"
import { C_MODEL_LABEL, PALETTE_COMMANDS, PALETTE_SESSIONS } from "@/pi/dev/fixtures/gallery/c"
import { PiCommandPalette } from "@/components/pi/composer/PiCommandPalette"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "command-palette",
  area: "c",
  title: "命令面板",
  states: [
    "有查询（多出「建议」组：「新建会话：「…」」）",
    "无结果",
    "离线（命令行禁用，灰字写原因）",
    "↑↓ 移动选中行",
  ],
  notes:
    "G01 G07 B14。⌘K 打开（不再是聚焦搜索）。版式参照 ch1/ActionsPalette（卡宽 680、距顶 120、圆角 16、--cw-palette-bg、范围 pill），Pi 要「命令 / 会话」两组，所以自组；行尾键帽直接用 ch1/KeycapGroup，只写浏览器里真能触发的键（新建会话 ⇧⌘O 不是 ⌘N）。会话组 = 最近 4 个（行首状态标记 + 灰字组名）。手机：全高 PiSheet，无键帽、无快捷键行。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dock = (
    <PiComposerDock static variant={variant} state="S0" model={C_MODEL_LABEL} tray={[TRAY_CHANGES]} status={{ device: "MacBook Pro", branch: "main" }} />
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <CPhoneChat roomId="r-s1" dock={dock} sheet={<PiCommandPalette static variant="phone" commands={PALETTE_COMMANDS} sessions={PALETTE_SESSIONS} />}>
          <CTranscript variant={variant} />
        </CPhoneChat>
      ) : (
        <CDesktop roomId="r-s1" dock={dock} overlay={<PiCommandPalette static variant="desktop" commands={PALETTE_COMMANDS} sessions={PALETTE_SESSIONS} />}>
          <CTranscript variant={variant} />
        </CDesktop>
      )}
    </PiRoot>
  )
}
