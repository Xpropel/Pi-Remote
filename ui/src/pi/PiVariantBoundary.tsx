/**
 * 变体 chunk 加载失败 / 渲染异常的错误边界（P4 R4，架构层共享基建）。
 *
 * 背景：claude / codex 是 React.lazy 的按需 chunk（vendor 拆分后首屏 8 个请求、变体 chunk 另算）。
 * 慢网 / 弱网 / 断网时 chunk 可能加载失败；没有错误边界时 React 会卸载整棵树 → 白屏，用户没有任何恢复入口。
 *
 * 行为（两套变体共用，不依赖变体样式/组件，避免独立性守卫问题）：
 * - 捕获子树渲染错误，显示友好错误态：标题 + 原因一句话 + 「重新加载」+「回到 Cursor 界面」两个恢复动作；
 * - `role="alert"` + `aria-live="assertive"`，读屏能播报（R4 a11y 要求）；
 * - `data-pi-variant-error="<id>"` 供验证线/截图线定位；错误详情只在 dev console 打，不进用户界面；
 * - 「重新加载」= location.reload()（chunk 失败会被浏览器缓存/React.lazy 记住，原地重试无效）；
 * - 「回到 Cursor 界面」= 改 prefs.ui（cursor 是静态入口，chunk 已随首屏加载，必定可恢复）。
 * 边界只包变体展示树；relay / room / 草稿状态在 PiApp 的 useRelay 里，切回 cursor 不丢连接、不重连。
 */
import { Component, type ErrorInfo, type ReactNode } from "react"
import { variantFallbackTheme } from "./variants/fallback"
import { PI_UI_VARIANT_META, type PiUiVariant } from "./variants/types"

export interface PiVariantBoundaryProps {
  variant: PiUiVariant
  children: ReactNode
  /** 「回到 Cursor 界面」：由 PiApp 传 act.setUiVariant("cursor")；不传则只显示「重新加载」 */
  onFallback?: () => void
}

interface PiVariantBoundaryState {
  failed: boolean
  message: string
  /** 这一份 failed 属于哪个变体：换皮肤（variant 变化）时复位，否则错误态会一直盖住新界面 */
  variant: PiUiVariant
}

export class PiVariantBoundary extends Component<PiVariantBoundaryProps, PiVariantBoundaryState> {
  state: PiVariantBoundaryState = { failed: false, message: "", variant: this.props.variant }

  static getDerivedStateFromError(error: unknown): Pick<PiVariantBoundaryState, "failed" | "message"> {
    return { failed: true, message: error instanceof Error ? error.message : String(error) }
  }

  /**
   * 皮肤切换（prefs.ui 变化）后自动复位：错误边界原先只在点「回到 Cursor 界面」时清 failed，
   * 从设置页 / 另一个标签页换到别的变体时仍停在旧错误屏（潜伏）。变体一变就重新挂载子树重试。
   */
  static getDerivedStateFromProps(props: PiVariantBoundaryProps, state: PiVariantBoundaryState): Partial<PiVariantBoundaryState> | null {
    if (props.variant === state.variant) return null
    return { failed: false, message: "", variant: props.variant }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // dev 才打详情；生产不把堆栈/错误信息展示给用户
    if (import.meta.env?.DEV) console.error("[pi] variant failed:", this.props.variant, error, info.componentStack)
  }

  private reload = (): void => {
    window.location.reload()
  }

  private fallback = (): void => {
    this.props.onFallback?.()
    this.setState({ failed: false, message: "" })
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const label = PI_UI_VARIANT_META[this.props.variant]?.label ?? this.props.variant
    // 错误屏同样不在 PiRoot 里：旧根卸载时 <html data-pi-theme> 已被清掉，必须自带
    // data-pi-root + data-pi-theme 才能拿到共享深色 token（否则深色模式整屏刷白）。
    const theme = variantFallbackTheme()
    return (
      <div
        role="alert"
        aria-live="assertive"
        data-pi-variant-error={this.props.variant}
        data-pi-root=""
        data-pi-theme={theme}
        className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-(--cw-bg) p-6 text-center text-(--cw-text)"
        style={{ colorScheme: theme }}
      >
        <h1 className="text-lg font-semibold">界面加载失败</h1>
        <p className="max-w-md text-sm text-(--cw-text-2)">
          「{label}」界面没有加载完成，可能是网络中断或版本已更新。检查网络后重试；也可以先回到 Cursor 界面继续使用。
        </p>
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
          {this.props.onFallback ? (
            <button type="button" onClick={this.fallback} className="rounded-md border px-4 py-2 text-sm">
              回到 Cursor 界面
            </button>
          ) : null}
        </div>
        {import.meta.env?.DEV ? <p className="max-w-md text-xs text-(--cw-text-3)">{this.state.message}</p> : null}
      </div>
    )
  }
}
