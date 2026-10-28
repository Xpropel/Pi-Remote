import { useId, type ComponentProps, type KeyboardEvent, type ReactNode } from "react"
import { DropdownMenu } from "radix-ui"
import { FileTypeIcon, MenuLabel, MenuSeparator, MenuSurface, type FileKind } from "@/components/kit"
import { ChartColumn, FileText, Image as ImageIcon, SquareSlash } from "@/components/kit/icons"
import { usePiMenuSurface } from "@/components/pi/shared/layers"
import { cn } from "@/lib/utils"
import { filterMentions, mentionDir, mentionLabel } from "./options"
import type { SlashGroup } from "./types"
import { C_SECONDARY, menuRowH, rowText, type CVariant } from "./styles"
import { mentionRowId, slashRowId, type ComposerAssist } from "./useComposerAssist"

/* ------------------------------------------------------------------ 基座 */

export interface PiComposerMenuProps extends ComponentProps<"div"> {
  variant: CVariant
  /** 菜单头一行灰字（@ 菜单的说明） */
  header?: ReactNode
  /** 脚注一行灰字 */
  footer?: ReactNode
  /** 列表区最高（CSS px）：桌面 360，手机键盘开着时按可视视口限 ≈ 300 */
  maxHeight?: number
}

/**
 * composer 上沿的浮动菜单（/、@、+ 共用的基座）：kit MenuSurface 白卡 + 分组小标题 + 行。
 * 宽度由外层给（/ 和 @ = composer 宽；+ = 280）。列表区超出 maxHeight 时在卡内滚动。
 * P4：放在 PiMenu 里（+ 菜单）时 MenuSurface 就是 Radix 下拉菜单的内容（usePiMenuSurface），其余（/、@、静态态）是 static。
 * compose from kit: MenuSurface, MenuLabel, MenuSeparator；行是自己排的两段文字（命令名黑 + 说明灰）。
 */
export function PiComposerMenu({ variant, header, footer, maxHeight, className, children, ...rest }: PiComposerMenuProps) {
  const phone = variant === "phone"
  const surface = usePiMenuSurface()
  // role=listbox（/、@ 菜单，R2-C-m2）：listbox 里只放 group / option，头尾灰字改作 aria-describedby 的说明
  const listbox = rest.role === "listbox"
  const base = useId()
  const headerId = `${base}-header`
  const footerId = `${base}-footer`
  const describedBy = listbox ? [header != null && headerId, footer != null && footerId].filter(Boolean).join(" ") || undefined : undefined
  return (
    <MenuSurface
      {...surface}
      data-slot="pi-composer-menu"
      elevation="menu"
      className={cn("w-full overflow-hidden p-0", phone && "rounded-[12px]", className)}
      aria-describedby={describedBy}
      {...rest}
    >
      {header != null && (
        <div
          id={headerId}
          aria-hidden={listbox || undefined}
          data-slot="pi-composer-menu-header"
          className={cn(
            "flex shrink-0 items-center border-b border-solid border-(--cw-divider-soft) px-3",
            phone ? "h-10 text-[13px]" : "h-8 text-(length:--cw-text-sm)",
            C_SECONDARY,
          )}
        >
          {header}
        </div>
      )}
      <div
        data-slot="pi-composer-menu-list"
        className="flex min-h-0 flex-col overflow-y-auto p-1 [scrollbar-width:none]"
        style={maxHeight ? { maxHeight } : undefined}
      >
        {children}
      </div>
      {footer != null && (
        <div
          id={footerId}
          aria-hidden={listbox || undefined}
          data-slot="pi-composer-menu-footer"
          className={cn(
            "flex shrink-0 items-center border-t border-solid border-(--cw-divider-soft) px-3",
            phone ? "min-h-10 py-2 text-[13px]" : "min-h-8 py-1.5 text-(length:--cw-text-sm)",
            C_SECONDARY,
          )}
        >
          {footer}
        </div>
      )}
    </MenuSurface>
  )
}

