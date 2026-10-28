import { Component, type ErrorInfo, type ReactNode } from "react"

/**
 * 捕获单个屏幕的渲染错误（照 replica 的 app/ErrorBoundary.tsx；P4 从 PiStage.tsx 拆出来，#/pi 和 #/play 共用）：
 * 页面其余部分照常，错误写进 window.__PI_GALLERY__.renderErrors 并 console.error，留 [data-render-error] 标记。
 */
export class ErrorBoundary extends Component<{ where: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    window.__PI_GALLERY__?.renderErrors.push({ where: this.props.where, message: `${error.message}\n${info.componentStack ?? ""}` })
    console.error(`[render] ${this.props.where}: ${error.message}`)
  }
  render() {
    if (this.state.error) {
      return (
        <div data-render-error={this.props.where} className="m-2 rounded-md border border-red-300 bg-red-50 p-3 font-mono text-xs text-red-800">
          渲染失败：{this.props.where}
          <br />
          {this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}
