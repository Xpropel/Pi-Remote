import { useRef, useState, type ComponentProps, type ReactNode } from "react"
import { MenuItem, MenuLabel, MenuSearch, MenuSeparator, MenuSurface, Submenu } from "@/components/kit"
import { Check, ChevronLeft, ChevronRight, Folder, FolderOpen, Search } from "@/components/kit/icons"
import { PiPlatformIcon } from "@/components/pi/shared"
import { usePiMenuSurface, usePiStatic } from "@/components/pi/shared/layers"
import { cn } from "@/lib/utils"
import { filterFolders } from "@/pi/model/folderBrowser"
import { homeShort } from "@/pi/model/newSession"
import { usePiMenuClose } from "./menuClose"
import { C_SECONDARY, type CVariant } from "./styles"

export interface PiFolderPickerProps extends Omit<ComponentProps<"div">, "children" | "onSelect"> {
  variant: CVariant
  /** 工作区那一行的说法：「在这台 Mac 上」/「在 MacBook Pro 上」（newSession.deviceScopeLabel） */
  scopeLabel: string
  /** 设备平台（darwin / macos / win32 / windows / linux…）：工作区行的平台图标 + 二级搜索框文案 */
  platform: string
  /** 这台设备最近用过的文件夹（完整路径，按会话 updatedAt） */
  recent: string[]
  /** 二级菜单的文件夹列表：白名单目录 + 最近用过的，去重（folderBrowser.knownFoldersOf） */
  knownFolders: string[]
  /** 能不能打开文件夹浏览器（设备在线、attach 支持 fs.browse、浏览根目录非空） */
  canBrowse: boolean
  /** canBrowse=false 时「打开文件夹…」置灰的原因（spec §5.1-6 的三种文案） */
  browseReason?: string | null
  /** 显示用：把浏览根目录前缀写成 `~/`（设备的 Device.browseRoots）；不给就显示完整路径 */
  homeRoots?: string[]
  /** 当前选中的文件夹（完整路径）；「最近」组里打勾 */
  value?: string
  /** true = 静态态；不传时取 PiStaticContext */
  static?: boolean
  /** 选中一个文件夹（完整路径）。桌面菜单自己关；手机 sheet 由宿主关（PiMenuCloseContext） */
  onSelect?: (path: string) => void
  /** 「打开文件夹…」：宿主打开 PiFolderBrowser */
  onBrowse?: () => void
  /** 两个搜索框的输入变化都上报（本地过滤不受它影响；留作宿主埋点 / 断言用） */
  onSearch?: (query: string) => void
  /** 静态态：桌面二级菜单默认展开 / 手机默认停在这一页（画廊截图用） */
  initialPage?: "root" | "folders"
}

/** 平台名的中文写法（二级搜索框文案「搜索这台 Mac…」；认不出来就写「这台设备」） */
function platformScopeName(platform: string): string {
  const key = (platform || "").trim().toLowerCase()
  if (key === "macos" || key === "darwin" || key === "mac") return "Mac"
  if (key === "windows" || key === "win32" || key === "win") return "Windows"
  if (key === "linux") return "Linux"
  return "设备"
}

const PHONE_ROW = "flex min-h-[52px] w-full items-center gap-3 border-b border-solid border-(--cw-divider-soft) px-1 text-left last:border-b-0"
const GROUP_LABEL = "pt-1 pb-1 text-[13px] leading-[18px]"
const EMPTY_NOTE = "px-2 py-1.5 text-(length:--cw-text-sm) leading-(--cw-leading-sm)"

/**
 * 文件夹选择（P9 C，spec §5.1-2 / §5.5）：先选设备，再只列这台设备的文件夹——两个层级、不混设备。
 * 顶层 = 搜索框「搜索文件夹…」→「最近」（这台设备最近用过的目录，`~/` 开头，当前项打勾）→ 分隔线 →
 * 「工作区」组一行（平台图标 + scopeLabel，接二级菜单）。
 * 二级 = 搜索框「搜索这台 Mac…」→ 文件夹列表（白名单 + 最近，去重）→ 分隔线 →「打开文件夹…」
 * （FolderOpen；canBrowse=false 时置灰并在行下写原因）。
 * compose from kit: MenuSurface / MenuSearch / MenuLabel / MenuItem / MenuSeparator / Submenu，参照 replica 的 kit RepoPicker（图 18）。
 * 桌面是可交互菜单 / 静态帧（画廊）两种形态；手机在 PiSheet 里一页一页往下走，二级页顶部有返回箭头，行高 52。
 */
