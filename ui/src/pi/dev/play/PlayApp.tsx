import { PiDesktopShell, PiPhonePage } from "@/components/pi/shared"
import type { PiLayout } from "@/components/pi/shared/viewport"
import { composerBlockOf } from "@/pi/model/composerButton"
import { usePiShellShortcuts } from "@/pi/hooks/usePiShellShortcuts"
import { PlayADialogs, PlayASheets, PlayPhoneFooter, PlaySidebar, PlayTopBar } from "./a"
import { PlayBOverlays, PlayBSheets, PlayPane, PlayTranscript } from "./b"
import { PlayCOverlays, PlayCSheets, PlayDock, PlayNewSession, PlaySettings } from "./c"
import { usePlayUi, type PlayPreset, type PlaySlotProps } from "./state"

/**
 * #/play 的外壳（P4，R2/p4-lanes.md §4）：外壳级状态 + 快捷键接线，内容全部来自三条线各自的 play/<线>.tsx。
 * 快捷键（桌面）：⇧⌘O 新建会话、⌘K 命令面板、⌘B 侧栏 expanded ↔ rail、⌘. 右 pane、⌘, 设置；
 * Esc 分层：菜单 → 浮层 → 停止生成（usePiShellShortcuts，canStop 按 composerBlockOf 算）。
 * 本文件归 p4-base；各线不改它，需要新槽位时写 R2/lane-requests/p4-<线>.md。
 */
export function PlayApp({ screen, preset, viewport }: { screen: string; preset: PlayPreset; viewport: PiLayout }) {
  const phone = viewport === "phone"
  const [ui, act] = usePlayUi(screen, preset)
  const block = composerBlockOf(ui.running ? "S3" : "S0", null)
  usePiShellShortcuts({
    enabled: !phone,
    canStop: ui.view === "session" && (block.button.variant === "stop" || block.button.ghostStop),
    onStop: act.stop,
    onNewSession: act.newSession,
    onCommandPalette: () => act.setPaletteOpen(true),
    onToggleSidebar: act.toggleSidebar,
    onTogglePane: act.togglePane,
    onOpenSettings: act.openSettings,
  })
  const p: PlaySlotProps = { ui, act, variant: phone ? "phone" : "desktop" }

  if (phone) {
    const sheets = (
      <>
        <PlayASheets {...p} />
        <PlayBSheets {...p} />
        <PlayCSheets {...p} />
      </>
    )
    if (ui.view === "new") return <PlayNewSession {...p} />
    if (ui.view === "settings") return <PlaySettings {...p} />
    if (ui.phonePage === "list") {
      return (
        <div data-pi-play-shell="phone-list" className="contents">
          <PiPhonePage topBar={<PlayTopBar {...p} />} footer={<PlayPhoneFooter {...p} />} sheet={sheets}>
            <PlaySidebar {...p} />
          </PiPhonePage>
        </div>
      )
    }
    return (
      <div data-pi-play-shell="phone-chat" className="contents">
        <PiPhonePage
          topBar={<PlayTopBar {...p} />}
          dock={
            <div className="px-4 pt-2">
              <PlayDock {...p} />
            </div>
          }
          sheet={sheets}
          scrollTop="bottom"
        >
          <PlayTranscript {...p} />
        </PiPhonePage>
      </div>
    )
  }

  const session = ui.view === "session"
  return (
    <div data-pi-play-shell="desktop" data-last-action={ui.lastAction ?? undefined} className="contents">
      <PiDesktopShell
        sidebar={<PlaySidebar {...p} />}
        topBar={session ? <PlayTopBar {...p} /> : undefined}
        dock={session ? <PlayDock {...p} /> : undefined}
        pane={session && ui.pane ? <PlayPane {...p} /> : undefined}
        overlay={
          <>
            <PlayADialogs {...p} />
            <PlayBOverlays {...p} />
            <PlayCOverlays {...p} />
          </>
        }
      >
        {session ? <PlayTranscript {...p} /> : ui.view === "new" ? <PlayNewSession {...p} /> : <PlaySettings {...p} />}
      </PiDesktopShell>
    </div>
  )
}
