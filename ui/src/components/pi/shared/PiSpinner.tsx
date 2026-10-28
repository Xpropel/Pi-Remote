import { Spinner, type SpinnerProps } from "@/components/kit"

export interface PiSpinnerProps extends SpinnerProps {
  /**
   * 默认 false：流、终端、tray、按钮里的 spinner 只是状态的样子，不是 live region（design §4.7：流式正文、运行行、
   * 终端输出不设 live region；状态由 PiStatusLine / PiComposerStatusRow 的原因段播报）。渲染成 role="img" + 中文名。
   * true：照 kit 原样 role="status"（这一处就是唯一的播报位置时才用）。
   */
  live?: boolean
}

/**
 * Pi 的 spinner（ui-a11y N4 / N5，P3 由 p3-base 加）：包一层 kit Spinner，默认不进 live region，名称默认中文"正在加载"
 * （kit 默认是英文 "Loading"）。外观、尺寸、动画都和 kit Spinner 一样，reduced-motion 由 pi-theme.css 统一处理。
 */
export function PiSpinner({ live = false, label = "正在加载", ...rest }: PiSpinnerProps) {
  return <Spinner label={label} {...(live ? {} : { role: "img" })} {...rest} />
}
