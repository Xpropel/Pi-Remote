import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiComposerDock } from "@/components/pi/composer"
import { CDesktop, CPhoneChat, CTranscript } from "@/pi/dev/frames/CFrames"
import { C_DRAFT, C_DRAFT_IMAGES, C_DRAFT_MENTIONS, C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "composer-keyboard",
  area: "c",
  title: "输入区 · 键盘弹出",
  themes: ["light", "dark"],
  keyboard: true,
  states: [
    "S0 空闲且空（浅灰 ↑，不可点）",
    "S2 发送中（↑ 短暂禁用，ack 超过 200ms 框下写「发送中…」）",
    "S5 离线 / 设备离线（占位「写好先排队」，原因在框下状态行，发送进 outbox）",
    "S7 撤销或只读（输入区整体禁用，占位「输入已禁用」，原因在框下状态行）",
    "键盘开着时有原因（状态行收起，原因挪到两层上层首行：13px、--cw-pi-text-secondary、单行截断，在引用 chip 行之上；键盘收起后回到状态行）",
    "超长（框下红字「太长了，最多 100000 字」）",
    "到 132px 上限后框内滚动",
    "上下文 ≥70% 预警环（只在键盘收起时出现在状态行右端）",
    "桌面 ↑ / ↓ 提示词历史（K04）",
  ],
  notes:
    "E01 E02 E06 E15 J06 K04。S1：两行草稿 + 1 个 @ 引用 chip + 1 张待发图（jpeg 96 KB）。手机键盘开着：composer 两层贴在键盘占位上方（底距 8），tray、框下状态行、Home 指示条收起，流停在底部；输入框 16px（防 iOS 放大）、Enter 换行、发送只靠黑圆钮。键盘高度 336 是估计，真机贴边未验证。两层形态的圆角 20 推断。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dock = (
    <PiComposerDock static
      variant={variant}
      state="S1"
      draft={C_DRAFT}
      mentions={C_DRAFT_MENTIONS}
      images={C_DRAFT_IMAGES}
      model={C_MODEL_LABEL}
      tray={[TRAY_CHANGES]}
      status={{ device: "MacBook Pro", branch: "main" }}
      layered
      keyboardOpen={phone}
      caret
    />
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <CPhoneChat roomId="r-s1" dock={dock} keyboardOpen>
          <CTranscript variant={variant} />
        </CPhoneChat>
      ) : (
        <CDesktop roomId="r-s1" dock={dock}>
          <CTranscript variant={variant} />
        </CDesktop>
      )}
    </PiRoot>
  )
}
