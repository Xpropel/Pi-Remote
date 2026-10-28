// Pi 部件用的布局与主题类型（实施计划 P2.3、D13、8.1）。P2.3 由 R2/tools/import-replica.mjs 生成；冻结后 P8 用 R2/tools/p8-layout-values.mjs
// 把取值从舞台尺寸改成 "desktop" | "phone"。开发画廊的 registry.ts 也从这里 re-export。
/** 布局：桌面 / 手机。产品里按 1024 断点判定（shell/breakpoints.ts，< 1024 一律手机版式）；画廊舞台用 piLayoutOf 从舞台尺寸换算 */
export type PiLayout = "desktop" | "phone"
/** 开发画廊的舞台尺寸（CSS px）：桌面 1440×900；手机 390×844（iPhone 12–15 竖屏）。每个屏幕两个尺寸都要出；也是 vp= 参数和截图文件名 */
export type PiStageSize = "1440x900" | "390x844"
export type PiTheme = "light" | "dark"
/** 舞台尺寸 → 布局：390x844 → "phone"，1440x900 → "desktop"。传 PiLayout（例如部件的 variant）原样返回。全仓只在这里换算 */
export function piLayoutOf(v: PiStageSize | PiLayout): PiLayout {
  return v === "390x844" || v === "phone" ? "phone" : "desktop"
}
