import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhoneChat } from "@/pi/dev/frames/BFrames"
import { APPROVAL_DIALOG, BACKFILL_TEST, CONVO_APPROVAL, NOW } from "@/pi/dev/fixtures/gallery/b"
import { contentToRows } from "@/components/pi/conversation/patch"
import { PiApprovalCard } from "@/components/pi/conversation/PiApprovalCard"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "approval-waiting",
  area: "b",
  title: "等你回答",
  themes: ["light", "dark"],
  states: [
    "confirm 型（黑「允许」+ 描边「拒绝」）",
    "input / editor 型（输入框 + 黑「提交」）",
    "拒绝并写理由（展开输入框）",
    "发送中（选项行尾 Spinner）",
    "发送失败（卡内红字 + 重试）",
    "已在别处回答（收成灰字后消失）",
    "只读观察（answerable 为空：只能在电脑上回答）",
    "旧式信号（F07：PiPromptSignal 一行）",
    "拒绝回执（F06：一行灰字，8 秒）",
    "超时（state「expired」：收成一行灰字「已超时，pi 按默认处理」，8 秒后或下一张卡出现时消失；composer 的 blockedBy 回到 null）",
  ],
  notes:
    "F05 F06 F07 M-06 D-08。r-s3 的 DialogCard（select，timeout 120s，startedAt NOW−38s → 剩余 1:22）。审批卡整卡版式推断；放在 dock 的审批槽（tray 上方）。审批禁用不是 S7：state = S3（回合在跑、输入框空）+ blockedBy「approval」，占位「输入已禁用」，状态行「先回答上面的问题」（warn），黑圆钮仍是停止。卡 role=group、aria-labelledby 指向卡头；出现时 polite 播报一次标题和问题，剩 10 秒再播报一次。流里被挡住的那条 bash 用 ToolState 预留的 waiting_approval 画成行尾蓝字「等你确认」（推断：现在的协议里它停在 input-available，会显示成运行中）。等待只在审批卡一处表达，流末尾不放运行行。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const added = contentToRows(BACKFILL_TEST).length
  const dock = (
    <PiComposerDock
      variant={variant}
      state="S3"
      blockedBy="approval"
      model={C_MODEL_LABEL}
      tray={[{ kind: "changes", label: "改动", added }]}
      status={{ device: "MacBook Pro", branch: "main", note: "先回答上面的问题", tone: "warn" }}
      // 手机 dock 总高 ≤ 可视视口 50%（422，§3.4 / §4.2）：dock 其余部分（上内距 8 + 卡下 8 + tray 36 + 8 + composer 52 + 4 + 状态行 32）≈ 148，
      // 所以卡最高 264，超出在卡内滚动（"任一设备先答为准 / 拒绝并说明理由…"一行要上滑才看到）
      approval={<PiApprovalCard dialog={APPROVAL_DIALOG} now={NOW} variant={variant} maxHeight={phone ? 264 : undefined} />}
    />
  )
  // 回合还在进行（busy：不出用时与操作行），但"等你回答"只在审批卡一处表达（§5），流末尾不放"正在工作"运行行
  const turnStart = CONVO_APPROVAL[0].timestamp ?? APPROVAL_DIALOG.startedAt
  const transcript = (
    <PiTranscript static items={CONVO_APPROVAL} variant={variant} now={NOW} running={{ since: turnStart, line: false }} />
  )
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
