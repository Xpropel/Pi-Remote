/**
 * 标签页标题 / favicon 角标的纯逻辑（P9 修复线 W，review-1 P2-2）。
 *
 * 从 chat/composer/faviconBadge.ts 拆出来（那个文件 import React，node --test 不能直接加载；
 * 这里零依赖，测试直接加载 .ts）。三种角标：
 *  - done    ：完成，蓝点（--cw-blue 浅色值 #047ABD）
 *  - error   ：回合出错，红圈 + 白色「!」（--cw-pi-error 浅色值 #9C4558）
 *  - waiting ：有任意「等你回答」，蓝圈 + 白色「?」，**优先级最高**（高于完成/出错角标）；
 *              标题前缀由 usePageTitle 写「? 」，本文件的 badgeTitle 也认这个前缀，切换时不产生「? ?」。
 *
 * favicon 不跟主题，颜色取浅色令牌值（与 P7 B2g 的完成/出错角标同口径）。
 */

/** 角标的三种形态（waiting 为 P9 修复线 W 新增；标题前缀 / favicon 共用）。 */
export type CompletionBadgeKind = "done" | "error" | "waiting"

/** favicon 角标的颜色：完成与等你回答都是蓝（--cw-blue #047ABD），出错是红（--cw-pi-error #9C4558）。 */
export const BADGE_COLOR: Readonly<Record<CompletionBadgeKind, string>> = { done: "#047ABD", error: "#9C4558", waiting: "#047ABD" }

/** 标题最前面的状态标记（忙碌 ● / 后台跑完 ✓ / 完成角标 ! / 等你回答 ?）。只在最前面去一次，不碰会话名。 */
export const TITLE_MARK = /^(?:●|✓|!|\?)\s+/

/** 角标标题前缀。 */
export const BADGE_MARK: Readonly<Record<CompletionBadgeKind, string>> = { done: "● ", error: "! ", waiting: "? " }

/** 去掉已有状态前缀；空标题回落到 pi，避免出现只有角标的标签页。 */
export function stripTitleMark(value: string): string {
  return value.replace(TITLE_MARK, "").trim()
}

/** 叠角标前先清掉旧前缀，确保重复调用不会叠加（含「? 」→「● 」的互相覆盖）。 */
export function badgeTitle(base: string, kind: CompletionBadgeKind): string {
  const clean = stripTitleMark(base) || "pi"
  return `${BADGE_MARK[kind]}${clean}`
}

/**
 * 优先级（review-1 P2-2）：有「等你回答」时角标就是 waiting，压过完成 / 出错；
 * 没有 waiting 时保持原来的完成 / 出错角标行为（completion 原样返回）。
 */
export function badgeKindOf(input: { waiting?: number; completion: CompletionBadgeKind | null }): CompletionBadgeKind | null {
  return (input.waiting ?? 0) > 0 ? "waiting" : input.completion
}

/**
 * 在原始 favicon SVG 的右下角画角标；只追加节点，不改原图。
 * 原图是 560×560 viewBox（ui/public/favicon.svg），坐标按同一画布给出。
 *  - done    ：白色描边的蓝点；
 *  - error   ：红圈 + 白色「!」；
 *  - waiting ：蓝圈 + 白色「?」（问号 = 上半圆弧 + 短尾 + 下方圆点，笔画圆头）。
 * color 不传 = BADGE_COLOR[kind]。原图不是合法结尾的 SVG 时原样返回（不伪造）。
 */
export function completionBadgeSvg(source: string, kind: CompletionBadgeKind, color: string = BADGE_COLOR[kind]): string {
  if (!source || !/<\/svg>\s*$/i.test(source)) return source
  const ring = `<circle cx="438" cy="438" r="116" fill="${color}" stroke="#ffffff" stroke-width="34"/>`
  const mark =
    kind === "error"
      ? `${ring}<path d="M438 366v104" stroke="#ffffff" stroke-width="36" stroke-linecap="round"/><circle cx="438" cy="508" r="19" fill="#ffffff"/>`
      : kind === "waiting"
        ? `${ring}<path d="M404 400a34 34 0 1 1 34 34v20" fill="none" stroke="#ffffff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/><circle cx="438" cy="508" r="18" fill="#ffffff"/>`
        : ring
  return source.replace(/<\/svg>\s*$/i, `${mark}</svg>`)
}

/** SVG → data URI（favicon 用）。 */
export function svgDataUri(source: string): string {
  return `data:image/svg+xml,${encodeURIComponent(source)}`
}
