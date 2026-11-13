import { ChevronDown } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { ROW_HL_HOVER } from "./styles"

/**
 * 流里的卡（diff 卡、终端卡、代码块）共用一套几何，改一处就是改全部：
 * - 外框：圆角 --cw-radius-card、1px --cw-border、--cw-surface 底，不加投影；上下 10 的块间距（表格、图片同一档）。
 * - 卡头：桌面 31 高 + 1px 分隔 = 32（kit InlineDiffCard 实测），手机 36（可点的终端卡头 44）；
 *   左 10 → 14px 图标 → 8 → 标题，所有卡的标题左缘对齐在 32。
 * - 收起：内容露整行，再多露 CARD_PEEK 一截渐隐成卡底色；展开箭头在卡底单独一条里（PiCardFoot），不压在代码上。
 */
export const CARD = "relative w-full min-w-0 overflow-hidden rounded-(--cw-radius-card) border border-(--cw-border) bg-(--cw-surface)"
/** 卡上下 10（kit 实测的卡片间距，= STREAM_CARD_GAP、正文表格） */
export const CARD_GAP = "my-(--cw-space-2-5)"
export const CARD_HEAD =
  "flex min-w-0 items-center gap-2 pr-2 pl-2.5 font-(family-name:--cw-font-sans) text-(length:--cw-text-base) leading-(--cw-leading-tight) whitespace-nowrap"
export const CARD_HEAD_H = "h-[31px]"
export const CARD_HEAD_H_PHONE = "h-9"
export const CARD_DIVIDER = "border-b border-(--cw-divider)"
/** 卡头图标、展开箭头的尺寸 */
export const CARD_ICON = 14
/** 收起时最后一整行下面多露的高度（CSS px） */
export const CARD_PEEK = 10
/** 贴着卡边的整条按钮：焦点环往里收 2px，不被卡的 overflow-hidden 裁掉（全局焦点环不在 @layer 里，所以要 !） */
export const INSET_FOCUS = "focus-visible:outline-offset-[-2px]!"

/** 展开 / 收起箭头：14px、1.5 线宽、--cw-text-3；收起时转成 ›（rotate=false 时收起朝下、展开朝上，给卡底展开条用） */
export function PiDisclosure({ open, sideways = true, className }: { open: boolean; sideways?: boolean; className?: string }) {
  return (
    <ChevronDown
      aria-hidden
      size={CARD_ICON}
      strokeWidth={1.5}
      className={cn(
        "shrink-0 text-(--cw-text-3) transition-transform duration-(--pi-motion-in) ease-(--pi-ease-out)",
        sideways ? !open && "-rotate-90" : open && "rotate-180",
        className,
      )}
    />
  )
}

/** 收起内容底部的渐隐：只盖多露的那一截，最后一整行不被盖；从半透明起，露出的字头只是一道淡影、不成一排碎点 */
export function PiCardPeekFade() {
  return (
    <div
      aria-hidden
      data-pi-part="card-fade"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[10px] bg-linear-to-b from-(--cw-surface)/50 to-(--cw-surface)"
    />
  )
}

/** 手机（[data-pi-layout=phone]）：卡底展开条 32 高，点击区向上外扩到 44（盖在渐隐那一截上，卡内不被裁） */
const FOOT_PHONE =
  "in-data-[pi-layout=phone]:h-8 in-data-[pi-layout=phone]:after:absolute in-data-[pi-layout=phone]:after:inset-x-0 in-data-[pi-layout=phone]:after:bottom-0 in-data-[pi-layout=phone]:after:h-11 in-data-[pi-layout=phone]:after:content-['']"

/** 卡底展开条：整条可点，箭头居中（收起朝下、展开朝上）。桌面 24 高，手机见 FOOT_PHONE */
export function PiCardFoot({ open, onToggle, label }: { open: boolean; onToggle?: () => void; label: string }) {
  return (
    <button
      type="button"
      data-pi-part="card-foot"
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
      className={cn("group/foot relative flex h-6 w-full items-center justify-center", ROW_HL_HOVER, INSET_FOCUS, FOOT_PHONE)}
    >
      <PiDisclosure open={open} sideways={false} className="group-hover/foot:text-(--cw-text-2)" />
    </button>
  )
}
