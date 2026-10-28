import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiComposerDock } from "@/components/pi/composer"
import { CDesktop, CTranscript } from "@/pi/dev/frames/CFrames"
import { C_MODEL_LABEL, C_PREFS } from "@/pi/dev/fixtures/gallery/c"
import { PiDisplayOptions } from "@/components/pi/composer/PiDisplayOptions"
import {
  MOCK_ATTENTION,
  MOCK_DEVICES,
  MOCK_LINK,
  MOCK_NOW,
  mockSessionCounts,
  piLinkSummary,
  piSessionGroups,
} from "@/pi/dev/fixtures/gallery/shared"
import {
  PiAccountFooter,
  PiPhonePage,
  PiRoot,
  PiSheet,
  PiSidebar,
  PiTopBar,
} from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "quick-settings",
  area: "c",
  title: "显示选项",
  states: ["筛选生效（左栏顶部 chip「只看 MacBook Pro ×」，组头只写目录名）"],
  notes:
    "K01 C03 H06（待用户确认 6）。快捷设置不回到顶栏【测试 quick-settings】，改由账户区右端的滑杆图标打开（hunt-fullwindow-poster#9 只有图标，打开后的内容整套推断）：设备筛选（shared PiDeviceMenu 的行样式，含「全部设备」）→ 分组方式 → 主题 → 工具显示 → 全部设置…。桌面从滑杆上方弹出、宽 260、左缘对齐左栏；手机 = 列表页 + PiSheet，行 48。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const link = piLinkSummary(MOCK_LINK)
  if (phone) {
    return (
      <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
        <PiPhonePage
          topBar={<PiTopBar variant="phone-list" />}
          footer={<PiAccountFooter link={link} variant="phone" pressed="options" />}
          scrollTop={0}
          sheet={
            <PiSheet static title="显示选项" bodyClassName="px-2">
              <PiDisplayOptions static variant="phone" bare prefs={C_PREFS} devices={MOCK_DEVICES} counts={mockSessionCounts()} now={MOCK_NOW} />
            </PiSheet>
          }
        >
          <PiSidebar
            variant="phone"
            groups={piSessionGroups()}
            attention={MOCK_ATTENTION}
            link={link}
            now={MOCK_NOW}
            devices={MOCK_DEVICES}
          />
        </PiPhonePage>
      </PiRoot>
    )
  }
  const dock = (
    <PiComposerDock static variant="desktop" state="S0" model={C_MODEL_LABEL} tray={[TRAY_CHANGES]} status={{ device: "MacBook Pro", branch: "main" }} />
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      <CDesktop
        roomId="r-s1"
        dock={dock}
        footerPressed="options"
        overlay={
          // 不是模态：没有压暗；浮层贴在账户区（高 52）上方 4px
          <div className="pointer-events-none absolute inset-0">
            <div className="pointer-events-auto absolute bottom-[56px] left-2">
              <PiDisplayOptions static variant="desktop" prefs={C_PREFS} devices={MOCK_DEVICES} counts={mockSessionCounts()} now={MOCK_NOW} />
            </div>
          </div>
        }
      >
        <CTranscript variant="desktop" />
      </CDesktop>
    </PiRoot>
  )
}
