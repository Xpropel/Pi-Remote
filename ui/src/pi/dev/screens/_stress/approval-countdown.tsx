import { useEffect, useState } from "react"
import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhoneChat } from "@/pi/dev/frames/BFrames"
import { APPROVAL_DIALOG, CONVO_APPROVAL } from "@/pi/dev/fixtures/gallery/b"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiApprovalCard } from "@/components/pi/conversation/PiApprovalCard"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { PiRoot } from "@/components/pi/shared"
import type { PiDialogCard } from "@/components/pi/shared/types"

/**
 * 下划线开发屏（不计入 32 屏、不参加对图）：审批卡的读屏播报（design §4.7、PLAN 4.5）。
 * 时钟真走（每秒一跳），卡出现时还剩 13 秒：先播报一次标题和问题，跳进 10 秒内时播报一次"还剩 10 秒"，之后不再逐秒播报；
 * 到 0 收成"已超时"回执。读屏文字在 [data-pi-part="approval-live"]，R2/logs/p4/lane-b 的 probe-approval 按时间记下它的每次变化。
 */
export const piScreen: PiScreenMeta = {
  id: "approval-countdown",
  area: "b",
  title: "审批卡倒计时播报（开发屏）",
  states: ["出现：播报标题和问题", "剩 10 秒：播报「还剩 10 秒」", "超时：一行灰字回执"],
  notes: "PLAN 4.5 / design §4.7 实时区域。卡出现时剩 13 秒（APPROVAL_DIALOG 的 120 秒超时，起点往前挪）。",
}

/** 卡出现时剩这么多毫秒 */
const START_REMAINING_MS = 13_000

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const [dialog] = useState<PiDialogCard>(() => ({
    ...APPROVAL_DIALOG,
    dialogId: "dlg-countdown",
    startedAt: Date.now() - ((APPROVAL_DIALOG.timeout ?? 120_000) - START_REMAINING_MS),
  }))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const expired = dialog.timeout != null && now >= dialog.startedAt + dialog.timeout
  const dock = (
    <PiComposerDock
      variant={variant}
      state="S3"
      blockedBy={expired ? null : "approval"}
      model={C_MODEL_LABEL}
      status={{ device: "MacBook Pro", branch: "main", note: expired ? undefined : "先回答上面的问题", tone: "warn" }}
      approval={<PiApprovalCard dialog={dialog} now={now} variant={variant} state={expired ? "expired" : "open"} maxHeight={phone ? 264 : undefined} />}
    />
  )
  const transcript = <PiTranscript static items={CONVO_APPROVAL} variant={variant} now={now} running={{ since: dialog.startedAt, line: false }} />
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <BPhoneChat roomId="r-s3" dock={dock}>
          {transcript}
        </BPhoneChat>
      ) : (
        <BDesktop roomId="r-s3" dock={dock}>
          {transcript}
        </BDesktop>
      )}
    </PiRoot>
  )
}
