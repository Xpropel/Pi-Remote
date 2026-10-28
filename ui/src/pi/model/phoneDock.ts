/**
 * 手机 dock 与带输入框 sheet 的几何（design §4.2 规则 3–4、§4.3、§10；v1.2 D-05，v1.3 R2-M-07）。纯函数，node --test 直接加载。
 */

export type PiPhoneDockLayout = {
  /** dock 总高上限（审批卡 + composer）：键盘收起 50%、开着 60% */
  dockMax: number
  /** 审批卡限高：键盘开着 40%，收起时同 dockMax */
  approvalMax: number
  /** 审批卡实际高度（裁到 approvalMax）；没有审批卡为 0 */
  approvalHeight: number
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n)
}

/** vvHeight 不可用（缺失 / ≤0）时返回 null。舞台 844 收起 → 422；508 开着 → dock 305、审批 203。 */
export function phoneDockLayout(vvHeight: number, keyboardOpen: boolean, approvalHeight: number | null | undefined): PiPhoneDockLayout | null {
  if (!finite(vvHeight) || vvHeight <= 0) return null
  const dockMax = Math.round(vvHeight * (keyboardOpen ? 0.6 : 0.5))
  const approvalMax = keyboardOpen ? Math.round(vvHeight * 0.4) : dockMax
  const approval = finite(approvalHeight) && approvalHeight > 0 ? Math.min(approvalHeight, approvalMax) : 0
  return { dockMax, approvalMax, approvalHeight: approval }
}

export type PiSheetLayoutInput = {
  vvHeight: number
  vvOffsetTop: number
  /** 把手 + 标题行 */
  headerHeight: number
  /** 只算内容区 */
  contentHeight: number
  footerHeight: number
  safeTop: number
  /** full = PiSheet(full) / 手机版 PiDialog：高度固定为上限 */
  size?: "auto" | "half" | "full"
}
export type PiSheetLayout = { top: number; height: number; bodyHeight: number; compact: boolean }

/** 低于这个高度去掉把手和标题行（§4.3） */
export const PI_SHEET_COMPACT_BELOW = 160

/**
 * 键盘下的 sheet（§4.3）：高 = min(header + content + footer, vvHeight − safeTop − 24)，full 固定为上限；
 * 底边贴可视视口底：top = vvOffsetTop + vvHeight − 高；高 < 160 时 compact（不出把手和标题，bodyHeight 不减 header）。
 * vvHeight 不可用时返回 null。
 */
export function sheetLayout(input: PiSheetLayoutInput): PiSheetLayout | null {
  const { vvHeight, headerHeight, contentHeight, footerHeight } = input
  if (!finite(vvHeight) || vvHeight <= 0) return null
  const offsetTop = finite(input.vvOffsetTop) ? input.vvOffsetTop : 0
  const safeTop = finite(input.safeTop) ? input.safeTop : 0
  const max = Math.max(0, vvHeight - safeTop - 24)
  const natural = headerHeight + contentHeight + footerHeight
  const height = input.size === "full" ? max : Math.min(natural, max)
  const compact = height < PI_SHEET_COMPACT_BELOW
  const bodyHeight = Math.max(0, height - footerHeight - (compact ? 0 : headerHeight))
  return { top: offsetTop + vvHeight - height, height, bodyHeight, compact }
}
