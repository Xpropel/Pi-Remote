import type { CSSProperties } from "react"
// 衬线门面 / 无衬线控件 / 等宽的替身字体（§1.3；官方字体不分发，由 @fontsource 提供，随变体 chunk 懒加载）
// 字体体积优化：只声明显式用到的字重轴 / latin 子集（italic、其他 unicode 子集不声明 → 不构建、不预载）
import "@fontsource-variable/newsreader/wght.css"
import "@fontsource-variable/inter/wght.css"
import "@fontsource/jetbrains-mono/latin-400.css"
import { PI_SAFE_AREA, PiHeadlessRoot, usePiRootGeometry } from "@/pi/headless"
import type { VariantAppProps } from "../types"
import { ClaudeLogin } from "./pages/ClaudeLogin"
import { ClaudeDesktopShell } from "./shell/ClaudeDesktopShell"
import { ClaudePhoneShell } from "./shell/ClaudePhoneShell"
import "./styles/reset.css"
import "./styles/tokens.css"
import "./styles/dark.css"
import "./styles/claude.css"

/**
 * Claude v2 入口（完全自包含）：根 = @/pi/headless 的 PiHeadlessRoot（布局语义：产品 fixed/100dvh、舞台 absolute、
 * 键盘平移、<html> 主题/布局镜像、安全区探针），根 DOM / 类名 / CSS 变量（--claude-safe-* / --claude-keyboard-h）全部自有。
 * 只允许的依赖：@/relay/**、@/pi/model/** 纯函数、@/pi/headless、白名单 hooks、containers/types 与 shared/viewport 的 import type；
 * 不 import 任何 cursor UI 组件 / 容器 / 样式。
 * 分支：没有 token → 登录；否则按 layout（1024 断点语义）进桌面 / 手机壳。
 * P9 B：正在看的会话被删且无别的会话可切 → purgedRoom 一次性信号 → 进新建会话页。
 */
export function ClaudeApp(props: VariantAppProps) {
  const { relay, ui, act, keyboardOpen, theme, layout, device } = props
  const { geometry, probeRef } = usePiRootGeometry({ viewport: layout, theme, keyboard: keyboardOpen, device })
  const stageSafe = PI_SAFE_AREA[layout]
  const product = device != null
  const style = {
    "--claude-safe-top": `${geometry.safeTop}px`,
    "--claude-safe-bottom": product ? "env(safe-area-inset-bottom, 0px)" : `${stageSafe.bottom}px`,
    "--claude-safe-left": product ? "env(safe-area-inset-left, 0px)" : "0px",
    "--claude-safe-right": product ? "env(safe-area-inset-right, 0px)" : "0px",
    "--claude-keyboard-h": `${geometry.keyboardH}px`,
    colorScheme: theme,
  } as CSSProperties
  const p = { relay, ui, act, keyboardOpen, variant: layout } as const
  return (
    <PiHeadlessRoot
      ui="claude"
      viewport={layout}
      theme={theme}
      keyboard={keyboardOpen}
      device={device}
      geometry={geometry}
      probeRef={probeRef}
      className="claude-root"
      style={style}
    >
      {!relay.token ? <ClaudeLogin p={p} /> : layout === "desktop" ? <ClaudeDesktopShell p={p} theme={theme} /> : <ClaudePhoneShell p={p} />}
    </PiHeadlessRoot>
  )
}
