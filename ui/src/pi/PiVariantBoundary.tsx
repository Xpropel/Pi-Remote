/**
 * 界面树渲染异常的错误边界：没有它时 React 会卸载整棵树 → 白屏，用户没有任何恢复入口。
 *
 * - 捕获子树渲染错误，显示友好错误态：标题 + 原因一句话 + 「重新加载」；
 * - `role="alert"` + `aria-live="assertive"`，读屏能播报；
 * - `data-pi-variant-error` 供验证线 / 截图线定位；错误详情只在 dev console 打，不进用户界面。
 * 边界只包展示树；relay / room 状态在 PiApp 的 useRelay 里。
 */
import { Component, type ErrorInfo, type ReactNode } from "react"
import { variantFallbackTheme } from "./variants/fallback"

export interface PiVariantBoundaryProps {
  children: ReactNode
}

interface PiVariantBoundaryState {
  failed: boolean
  message: string
}

export class PiVariantBoundary extends Component<PiVariantBoundaryProps, PiVariantBoundaryState> {
  state: PiVariantBoundaryState = { failed: false, message: "" }

  static getDerivedStateFromError(error: unknown): PiVariantBoundaryState {
    return { failed: true, message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // dev 才打详情；生产不把堆栈/错误信息展示给用户
    if (import.meta.env?.DEV) console.error("[pi] app tree failed:", error, info.componentStack)
  }

  private reload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    // 错误屏不在 PiRoot 里：旧根卸载时 <html data-pi-theme> 已被清掉，必须自带
    // data-pi-root + data-pi-theme 才能拿到共享深色 token（否则深色模式整屏刷白）。
    const theme = variantFallbackTheme()
    return (
      <div
        role="alert"
        aria-live="assertive"
        data-pi-variant-error=""
        data-pi-root=""
        data-pi-theme={theme}
        className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-(--cw-bg) p-6 text-center text-(--cw-text)"
        style={{ colorScheme: theme }}
      >
        <h1 className="text-lg font-semibold">界面出错了</h1>
        <p className="max-w-md text-sm text-(--cw-text-2)">界面渲染时出了问题，可能是版本刚更新。重新加载页面通常就能恢复。</p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            autoFocus
            onClick={this.reload}
            className="rounded-md px-4 py-2 text-sm font-medium"
            style={{ background: "var(--cw-blue)", color: "var(--cw-bg)" }}
          >
            重新加载
          </button>
        </div>
        {import.meta.env?.DEV ? <p className="max-w-md text-xs text-(--cw-text-3)">{this.state.message}</p> : null}
      </div>
    )
  }
}