export interface PiMenuRowProps extends Omit<ComponentProps<"div">, "children"> {
  variant: CVariant
  icon?: ReactNode
  name: ReactNode
  desc?: ReactNode
  /** desc 放第二行（+ 菜单、手机目录行） */
  twoLine?: boolean
  trailing?: ReactNode
  highlighted?: boolean
  disabled?: boolean
  /** 主文字等宽（命令名不用等宽；路径用） */
  mono?: boolean
}

/**
 * 菜单行：图标 + 主文字（黑）+ 说明（灰，同行或第二行）+ 行尾。桌面行高 32、手机 48。
 * P4：作为 Radix Item 的子元素（asChild）时 Radix 写 data-highlighted（键盘 / 指针选中），同一个底色。
 */
export function PiMenuRow({ variant, icon, name, desc, twoLine, trailing, highlighted, disabled, mono, className, ...rest }: PiMenuRowProps) {
  const t = rowText(variant)
  const phone = variant === "phone"
  return (
    <div
      role="menuitem"
      aria-disabled={disabled || undefined}
      data-highlighted={highlighted ? "" : undefined}
      className={cn(
        "flex w-full min-w-0 shrink-0 cursor-default items-center gap-2.5 rounded-[var(--cw-menu-item-radius,6px)] select-none",
        phone ? "px-3" : "px-2",
        menuRowH(variant),
        twoLine && (phone ? "min-h-[52px] py-1.5" : "min-h-11 py-1"),
        highlighted ? "bg-(--cw-row-hover)" : "hover:bg-(--cw-row-hover) data-[highlighted]:bg-(--cw-row-hover)",
        disabled && "text-(--cw-text-4)",
        className,
      )}
      {...rest}
    >
      {icon != null && (
        <span
          className={cn(
            "flex shrink-0 items-center justify-center text-(--cw-icon-fg) [&>svg]:stroke-[1.5]",
            phone ? "size-5 [&>svg]:size-[18px]" : "size-4 [&>svg]:size-(--cw-icon-size)",
            twoLine && "self-start mt-0.5",
          )}
        >
          {icon}
        </span>
      )}
      <span className={cn("flex min-w-0 flex-1", twoLine ? "flex-col" : "items-baseline gap-2.5")}>
        <span
          className={cn(
            "min-w-0 shrink-0 truncate",
            t.main,
            disabled ? "text-(--cw-text-4)" : "text-(--cw-text)",
            mono && "font-(family-name:--cw-font-mono)",
          )}
        >
          {name}
        </span>
        {desc != null && <span className={cn("min-w-0 truncate", t.sub, C_SECONDARY)}>{desc}</span>}
      </span>
      {trailing != null && <span className={cn("ml-auto flex shrink-0 items-center gap-1.5 pl-2", t.sub, C_SECONDARY)}>{trailing}</span>}
    </div>
  )
}

function GroupTitle({ variant, children }: { variant: CVariant; children: ReactNode }) {
  return (
    // 组名要读（§4.6，R2-C-m1）：菜单底 --cw-surface 上 secondary 浅 / 深都 ≥ 4.5。组名由 role=group 的 aria-label 读出，这里对读屏隐藏
    <MenuLabel aria-hidden className={cn(C_SECONDARY, variant === "phone" ? "h-8 px-3 text-[13px]" : "h-7 px-2")}>
      {children}
    </MenuLabel>
  )
}

/** 可交互的 listbox 行（/、@ 菜单）：指针移过 = 选中行跟着走；按下不抢输入框的焦点；点 = 选中 */
interface ListboxRowHandlers {
  /** 可交互：选中行（扁平下标）。不给 = 静态态（选中行是第一行 / activeKey） */
  activeIndex?: number
  onActiveChange?: (index: number) => void
  onPick?: (index: number) => void
  /**
   * aria-activedescendant 写在哪：self（默认，静态态）= listbox 自己；input = 宿主输入框
   * （可交互时焦点留在输入框，design §4.7 焦点表"斜杠 / @ 菜单"），listbox 不再写也不可聚焦
   */
  activeHost?: "self" | "input"
  /** 行 id 的前缀（输入框的 aria-activedescendant 要指向行 id 时由宿主给；不给时用自己的 useId） */
  listId?: string
}