export function PiFolderPicker(props: PiFolderPickerProps) {
  const {
    variant,
    scopeLabel,
    platform,
    recent,
    knownFolders,
    canBrowse,
    browseReason,
    homeRoots,
    value,
    static: staticProp,
    onSelect,
    onBrowse,
    onSearch,
    initialPage,
    className,
    ...rest
  } = props
  const isStatic = usePiStatic(staticProp)
  // 桌面菜单的行为层（static / Radix dropdown）；手机 sheet 里不用，但 hook 要在所有 return 之前调
  const menuSurface = usePiMenuSurface()
  const close = usePiMenuClose()
  const scopeName = platformScopeName(platform)
  const searchPlaceholder = `搜索这台 ${scopeName}…`
  const [query, setQuery] = useState("")
  const [subQuery, setSubQuery] = useState("")
  const [page, setPage] = useState<"root" | "folders">(initialPage === "folders" ? "folders" : "root")
  const searchRef = useRef<HTMLInputElement>(null)
  const display = (path: string) => homeShort(path, homeRoots)
  const pick = (path: string) => {
    onSelect?.(path)
    close?.()
  }
  const browse = () => {
    onBrowse?.()
    close?.()
  }
  const changeQuery = (next: string) => {
    setQuery(next)
    onSearch?.(next)
  }
  const changeSubQuery = (next: string) => {
    setSubQuery(next)
    onSearch?.(next)
  }
  const recentShown = filterFolders(query, recent)
  const knownShown = filterFolders(subQuery, knownFolders)
  const emptyRecent = query.trim() ? "没有匹配的文件夹" : "这台设备上还没有用过文件夹"
  const emptyKnown = subQuery.trim() ? "没有匹配的文件夹" : "这台设备上没有已知的文件夹"

  /**
   * 桌面：MenuSurface（静态 div / Radix 下拉由所在 MenuSurface 决定）+ 从「工作区」行接出的 Submenu。
   * 有搜索框的锚定菜单打开时焦点进搜索框（design §4.7 焦点表），静态态不抢焦点。
   */
  const focusSearch = (event: Event) => {
    event.preventDefault()
    searchRef.current?.focus({ preventScroll: true })
  }

  if (variant === "desktop") {
    return (
      <MenuSurface
        {...menuSurface}
        onOpenAutoFocus={isStatic ? undefined : focusSearch}
        data-slot="pi-folder-picker"
        data-cw-id="pi-folder-picker"
        aria-label="选择文件夹"
        className={cn("w-[300px]", className)}
        {...rest}
      >
        <MenuSearch
          ref={searchRef}
          placeholder="搜索文件夹…"
          aria-label="搜索文件夹"
          value={query}
          onValueChange={changeQuery}
        />
        <MenuLabel className={C_SECONDARY}>最近</MenuLabel>
        {recentShown.length === 0 ? (
          <div data-slot="pi-folder-empty" className={cn(EMPTY_NOTE, C_SECONDARY)}>
            {emptyRecent}
          </div>
        ) : (
          recentShown.map((path, index) => (
            <MenuItem
              key={path}
              data-cw-id={`pi-folder-recent-${index}`}
              icon={<Folder />}
              checked={path === value}
              textValue={path}
              onSelect={() => pick(path)}
            >
              {display(path)}
            </MenuItem>
          ))
        )}
        <MenuSeparator />
        <MenuLabel className={C_SECONDARY}>工作区</MenuLabel>
        <Submenu
          data-cw-id="pi-folder-workspace"
          icon={<PiPlatformIcon platform={platform} size={16} className="text-(--cw-icon-fg)" />}
          label={scopeLabel}
          open={isStatic && initialPage === "folders" ? true : undefined}
          sideOffset={5.5}
          alignOffset={-2.5}
          contentProps={{ elevation: "popover", className: "w-[300px]" }}
        >
          <MenuSearch
            placeholder={searchPlaceholder}
            aria-label={`搜索这台 ${scopeName}`}
            value={subQuery}
            onValueChange={changeSubQuery}
          />
          {knownShown.length === 0 ? (
            <div data-slot="pi-folder-empty" className={cn(EMPTY_NOTE, C_SECONDARY)}>
              {emptyKnown}
            </div>
          ) : (
            knownShown.map((path, index) => (
              <MenuItem
                key={path}
                data-cw-id={`pi-folder-known-${index}`}
                icon={<Folder />}
                checked={path === value}
                textValue={path}
                onSelect={() => pick(path)}
              >
                {display(path)}
              </MenuItem>
            ))
          )}
          <MenuSeparator />
          <MenuItem data-cw-id="pi-folder-browse" icon={<FolderOpen />} disabled={!canBrowse} onSelect={browse}>
            打开文件夹…
          </MenuItem>
          {!canBrowse && browseReason ? <BrowseReason>{browseReason}</BrowseReason> : null}
        </Submenu>
      </MenuSurface>
    )
  }

  // 手机：sheet 里两页（最近 / 工作区），二级页顶部返回箭头；行高 52（spec §5.1-7）
  const phoneRows = page === "root" ? recentShown : knownShown
  return (
    <div
      data-slot="pi-folder-picker"
      data-cw-id="pi-folder-picker"
      data-page={page}
      className={cn("flex flex-col", className)}
      {...rest}
    >
      {page === "folders" && (
        <button
          type="button"
          data-cw-id="pi-folder-back"
          onClick={isStatic ? undefined : () => setPage("root")}
          className={cn(PHONE_ROW, "mb-1 gap-2")}
        >
          <ChevronLeft aria-hidden strokeWidth={1.5} className="size-5 shrink-0 text-(--cw-icon-fg)" />
          <span className="min-w-0 flex-1 truncate text-[15px] leading-[20px] text-(--cw-text)">{scopeLabel}</span>
        </button>
      )}
      <PhoneSearch
        placeholder={page === "root" ? "搜索文件夹…" : searchPlaceholder}
        ariaLabel={page === "root" ? "搜索文件夹" : `搜索这台${scopeName}`}
        isStatic={isStatic}
        value={page === "root" ? query : subQuery}
        onValueChange={page === "root" ? changeQuery : changeSubQuery}
      />
      {page === "root" && <div className={cn(GROUP_LABEL, C_SECONDARY)}>最近</div>}
      <div role="menu" aria-label="文件夹" className="flex flex-col">
        {phoneRows.length === 0 ? (
          <div data-slot="pi-folder-empty" className={cn(EMPTY_NOTE, C_SECONDARY)}>
            {page === "root" ? emptyRecent : emptyKnown}
          </div>
        ) : (
          phoneRows.map((path, index) => (
            <button
              key={path}
              type="button"
              data-cw-id={page === "root" ? `pi-folder-recent-${index}` : `pi-folder-known-${index}`}
              aria-checked={path === value}
              role="menuitemradio"
              onClick={() => pick(path)}
              className={PHONE_ROW}
            >
              <Folder aria-hidden strokeWidth={1.5} className="size-5 shrink-0 text-(--cw-icon-fg)" />
              <span className="min-w-0 flex-1 truncate text-[15px] leading-[20px] text-(--cw-text)">{display(path)}</span>
              {path === value && <Check aria-hidden strokeWidth={1.75} className="size-5 shrink-0 text-(--cw-icon-fg)" />}
            </button>
          ))
        )}
        {page === "root" ? (
          <>
            <div aria-hidden className="my-2 h-px shrink-0 bg-(--cw-divider-soft)" />
            <div className={cn(GROUP_LABEL, C_SECONDARY)}>工作区</div>
            <button
              type="button"
              data-cw-id="pi-folder-workspace"
              onClick={isStatic ? undefined : () => setPage("folders")}
              className={PHONE_ROW}
            >
              <PiPlatformIcon platform={platform} size={20} />
              <span className="min-w-0 flex-1 truncate text-[15px] leading-[20px] text-(--cw-text)">{scopeLabel}</span>
              <ChevronRight aria-hidden strokeWidth={1.5} className="size-5 shrink-0 text-(--cw-icon-fg)" />
            </button>
          </>
        ) : (
          <>
            <div aria-hidden className="my-2 h-px shrink-0 bg-(--cw-divider-soft)" />
            <button
              type="button"
              data-cw-id="pi-folder-browse"
              disabled={!canBrowse}
              onClick={isStatic ? undefined : browse}
              className={cn(PHONE_ROW, "disabled:text-(--cw-text-4)")}
            >
              <FolderOpen aria-hidden strokeWidth={1.5} className="size-5 shrink-0" />
              <span className={cn("min-w-0 flex-1 truncate text-[15px] leading-[20px]", canBrowse ? "text-(--cw-text)" : "text-(--cw-text-4)")}>打开文件夹…</span>
            </button>
            {!canBrowse && browseReason ? <BrowseReason>{browseReason}</BrowseReason> : null}
          </>
        )}
      </div>
    </div>
  )
}

