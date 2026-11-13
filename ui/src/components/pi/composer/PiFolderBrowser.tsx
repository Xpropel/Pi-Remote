import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { MENU_DIVIDER_BORDER, MENU_ROW_HL_HOVER, Switch } from "@/components/kit"
import { ChevronRight, CornerLeftUp, Folder } from "@/components/kit/icons"
import { PiButton, PiDialog, usePiStatic, type PiOverlayControl, type PiReturnFocus } from "@/components/pi/shared"
import { PiDialogStatus } from "./PiDialogParts"
import { cn } from "@/lib/utils"
import {
  DIR_LIST_MAX,
  breadcrumbOf,
  emptyFolderBrowserState,
  folderErrorText,
  middleEllipsis,
  type DirListResult,
  type FolderBrowserState,
} from "@/pi/model/folderBrowser"
import type { PiLayout } from "@/components/pi/shared/viewport"
import { C_SECONDARY, ROW_FOCUS, type CVariant } from "./styles"

export interface PiFolderBrowserProps extends PiOverlayControl {
  viewport: PiLayout
  /** 设备作用域的说法（newSession.deviceScopeLabel，「在这台 Mac 上」）：标题「在这台 Mac 上选择文件夹」 */
  scopeLabel: string
  /** 打开时的起点（当前选中的文件夹）；不在浏览根目录里或为空 = attach 用第一个根目录（默认家目录） */
  initialPath?: string | null
  /** 真实数据：容器注入 relay.listDirs 的绑定版。进入目录 / 切「显示隐藏文件夹」/ 重试时调用；画廊静态态不传 */
  listDirs?: (path?: string, showHidden?: boolean) => Promise<DirListResult>
  /** 画廊 / 截图用：直接画这份快照（没有 listDirs 时只画它） */
  snapshot?: FolderBrowserState | null
  /** 关闭后焦点回哪（默认 = 打开前的焦点元素） */
  returnFocus?: PiReturnFocus
  /** 「在这里新建会话」：选中当前目录 */
  onPick?: (path: string) => void
}

/** list_dirs 失败 → 中文原因（优先用协议错误码的文案表，其次用 relay/attach 带回的话） */
function errorTextOf(error: unknown): string {
  const rec = error && typeof error === "object" ? (error as { code?: unknown; message?: unknown }) : {}
  const code = typeof rec.code === "string" ? rec.code : ""
  const message = typeof rec.message === "string" ? rec.message : ""
  return folderErrorText(code, message)
}

const LIST_ROW = cn(
  "flex w-full min-w-0 items-center gap-2.5 rounded-[var(--cw-menu-item-radius,6px)] px-2 text-left text-(--cw-text) disabled:pointer-events-none disabled:text-(--cw-text-4)",
  MENU_ROW_HL_HOVER,
  ROW_FOCUS,
)
const DESKTOP_ROW = "min-h-8 text-(length:--cw-text-md) leading-(--cw-leading-tight)"
const PHONE_ROW = cn("min-h-[52px] border-b border-solid px-1 text-[15px] leading-[20px] last:border-b-0", MENU_DIVIDER_BORDER)

/**
 * 文件夹浏览器（P9 C，spec §5.5）：桌面是 PiDialog（标题「在这台 Mac 上选择文件夹」），手机是全高 PiSheet。
 * 内容：面包屑（每段可点）→「上一级」→ 子文件夹列表 →「显示隐藏文件夹」开关（kit Switch）；
 * 底部从左到右：当前路径（中间截断）、「取消」、「在这里新建会话」。
 * 四种状态：加载中 / 出错（红字 + 重试）/ 空（这个文件夹里没有子文件夹）/ 截断（只显示前 500 个）。
 * 部件只收 props：真实取数由容器注入 listDirs（relay.listDirs，命令 list_dirs）；画廊传 snapshot 静态画。
 */
