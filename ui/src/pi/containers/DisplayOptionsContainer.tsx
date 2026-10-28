import { PiDisplayOptions } from "@/components/pi/composer"
import { PiSheet } from "@/components/pi/shared"
import { usePiStatic } from "@/components/pi/shared/layers"
import { useNow } from "@/pi/hooks/useNow"
import { sessionCountsOf } from "@/pi/model/newSession"
import { usePrefsWriter, useSettingsPrefs } from "./cShared"
import { PI_UI_IDS, type PiContainerProps } from "./types"

/**
 * 显示选项（plan §7.3 quick-settings、P5.5，c 线）：devices、sessionsByDevice（每台设备的会话数）、偏好。
 * "分组：按设备 / 不分组"写 act.setPref("grouping", …)（改分组时 expanded 自动清空），a 的 SidebarContainer 读 ui.prefs.grouping；
 * 设备筛选写 prefs.deviceFilter（"全部设备" = null）；筛选生效时侧栏顶部的 chip 归 a 画（决定 2）；设备行时长用 piDuration 整点写法（部件里）。顶栏仍然不挂入口。
 *
 * DisplayOptionsContainer：桌面菜单内容，a 的 SidebarContainer 把它传给 PiSidebar 的 optionsMenu（账户区滑杆的锚定菜单）。
 * DisplayOptionsSheet：手机 sheet（PhoneApp 的 sheet 槽），ui.sheet?.id === PI_UI_IDS.displayOptions 时出现（a 的账户栏滑杆开它）。
 * DisplayOptionsOverlay：静态态（#/live 截图）下桌面菜单开着（ui.menu?.id === PI_UI_IDS.displayOptions）时按画廊屏的摆法画在外壳 overlay 槽
 * （PiMenu 在静态态只画触发元素，p4-lanes §1.3）；由 DialogsContainer 挂上，可交互时什么都不画。
 */

function useDisplayOptions(p: PiContainerProps) {
  const { relay, act, variant } = p
  const now = useNow(1000)
  const prefs = useSettingsPrefs(p)
  const write = usePrefsWriter(p)
  return {
    prefs,
    devices: relay.devices,
    counts: sessionCountsOf(relay.sessionsByDevice, relay.devices),
    now,
    onPrefsChange: write,
    onOpenSettings: () => {
      if (variant === "phone") act.closeSheet()
      else act.closeMenu()
      act.openSettings()
    },
  }
}

export function DisplayOptionsContainer(props: PiContainerProps) {
  const data = useDisplayOptions(props)
  return <PiDisplayOptions variant="desktop" {...data} />
}

export function DisplayOptionsSheet(props: PiContainerProps) {
  const data = useDisplayOptions(props)
  if (props.ui.sheet?.id !== PI_UI_IDS.displayOptions) return null
  return (
    <PiSheet
      title="显示选项"
      bodyClassName="px-2"
      onOpenChange={(open) => {
        if (!open) props.act.closeSheet()
      }}
    >
      <PiDisplayOptions variant="phone" bare {...data} />
    </PiSheet>
  )
}

export function DisplayOptionsOverlay(props: PiContainerProps) {
  const isStatic = usePiStatic()
  const data = useDisplayOptions(props)
  if (!isStatic || props.variant !== "desktop" || props.ui.menu?.id !== PI_UI_IDS.displayOptions) return null
  return (
    // 不是模态：没有压暗；浮层贴在账户区（高 52）上方 4px，左缘对齐左栏（同画廊屏 c/quick-settings）
    <div className="pointer-events-none absolute inset-0">
      <div className="pointer-events-auto absolute bottom-[56px] left-2">
        <PiDisplayOptions static variant="desktop" {...data} />
      </div>
    </div>
  )
}
