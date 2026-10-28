import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhoneChat } from "@/pi/dev/frames/BFrames"
import { ARCHIVE, NOW } from "@/pi/dev/fixtures/gallery/b"
import { PiStreamTopLine } from "@/components/pi/conversation/PiStreamLines"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "session-archived",
  area: "b",
  title: "未载入的会话（本机记录）",
  states: [
    "发送阶段（状态行「正在 Mac Studio 上启动会话… 6s」→「正在载入会话并发送…」）",
    "60 秒没上线（红字「没能在 60 秒内载入 · 重试」）",
    "没有本机记录（只显示标题 + 首条消息卡）",
    "正在读取记录（Spinner）",
    "渲染窗外还有更早的消息（D01「显示更早的 120 条」）",
  ],
  notes:
    "C13 D01 D07 D16 D19。s7（Mac Studio/infra，openable:false，有本机记录 SessionArchiveView）。压缩摘要、本机 !nginx -t（你运行了）、表格（独立横滚、只有横线）、14 行代码块（超过 12 行渐隐 + chevron）、任务清单、扩展消息（remote-bash）、过大图占位（read 工具结果里的 omitted 图）、长回复折叠。记录里有哪些条目类型以 sessionArchive.ts 为准（未验证）。长回复折叠、过大图占位、代码块渐隐都是推断。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dock = (
    <PiComposerDock
      variant={variant}
      state="S0"
      model={C_MODEL_LABEL}
      placeholder="发送时载入"
      // 原因只写在状态行（§1.6 D-02）；note 已含设备名，不再另传 device，免得桌面写成"… · Mac Studio"两遍
      status={{ note: "Mac Studio · 未载入，发第一条时载入", tone: "default" }}
    />
  )
  const topLine = (
    <PiStreamTopLine
      lines={[
        { text: "这是电脑上保存的记录，发第一条消息时在 Mac Studio 上载入" },
        ...(ARCHIVE.truncated ? [{ text: `更早的 ${ARCHIVE.olderCount} 条没有放进这一页` }] : []),
      ]}
    />
  )
  const transcript = (
    <PiTranscript static items={ARCHIVE.items} variant={variant} now={NOW} topLine={topLine} folded={["a-s7-7:0"]} scroll={0} />
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        // 手机停在底部：露出扩展消息、过大图占位和折叠的长回复（桌面停在顶部：流顶说明、压缩摘要、表格、代码块渐隐）
        <BPhoneChat roomId="s7" dock={dock} scrollTop="bottom">
          {transcript}
        </BPhoneChat>
      ) : (
        <BDesktop roomId="s7" dock={dock}>
          {transcript}
        </BDesktop>
      )}
    </PiRoot>
  )
}