export function PiFolderBrowser({
  viewport,
  scopeLabel,
  initialPath,
  listDirs,
  snapshot,
  static: staticProp,
  open,
  onOpenChange,
  returnFocus,
  onPick,
}: PiFolderBrowserProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v: CVariant = phone ? "phone" : "desktop"
  const [state, setState] = useState<FolderBrowserState | null>(() => snapshot ?? (isStatic ? emptyFolderBrowserState() : null))
  const initialRef = useRef(initialPath ?? null)
  const requestRef = useRef(0)
  const startedRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** 这次读目录是谁发起的：读完后焦点落到哪由它决定（见下方 effect）；null = 不接管焦点 */
  const settleRef = useRef<{ from: Element | null } | null>(null)

  const load = useCallback(
    async (target: string | undefined, showHidden: boolean) => {
      if (!listDirs) return
      const seq = ++requestRef.current
      setState((prev) => ({ ...(prev ?? emptyFolderBrowserState()), loading: true, error: null, showHidden }))
      try {
        const result = await listDirs(target, showHidden)
        if (seq !== requestRef.current) return
        setState({
          path: result.path,
          root: result.root,
          parent: result.parent,
          entries: result.entries,
          truncated: result.truncated,
          loading: false,
          error: null,
          showHidden,
        })
      } catch (error) {
        if (seq !== requestRef.current) return
        setState((prev) => ({ ...(prev ?? emptyFolderBrowserState()), loading: false, error: errorTextOf(error), showHidden }))
      }
    },
    [listDirs],
  )

  // 打开时读一次起点目录（静态态 / 画廊不取数）
  useEffect(() => {
    if (startedRef.current || isStatic || !listDirs) return
    startedRef.current = true
    settleRef.current = { from: null }
    void load(initialRef.current ?? undefined, false)
  }, [isStatic, listDirs, load])

  const current = state ?? emptyFolderBrowserState({ loading: !isStatic })

  /*
   * 焦点跟着目录走：打开时列表还没到，焦点先落在列表区（data-pi-autofocus，不落在底部的「显示隐藏文件夹」开关上）；
   * 点中的子文件夹 / 面包屑 / 重试钮在读目录时被卸掉或置灰，焦点掉回弹窗容器或 body。
   * 读完后焦点若还"无处可去"（含仍停在列表区）：回到发起的元素（还在且可用，如「上一级」），否则第一个子文件夹 →「上一级」→ 重试钮。用户读的过程中自己挪了焦点就不动。
   */
  useEffect(() => {
    const settle = settleRef.current
    const root = bodyRef.current
    if (!settle || current.loading || !root) return
    settleRef.current = null
    const active = document.activeElement
    const lost =
      !active ||
      active === document.body ||
      active === settle.from ||
      active === root.closest('[role="dialog"]') ||
      active === listRef.current
    if (!lost) return
    const usable = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.isConnected && root.contains(el) && !el.matches(":disabled")
    const target = [
      settle.from,
      root.querySelector('[role="option"]'),
      root.querySelector('[data-cw-id="pi-folder-browser-up"]'),
      root.querySelector('[data-phase="error"] button'),
    ].find(usable)
    if (target && target !== active) target.focus({ preventScroll: true })
  }, [current.loading])

  const navigate = (path: string) => {
    if (isStatic) return
    settleRef.current = { from: document.activeElement }
    void load(path, current.showHidden)
  }
  const toggleHidden = (next: boolean) => {
    if (isStatic) return
    void load(current.path || initialRef.current || undefined, next)
  }
  const retry = () => {
    if (isStatic) return
    settleRef.current = { from: document.activeElement }
    void load(current.path || initialRef.current || undefined, current.showHidden)
  }
  const pick = () => {
    if (isStatic || !current.path) return
    onPick?.(current.path)
  }
  const crumbs = breadcrumbOf(current.path, current.root)
  const footer: ReactNode = (
    <>
      <span
        data-slot="pi-folder-browser-path"
        title={current.path || undefined}
        className={cn("min-w-0 flex-1 truncate text-(length:--cw-text-sm) leading-(--cw-leading-sm)", C_SECONDARY)}
      >
        {current.path ? middleEllipsis(current.path, phone ? 30 : 52) : "…"}
      </span>
      <PiButton kind="outline" variant={v} onClick={isStatic ? undefined : () => onOpenChange?.(false)}>
        取消
      </PiButton>
      <PiButton variant={v} disabled={!current.path || current.loading} onClick={isStatic ? undefined : pick}>
        在这里新建会话
      </PiButton>
    </>
  )
  return (
    <PiDialog
      title={`${scopeLabel}选择文件夹`}
      viewport={viewport}
      width={560}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      footer={footer}
    >
      <div ref={bodyRef} data-slot="pi-folder-browser" data-state={current.loading ? "loading" : current.error ? "error" : "ready"} className="flex flex-col gap-3 pt-1">
        <div className="flex min-w-0 flex-col gap-1">
          <nav aria-label="目录路径" className="flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1
              return (
                <span key={crumb.path} className="flex shrink-0 items-center">
                  {index > 0 && <ChevronRight aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 text-(--cw-text-4)" />}
                  <button
                    type="button"
                    disabled={isStatic || last}
                    onClick={() => navigate(crumb.path)}
                    className={cn(
                      "max-w-[160px] truncate rounded-[4px] px-1 text-(length:--cw-text-sm) leading-[22px] disabled:pointer-events-none",
                      MENU_ROW_HL_HOVER,
                      ROW_FOCUS,
                      last ? "font-(--cw-weight-medium) text-(--cw-text)" : C_SECONDARY,
                    )}
                  >
                    {crumb.label}
                  </button>
                </span>
              )
            })}
          </nav>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <button
            type="button"
            data-cw-id="pi-folder-browser-up"
            disabled={isStatic || current.loading || !current.parent}
            onClick={() => current.parent && navigate(current.parent)}
            className={cn(LIST_ROW, phone ? PHONE_ROW : DESKTOP_ROW)}
          >
            <CornerLeftUp aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-(--cw-icon-fg)" />
            <span className="min-w-0 flex-1 truncate">上一级</span>
          </button>
          <div
            ref={listRef}
            role="group"
            aria-label="文件夹列表"
            aria-busy={current.loading || undefined}
            tabIndex={isStatic ? undefined : -1}
            data-pi-autofocus={isStatic ? undefined : ""}
            data-slot="pi-folder-browser-list"
            className="flex min-w-0 flex-col gap-1 rounded-[var(--cw-menu-item-radius,6px)] focus-visible:outline-offset-[-2px]!"
          >
            <PiDialogStatus
              variant={v}
              phase={current.loading ? "loading" : current.error ? "error" : "ready"}
              error={current.error}
              onRetry={retry}
            >
              {current.entries.length === 0 ? (
                <p data-slot="pi-folder-browser-empty" className={cn("m-0 flex min-h-11 items-center", phone ? "text-[15px]" : "text-(length:--cw-text-md)", C_SECONDARY)}>
                  这个文件夹里没有子文件夹
                </p>
              ) : (
                <div role="listbox" aria-label="子文件夹" className="flex min-w-0 flex-col">
                  {current.entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => navigate(entry.path)}
                      className={cn(LIST_ROW, phone ? PHONE_ROW : DESKTOP_ROW)}
                    >
                      <Folder aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-(--cw-icon-fg)" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    </button>
                  ))}
                </div>
              )}
              {current.truncated && (
                <p data-slot="pi-folder-browser-truncated" className={cn("m-0 text-(length:--cw-text-sm) leading-(--cw-leading-sm)", C_SECONDARY)}>
                  只显示前 {DIR_LIST_MAX} 个
                </p>
              )}
            </PiDialogStatus>
          </div>
        </div>
        <div className={cn("flex min-h-11 items-center justify-between gap-3 border-t border-solid pt-2", MENU_DIVIDER_BORDER)}>
          <span className={cn("text-(length:--cw-text-sm) leading-(--cw-leading-sm)", C_SECONDARY)}>显示隐藏文件夹</span>
          <Switch checked={current.showHidden} onCheckedChange={isStatic ? undefined : toggleHidden} aria-label="显示隐藏文件夹" />
        </div>
      </div>
    </PiDialog>
  )
}
