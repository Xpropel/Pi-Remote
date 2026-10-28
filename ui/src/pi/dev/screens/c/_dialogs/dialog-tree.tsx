import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiTreeDialog } from "@/components/pi/composer"
import { TREE_FILTER_OPTIONS } from "@/pi/model/dialogsData"
import { DIALOG_SESSION_TITLE, DialogStage } from "./_frame"

export const piScreen: PiScreenMeta = {
  id: "dialog-tree",
  area: "c",
  title: "会话树（G10，开发屏）",
  themes: ["light", "dark"],
  states: ["跳转并总结（多一行说明）", "没有匹配的节点", "树为空", "跳转中（行尾「跳转中…」）"],
  notes: "P5 c 线新做，版式推断（design §2 H：跳转方式、筛选、搜索、缩进节点、当前叶加粗，560）。节点是 mock（flattenTree 的输出形状）。不进 80 张对图。",
}

const NODES = [
  { id: "u-01", label: "user: 修复手机键盘收起时输入框跳动", depth: 0, current: false },
  { id: "a-02", label: "assistant: 先看 useMobileViewport 的取值", depth: 0, current: false },
  { id: "u-07", label: "user: 横屏的时候也测一下", depth: 0, current: false },
  { id: "a-08", label: "assistant: 跑横屏用例", depth: 1, current: true },
  { id: "u-09", label: "user: 换一种做法：改 visualViewport 监听", depth: 1, current: false },
  { id: "a-10", label: "assistant: 改成 resize + scroll 两个事件", depth: 2, current: false },
]

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiTreeDialog static viewport={viewport} subtitle={DIALOG_SESSION_TITLE} nodes={NODES} filterOptions={TREE_FILTER_OPTIONS} />
    </DialogStage>
  )
}