function rowHandlers(h: ListboxRowHandlers, index: number) {
  if (h.activeIndex === undefined) return {}
  return {
    onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
    onPointerMove: () => {
      if (h.activeIndex !== index) h.onActiveChange?.(index)
    },
    onClick: () => h.onPick?.(index),
  }
}

/* ------------------------------------------------------------- 斜杠命令 */

export interface PiSlashMenuProps extends Omit<PiComposerMenuProps, "children">, ListboxRowHandlers {
  /** 空查询浏览分组（常用 / 内置 / 本机资源；产品里由 slashParse.ts groupSlashBrowse 给）；组名为空串 = 平铺（前缀过滤的结果） */
  groups: SlashGroup[]
  /** 选中行的 key（默认第一行；静态态用） */
  activeKey?: string
}

/**
 * 斜杠命令菜单（E09）：空查询分组浏览 常用 / 内置 / 本机资源，第一行选中；有查询时平铺（不分组），没有匹配写"没有这个命令"。
 * 分组与排序照 ui/src/chat/slashParse.ts groupSlashBrowse（常用按 slashUsage 计数取行）。
 */
export function PiSlashMenu({ variant, groups, activeKey, activeIndex, onActiveChange, onPick, activeHost = "self", listId, ...rest }: PiSlashMenuProps) {
  const handlers: ListboxRowHandlers = { activeIndex, onActiveChange, onPick }
  const flat = groups.flatMap((g) => g.rows)
  const first = activeIndex !== undefined ? flat[activeIndex]?.key : (activeKey ?? groups[0]?.rows[0]?.key)
  // §4.7：↑↓ 选中行用 aria-activedescendant 标出（静态态写在菜单上；可交互时写在输入框上，见 activeHost）
  const auto = useId()
  const base = listId ?? auto
  const rowId = (key: string) => slashRowId(base, key)
  const self = activeHost === "self"
  let index = 0
  const row = (r: SlashGroup["rows"][number]) => {
    const i = index++
    return (
      <PiMenuRow
        key={r.key}
        id={rowId(r.key)}
        role="option"
        aria-selected={r.key === first}
        variant={variant}
        name={r.name}
        desc={r.desc}
        highlighted={r.key === first}
        {...rowHandlers(handlers, i)}
      />
    )
  }
  return (
    <PiComposerMenu
      variant={variant}
      id={listId}
      data-cw-id="pi-slash-menu"
      role="listbox"
      aria-label="斜杠命令"
      aria-activedescendant={self && first ? rowId(first) : undefined}
      tabIndex={self ? -1 : undefined}
      {...rest}
    >
      {flat.length === 0 ? (
        <div role="option" aria-selected={false} aria-disabled className={cn("px-3 py-2", rowText(variant).sub, C_SECONDARY)}>
          没有这个命令
        </div>
      ) : groups.length === 1 && groups[0]!.title === "" ? (
        // 前缀过滤的结果：平铺，不画组名
        flat.map(row)
      ) : (
        groups.map((g, gi) => (
          <div key={g.title} role="group" aria-label={g.title} className={cn("flex flex-col", gi > 0 && "mt-1")}>
            <GroupTitle variant={variant}>{g.title}</GroupTitle>
            {g.rows.map(row)}
          </div>
        ))
      )}
    </PiComposerMenu>
  )
}

/* ------------------------------------------------------------------- @ 引用 */

function fileKindOf(path: string): FileKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  if (ext === "ts" || ext === "mts") return "ts"
  if (ext === "tsx") return "tsx"
  if (ext === "json") return "json"
  if (ext === "html") return "html"
  if (ext === "md" || ext === "txt") return "txt"
  return "file"
}

