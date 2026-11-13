import { PiLayerProvider, PiRoot } from "@/components/pi/shared"
import { PiAppBody } from "@/pi/containers/PiAppBody"
import type { VariantAppProps } from "../types"

/**
 * 界面入口：PiRoot + PiLayerProvider + PiAppBody。
 * 根节点的 data-pi-ui="cursor"（经 PiRoot 的 ui 参数写）不能去掉：pi-theme.css 的产品模式宽度规则按它命中。
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
