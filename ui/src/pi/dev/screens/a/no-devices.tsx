import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { ADesktop, AEmptyTopBar, APhoneList } from "@/pi/dev/frames/AFrames"
import { PiNoDevices } from "@/components/pi/shell"
import { MOCK_LINK, piLinkSummary } from "@/pi/dev/fixtures/gallery/shared"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "no-devices",
  area: "a",
  title: "还没有设备",
  states: [
    "有设备但都离线（列表显示变淡的组，主区写「2 台设备都未连接」）",
    "relay 不支持设备令牌（不显示「配对新设备」，只写接入说明）",
  ],
  notes:
    "空状态、C01。room_list.devices = []、rooms 为空：左栏只有入口行和一行灰字「还没有设备」；主区中央 PiMark → 标题 → 两步说明 → ch4/SuggestionPills（黑「配对新设备」+ 描边「查看接入说明」）。手机同一块在列表区垂直居中，pill 竖排整宽。推断：文案与版式（Cursor 没有对应空状态）。",
}

const LINK = piLinkSummary(MOCK_LINK, [])

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <APhoneList groups={[]} attention={[]} devices={[]} link={LINK} contentClassName="flex min-h-full items-center px-6 pb-10">
          <PiNoDevices variant="phone" className="w-full px-0" />
        </APhoneList>
      ) : (
        <ADesktop groups={[]} attention={[]} devices={[]} link={LINK} listNote="还没有设备" topBar={<AEmptyTopBar />}>
          <div className="flex h-full items-center justify-center pb-16">
            <PiNoDevices variant="desktop" />
          </div>
        </ADesktop>
      )}
    </PiRoot>
  )
}
