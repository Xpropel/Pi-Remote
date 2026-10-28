import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { CDesktop } from "@/pi/dev/frames/CFrames"
import { PiSettingsPage } from "@/components/pi/composer/PiSettingsPage"
import { PiPhonePage, PiRoot, PiTopBar } from "@/components/pi/shared"
import { C_NOW, C_PREFS } from "@/pi/dev/fixtures/gallery/c"
import { MOCK_DEVICES, MOCK_RELAY_HOST } from "@/pi/dev/fixtures/gallery/shared"

export const piScreen: PiScreenMeta = {
  id: "settings",
  area: "c",
  title: "设置",
  states: [
    "设备节（H02：设备卡、命令复制、窗口快到期警告、「配对新设备」）",
    "连接与帮助节（B07 / B08：relay 地址复制、协议 v4、能力清单、立即重连、接入三步、快捷键表）",
    "关于节（版本、退出登录两次确认 A02：第一次点变「再点一次退出」）",
    "偏好同步不支持（脚注改写「这台 relay 不支持同步」）",
  ],
  notes:
    "H01–H05 H08 H09 B07 B08 A02 I03 K13。左栏不变（账户区齿轮按下态），主区整块换成设置：中列分类导航用 ch5/MarketplaceNav（直接 import，宽 200）、右侧白卡分组宽 560。去掉了皮肤、11 套调色板、字体（待用户确认 1），只留主题三选一、字号三档、工具显示三档（分段控件推断）。页面外通知只写说明（K13）。手机：推入页，分类导航变成页面里的分组，行 52。版本号是 mock。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <PiPhonePage topBar={<PiTopBar variant="phone-page" title="设置" />} scrollTop={0}>
          <PiSettingsPage static variant="phone" prefs={C_PREFS} devices={MOCK_DEVICES} relayHost={MOCK_RELAY_HOST} now={C_NOW} />
        </PiPhonePage>
      ) : (
        <CDesktop footerPressed="settings">
          <PiSettingsPage static variant="desktop" prefs={C_PREFS} devices={MOCK_DEVICES} relayHost={MOCK_RELAY_HOST} now={C_NOW} />
        </CDesktop>
      )}
    </PiRoot>
  )
}