/** canBrowse=false 的原因：写在「打开文件夹…」行下面（灰字、可换行） */
function BrowseReason({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="pi-folder-browse-reason"
      role="note"
      className={cn("px-2 pt-1 pb-1.5 text-(length:--cw-text-xs) leading-[16px]", C_SECONDARY)}
    >
      {children}
    </div>
  )
}

interface PhoneSearchProps {
  placeholder: string
  ariaLabel: string
  isStatic: boolean
  value: string
  onValueChange: (value: string) => void
}

/** 手机 sheet 顶部的搜索行（交互 = 16px 真输入框，防 iOS 聚焦放大；静态 = 同一版式的占位行） */
function PhoneSearch({ placeholder, ariaLabel, isStatic, value, onValueChange }: PhoneSearchProps) {
  if (isStatic) {
    return (
      <div className="mb-3 flex h-11 items-center gap-2 rounded-[10px] bg-(--cw-chip-bg) px-3 text-[16px] text-(--cw-text-4)">
        <Search aria-hidden strokeWidth={1.5} className="size-[18px] shrink-0" />
        {placeholder}
      </div>
    )
  }
  return (
    <label className="mb-3 flex h-11 items-center gap-2 rounded-[10px] bg-(--cw-chip-bg) px-3 focus-within:[box-shadow:inset_0_0_0_1px_var(--cw-pi-field-focus-border)]">
      <Search aria-hidden strokeWidth={1.5} className="size-[18px] shrink-0 text-(--cw-text-4)" />
      <input
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        className="min-w-0 flex-1 self-stretch border-0 bg-transparent p-0 text-[16px] text-(--cw-text) outline-none placeholder:text-(--cw-text-4)"
      />
    </label>
  )
}
