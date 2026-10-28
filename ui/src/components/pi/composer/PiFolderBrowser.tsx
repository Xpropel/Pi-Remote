import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Switch } from "@/components/kit"
import { ChevronRight, Folder, FolderOpen } from "@/components/kit/icons"
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
import { C_SECONDARY, type CVariant } from "./styles"

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

const LIST_ROW = "flex w-full min-w-0 items-center gap-2.5 rounded-[6px] px-2 text-left hover:bg-(--cw-row-hover) disabled:pointer-events-none disabled:text-(--cw-text-4)"
const DESKTOP_ROW = "min-h-8 text-(length:--cw-text-md) leading-(--cw-leading-tight)"
const PHONE_ROW = "min-h-[52px] border-b border-solid border-(--cw-divider-soft) px-1 text-[15px] leading-[20px] last:border-b-0"

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
    void load(initialRef.current ?? undefined, false)
  }, [isStatic, listDirs, load])

  const current = state ?? emptyFolderBrowserState({ loading: !isStatic })
  const navigate = (path: string) => {
    if (isStatic) return
    void load(path, current.showHidden)
  }
  const toggleHidden = (next: boolean) => {
    if (isStatic) return
    void load(current.path || initialRef.current || undefined, next)
  }
  const retry = () => {
    if (isStatic) return
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
      <div data-slot="pi-folder-browser" data-state={current.loading ? "loading" : current.error ? "error" : "ready"} className="flex flex-col gap-3 pt-1">
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
                      "max-w-[160px] truncate rounded-[4px] px-1 text-(length:--cw-text-sm) leading-[22px] hover:bg-(--cw-row-hover) disabled:pointer-events-none",
                      last ? "text-(--cw-text)" : C_SECONDARY,
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
            <FolderOpen aria-hidden strokeWidth={1.5} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">上一级</span>
          </button>
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
        <div className="flex min-h-11 items-center justify-between gap-3 border-t border-solid border-(--cw-divider-soft) pt-2">
          <span className={cn("text-(length:--cw-text-sm) leading-(--cw-leading-sm)", C_SECONDARY)}>显示隐藏文件夹</span>
          <Switch checked={current.showHidden} onCheckedChange={isStatic ? undefined : toggleHidden} aria-label="显示隐藏文件夹" />
        </div>
      </div>
    </PiDialog>
  )
}
