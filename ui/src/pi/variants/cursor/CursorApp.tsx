import { PiLayerProvider, PiRoot } from "@/components/pi/shared"
import { PiAppBody } from "@/pi/containers/PiAppBody"
import type { VariantAppProps } from "../types"

/**
 * cursor 变体的入口 = 现有 Cursor 风格界面原样（P1 架构线，brief §架构契约 1「现有 UI 原样保留，不能回归」）。
 * 从 PiApp.tsx 原样搬来的 PiRoot + PiLayerProvider + PiAppBody（层级、props 都不变），
 * 只有一处新增：根节点 data-pi-ui="cursor"（经 PiRoot 的 ui 参数写），给切换架构 / 测试断言用。
 * 默认变体，静态 import、不过 React.lazy —— 首屏不闪、外观与行为与改造前一致。
 */
export function CursorApp(props: VariantAppProps) {
  const { relay, ui, act, keyboardOpen, theme, layout, device } = props
  return (
    <PiRoot ui="cursor" viewport={layout} theme={theme} keyboard={keyboardOpen} device={device}>
      <PiLayerProvider>
        <PiAppBody relay={relay} ui={ui} act={act} variant={layout} keyboardOpen={keyboardOpen} theme={theme} />
      </PiLayerProvider>
    </PiRoot>
  )
}
