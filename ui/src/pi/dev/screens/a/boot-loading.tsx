import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { ADesktop, AEmptyTopBar, APhoneList } from "@/pi/dev/frames/AFrames"
import { MOCK_RELAY_HOST, piLinkSummary } from "@/pi/dev/fixtures/gallery/shared"
import { PiCenteredState, PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "boot-loading",
  area: "a",
  title: "首次加载",
  states: [
    "打开会话后快照未到（流中央「正在从 MacBook Pro 拉取会话…」+ Spinner，composer 可写）",
    "深链失效（J08：PiCenteredState「会话不可用 · 会话不存在或设备已离线」+「返回会话列表」，5 秒规则不变）",
    "界面崩溃（清单·错误边界：白卡「界面出错了」+ 一行灰字原因 + 黑色「重新加载」）",
  ],
  notes:
    "A06。本图 = 首次连接（LinkView first），devices / rooms 为空：左栏只有品牌行、两条入口行和骨架行（无扫光），主区中央 Spinner；快照确认前不出现空会话卡（修 U-12）。推断：骨架行样式。",
}

const LINK = piLinkSummary({ kind: "first" }, [])

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <APhoneList groups={[]} attention={[]} devices={[]} loading link={LINK} />
      ) : (
        <ADesktop groups={[]} attention={[]} devices={[]} loading link={LINK} topBar={<AEmptyTopBar />}>
          <div className="flex h-full items-center justify-center pb-16">
            <PiCenteredState
              spinner
              title={<span className="font-normal text-(--cw-pi-text-secondary)">正在连接 {MOCK_RELAY_HOST}…</span>}
            />
          </div>
        </ADesktop>
      )}
    </PiRoot>
  )
}
