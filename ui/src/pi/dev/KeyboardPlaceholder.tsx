import { createPortal } from "react-dom"
import { PI_KEYBOARD_H, PI_STAGE, type PiTheme, type PiStageSize } from "./registry"

/**
 * 中性的屏幕键盘占位：只表示被键盘盖住的区域，不画按键（键盘的样子未验证）。
 * portal 到 body、按文档坐标贴在舞台底部（舞台在 (0,0)），层级最高：屏幕里 portal 出去的菜单也会被它盖住，和真机一样。
 * 设计屏舞台（#/pi）和 live 舞台（#/live，P5）共用；P5 前在 PiStage.tsx 里，原样挪出来。
 */
export function KeyboardPlaceholder({ viewport, theme }: { viewport: PiStageSize; theme: PiTheme }) {
  const dark = theme === "dark"
  const stage = PI_STAGE[viewport]
  return createPortal(
    <div
      data-pi-keyboard-placeholder=""
      role="note"
      className="flex flex-col items-center justify-center gap-1 border-t border-dashed text-[13px] leading-[18px]"
      style={{
        position: "absolute",
        left: 0,
        top: stage.height - PI_KEYBOARD_H,
        width: stage.width,
        height: PI_KEYBOARD_H,
        boxSizing: "border-box",
        zIndex: 2147483647,
        fontFamily: "var(--cw-font-sans)",
        background: dark ? "#2c2c2e" : "#d1d4da",
        borderColor: dark ? "#5c5c60" : "#9a9ea6",
        color: dark ? "#b4b4b8" : "#45484d",
      }}
    >
      <span className="font-medium">屏幕键盘占位</span>
      <span>高约 {PI_KEYBOARD_H}px（推断/估计）</span>
    </div>,
    document.body,
  )
}