/** 文件名里命中查询的那段加粗（不区分大小写） */
function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <b className="font-(--cw-weight-semibold)">{text.slice(i, i + query.length)}</b>
      {text.slice(i + query.length)}
    </>
  )
}

export interface PiMentionMenuProps extends Omit<PiComposerMenuProps, "children">, ListboxRowHandlers {
  pool: readonly string[]
  query: string
  /** 已选的引用（不再出现在候选里） */
  selected?: readonly string[]
}

/** @ 引用菜单（E08）：候选 = 本会话出现过的文件；排序 文件名开头 > 包含 > 路径包含（ui/src/chat/composer/mention.ts） */
export function PiMentionMenu({ variant, pool, query, selected = [], activeIndex, onActiveChange, onPick, activeHost = "self", listId, ...rest }: PiMentionMenuProps) {
  const handlers: ListboxRowHandlers = { activeIndex, onActiveChange, onPick }
  const rows = filterMentions(pool, query, selected)
  const active = activeIndex ?? 0
  const auto = useId()
  const base = listId ?? auto
  const rowId = (i: number) => mentionRowId(base, i)
  const self = activeHost === "self"
  return (
    <PiComposerMenu
      variant={variant}
      id={listId}
      data-cw-id="pi-mention-menu"
      role="listbox"
      aria-label="引用文件"
      aria-activedescendant={self && rows.length > 0 ? rowId(active) : undefined}
      tabIndex={self ? -1 : undefined}
      header="发送时附上路径，模型按路径读取，不是上传"
      {...rest}
    >
      {rows.length === 0 ? (
        <div role="option" aria-selected={false} aria-disabled className={cn("px-3 py-2", rowText(variant).sub, C_SECONDARY)}>
          这个会话里还没出现过匹配的文件
        </div>
      ) : (
        rows.map((path, i) => (
          <PiMenuRow
            key={path}
            id={rowId(i)}
            role="option"
            aria-selected={i === active}
            variant={variant}
            icon={<FileTypeIcon kind={fileKindOf(path)} className={variant === "phone" ? "size-[18px]" : undefined} />}
            name={<Highlight text={mentionLabel(path)} query={query} />}
            desc={mentionDir(path)}
            highlighted={i === active}
            {...rowHandlers(handlers, i)}
          />
        ))
      )}
    </PiComposerMenu>
  )
}

/**
 * 可交互 composer 的斜杠 / @ 菜单（P4）：按 useComposerAssist 的状态画 PiSlashMenu / PiMentionMenu，
 * 行 id 用宿主给的 listId（输入框的 aria-activedescendant 指向它们）。关着时什么都不画。
 */
export function PiComposerAssistMenu({
  assist,
  variant,
  pool,
  selected,
  maxHeight,
}: {
  assist: ComposerAssist
  variant: CVariant
  pool?: readonly string[]
  selected?: readonly string[]
  maxHeight?: number
}) {
  if (!assist.open || !assist.trigger) return null
  const common = {
    variant,
    listId: assist.listId,
    activeHost: "input" as const,
    activeIndex: Math.max(0, assist.activeIndex),
    onActiveChange: assist.setActiveIndex,
    onPick: assist.select,
    maxHeight,
  }
  if (assist.trigger.kind === "slash") return <PiSlashMenu {...common} groups={assist.groups} />
  return <PiMentionMenu {...common} pool={pool ?? []} query={assist.trigger.query} selected={selected} />
}

/* ---------------------------------------------------------------- + 菜单 */

export type PiAttachPick = "image" | "text" | "commands" | "usage"

export interface PiAttachMenuProps extends Omit<PiComposerMenuProps, "children"> {
  /** 未载入会话："命令…"禁用 */
  commandsDisabled?: boolean
  /** 作为 sheet 内容时不画卡（PiSheet 自己是卡） */
  bare?: boolean
  /** P4 可交互：选中一项（放在 PiMenu 里时 Radix 选中后自己关菜单；sheet 里由调用方关 sheet） */
  onPick?: (key: PiAttachPick) => void
}

