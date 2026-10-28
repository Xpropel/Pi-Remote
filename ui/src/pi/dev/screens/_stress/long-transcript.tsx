import { useLayoutEffect, useMemo, useState } from "react"
import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhoneChat } from "@/pi/dev/frames/BFrames"
import { CONVO_DONE, NOW, TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { PiRoot, PiStaticProvider } from "@/components/pi/shared"
import { STRESS_ITEMS, stressItems } from "./stressData"

/**
 * 下划线开发屏（不计入 32 屏、不参加对图）：长对话压力屏（PLAN 4.3 验证）。
 * 1 万条进 PiTranscript，渲染窗只挂最后 300 条；对话流是可交互态（PiStaticProvider value=false：吸底、上滑松开、
 * 「显示更早的 300 条」能点），外框仍是静态的。
 * 给 R2 的探针打两个 performance 标记：pi-long-transcript:render（从开始渲染到提交，含造 1 万条数据）、
 * pi-long-transcript:frame（提交后的第一帧）。
 */
export const piScreen: PiScreenMeta = {
  id: "long-transcript",
  area: "b",
  title: "长对话压力屏（开发屏）",
  states: [
    "1 万条（= TRANSCRIPT_MAX_ITEMS），渲染窗 300 条",
    "点「显示更早的 300 条」多挂一页，视口不跳",
    "上滑松开贴底，回到底部重新贴住",
    "右上角「换会话（开发）」：渲染窗回到 300 条、回到底部、内容淡入（减少动效时不淡入）",
  ],
  notes: `PLAN 4.3。${STRESS_ITEMS} 条、每 10 条一个回合（用户卡、探索行、读取、正文、终端卡、ts 代码块、diff 卡、测试输出）。首帧目标 < 500 ms（估计），R2/logs/p4/lane-b 的 probe-long 用 Chrome performance 记。`,
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const [t0] = useState(() => performance.now())
  const stress = useMemo(() => stressItems(), [])
  // 开发用：右上角「换会话」在 1 万条和一段短对话之间切（测切会话：渲染窗回到 300、回到底部、淡入）
  const [session, setSession] = useState<"stress" | "short">("stress")
  useLayoutEffect(() => {
    performance.measure("pi-long-transcript:render", { start: t0 })
    const raf = requestAnimationFrame(() => performance.mark("pi-long-transcript:frame"))
    return () => cancelAnimationFrame(raf)
  }, [t0])
  const dock = (
    <PiComposerDock variant={variant} state="S0" model={C_MODEL_LABEL} tray={[TRAY_CHANGES]} status={{ device: "MacBook Pro", branch: "main" }} />
  )
  const transcript = (
    <PiStaticProvider value={false}>
      <PiTranscript items={session === "stress" ? stress : CONVO_DONE} variant={variant} now={NOW} sessionKey={session} />
    </PiStaticProvider>
  )
  const switcher = (
    <button
      type="button"
      data-cw-id="dev-switch-session"
      onClick={() => setSession((s) => (s === "stress" ? "short" : "stress"))}
      className="absolute top-14 right-3 z-(--cw-pi-z-popover) h-11 rounded-(--cw-radius-button) border border-(--cw-border) bg-(--cw-surface) px-3 text-(length:--cw-text-sm) text-(--cw-text)"
    >
      换会话（开发）
    </button>
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <BPhoneChat roomId="r-s1" dock={dock}>
          {transcript}
        </BPhoneChat>
      ) : (
        <BDesktop roomId="r-s1" dock={dock}>
          {transcript}
        </BDesktop>
      )}
      {switcher}
    </PiRoot>
  )
}
