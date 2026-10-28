import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiFolderBrowser } from "@/components/pi/composer/PiFolderBrowser"
import { emptyFolderBrowserState } from "@/pi/model/folderBrowser"
import { BrowserStage } from "./_frame"

// 画廊屏必须同时导出 piScreen 元数据和默认组件；新屏不占 lint 的 warning 预算（P9 §6.1 上限 117），
// 这里局部关掉 react-refresh 的「文件只导出组件」规则（既有 30+ 个画廊屏都有这条 warning）。
// eslint-disable-next-line react/only-export-components
export const piScreen: PiScreenMeta = {
  id: "folder-browser-states",
  area: "c",
  title: "文件夹浏览器：出错 / 空目录（P9 C，开发屏）",
  states: [
    "出错：红字「读取失败 · 文件夹不存在」+「重试」（桌面这一屏）",
    "空目录：「这个文件夹里没有子文件夹」（手机这一屏）",
    "截断：「只显示前 500 个」；加载中：「正在读取…」（同 folder-browser 的 states）",
  ],
  notes:
    "P9 C（spec §5.5）的四种状态各画一种：桌面画出错（fs_not_found），手机画空目录。加载中 / 截断不再单独出图。不进 80 张对图。",
}

const ERROR = emptyFolderBrowserState({ path: "/Users/dev/code", root: "/Users/dev", parent: "/Users/dev", error: "文件夹不存在", showHidden: false })
const EMPTY = emptyFolderBrowserState({ path: "/Users/dev/Desktop", root: "/Users/dev", parent: "/Users/dev", entries: [] })

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  return (
    <BrowserStage viewport={viewport} theme={theme}>
      <PiFolderBrowser static viewport={viewport} scopeLabel="在这台 Mac 上" snapshot={phone ? EMPTY : ERROR} />
    </BrowserStage>
  )
}