const ATTACH_ROWS = [
  { key: "image", icon: <ImageIcon />, name: "图片…", desc: "png / jpeg / gif / webp，最多 5 张" },
  { key: "text", icon: <FileText />, name: "文本文件…", desc: "64 KB 以内的 UTF-8 文本，插进输入框" },
] as const

/** "+" 菜单（E05 E06 E07）：图片… / 文本文件… —— 命令… / 用量与费用 —— 脚注 */
export function PiAttachMenu({ variant, commandsDisabled, bare, onPick, className, ...rest }: PiAttachMenuProps) {
  // + 菜单是锚定菜单（design §4.7）：打开时焦点进第一个可用项，↑↓ 让焦点在 menuitem 之间移动（N7，和 R2-C-m2 同一条），
  // 不用 aria-activedescendant（指向 menuitem 时读屏不报选中）。行和 kit MenuItem 一样 tabIndex=-1：可以聚焦、不进 Tab 序列；
  // 禁用行不聚焦。浮层第一行的 data-highlighted = 打开后焦点所在的行（静态画廊不真的聚焦）；sheet（bare）没有键盘选中行。
  // P4：放在 PiMenu 里时每行是 Radix DropdownMenu.Item（asChild），焦点真的在行之间移动、Enter 选中、选中后 Radix 关菜单；
  // sheet 里（bare）给了 onPick 时行可以 Tab 到、点 / Enter / 空格选中。
  const radix = usePiMenuSurface().kind === "dropdown"
  const sheetPick = bare && onPick != null
  const item = (key: PiAttachPick, node: ReactNode, disabled?: boolean) => {
    if (radix) {
      return (
        <DropdownMenu.Item key={key} asChild disabled={disabled} onSelect={() => onPick?.(key)}>
          {node}
        </DropdownMenu.Item>
      )
    }
    return node
  }
  const pickProps = (key: PiAttachPick, disabled?: boolean) =>
    sheetPick && !disabled
      ? {
          tabIndex: 0,
          onClick: () => onPick?.(key),
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              onPick?.(key)
            }
          },
        }
      : {}
  const body = (
    <>
      {ATTACH_ROWS.map((r, i) =>
        item(
          r.key,
          <PiMenuRow
            key={r.key}
            tabIndex={-1}
            variant={variant}
            icon={r.icon}
            name={r.name}
            desc={r.desc}
            twoLine
            highlighted={i === 0 && !bare && !radix && onPick == null}
            {...pickProps(r.key)}
          />,
        ),
      )}
      <MenuSeparator className="my-1" />
      {item(
        "commands",
        <PiMenuRow
          key="commands"
          tabIndex={commandsDisabled ? undefined : -1}
          variant={variant}
          icon={<SquareSlash />}
          name="命令…"
          disabled={commandsDisabled}
          trailing="/"
          {...pickProps("commands", commandsDisabled)}
        />,
        commandsDisabled,
      )}
      {item("usage", <PiMenuRow key="usage" tabIndex={-1} variant={variant} icon={<ChartColumn />} name="用量与费用" {...pickProps("usage")} />)}
    </>
  )
  const footer = "@ 可以引用这个会话里出现过的文件"
  if (bare) {
    return (
      <div data-slot="pi-attach-menu" data-cw-id="pi-attach-menu" role="menu" aria-label="添加" className={cn("flex flex-col", className)}>
        {body}
        <div className={cn("mt-1 border-t border-solid border-(--cw-divider-soft) px-3 pt-3 pb-1", rowText(variant).sub, C_SECONDARY)}>
          {footer}
        </div>
      </div>
    )
  }
  return (
    <PiComposerMenu
      variant={variant}
      data-cw-id="pi-attach-menu"
      aria-label="添加"
      footer={footer}
      className={className}
      {...rest}
    >
      {body}
    </PiComposerMenu>
  )
}
