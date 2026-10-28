import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiFolderBrowser } from "@/components/pi/composer/PiFolderBrowser"
import { emptyFolderBrowserState } from "@/pi/model/folderBrowser"
import { BrowserStage } from "./_frame"

// 画廊屏必须同时导出 piScreen 元数据和默认组件；新屏不占 lint 的 warning 预算（P9 §6.1 上限 117），
// 这里局部关掉 react-refresh 的「文件只导出组件」规则（既有 30+ 个画廊屏都有这条 warning）。
// eslint-disable-next-line react/only-export-components
export const piScreen: PiScreenMeta = {
  id: "folder-browser",
  area: "c",
  title: "文件夹浏览器（P9 C，开发屏）",
  states: ["正常：面包屑 + 上一级 + 子文件夹列表 + 显示隐藏文件夹开关", "加载中（Spinner + 正在读取…）", "截断（只显示前 500 个）"],
  notes:
    "P9 C（spec §5.5）：桌面 PiDialog「在这台 Mac 上选择文件夹」/ 手机全高 PiSheet；底部从左到右是当前路径（中段截断）、取消、「在这里新建会话」。这一屏画正常态；出错 / 空目录见 folder-browser-states。不进 80 张对图。",
}

const SNAPSHOT = emptyFolderBrowserState({
  path: "/Users/dev/code",
  root: "/Users/dev",
  parent: "/Users/dev",
  entries: [
    { name: "dotfiles", path: "/Users/dev/code/dotfiles" },
    { name: "notes-app", path: "/Users/dev/code/notes-app" },
    { name: "pi-remote", path: "/Users/dev/code/pi-remote" },
  ],
})

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <BrowserStage viewport={viewport} theme={theme}>
      <PiFolderBrowser static viewport={viewport} scopeLabel="在这台 Mac 上" snapshot={SNAPSHOT} />
    </BrowserStage>
  )
}
