import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhoneChat } from "@/pi/dev/frames/BFrames"
import { CONVO_DONE, NOW, TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "conversation",
  area: "b",
  title: "对话 · 已完成",
  themes: ["light", "dark"],
  states: [
    "回复操作行悬停",
    "代码复制成功（✓ 1.2 秒）",
    "点图打开 PiLightbox（版式见 §2 D15，开发屏 b/_lightbox：#/pi/lightbox）",
    "取原图失败（过大占位块里「加载失败 · 重试」，M-04）",
    "密度 精简 / 详细",
    "扩展 statuses（K08，经 status.extra：状态行右侧灰字，最多 2 段、每段 ≤ 24 字；手机有 note 时不显示）",
    "重新回答确认（G03）",
  ],
  notes:
    "D03–D05 D08–D12 D14 D15 D17 D20 K10。r-s1 最后一个回合：用户卡（来自网页的手机小图标、1 张截图）→ 用时 → 思考 6 秒 → 查看了 3 个文件，搜索 2 次 → 读取 → 正文 → diff 卡（details.patch）→ 终端卡 → 收尾正文 → 操作行。推断：终端卡人话短语按命令查表（pi 的 bash 没有描述字段）、diff 卡 chevron 常显、手机 diff 卡带行号软换行。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dock = (
    <PiComposerDock
      variant={variant}
      state="S0"
      model={C_MODEL_LABEL}
      tray={[TRAY_CHANGES]}
      status={{ device: "MacBook Pro", branch: "main" }}
    />
  )
  const transcript = <PiTranscript static items={CONVO_DONE} variant={variant} now={NOW} />
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
    </PiRoot>
  )
}
