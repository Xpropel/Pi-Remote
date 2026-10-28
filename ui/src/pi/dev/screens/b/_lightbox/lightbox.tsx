import { useState } from "react"
import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhoneChat } from "@/pi/dev/frames/BFrames"
import { CONVO_DONE, NOW, TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiLightbox, type PiLightboxImage } from "@/components/pi/conversation/PiLightbox"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiRoot } from "@/components/pi/shared"

/**
 * 下划线开发屏（不进画廊、不计入 32 屏 / 80 图，design §6.4 / §12.2）：PiLightbox 的版式（§2 D15）。
 * 背景 = b/conversation；用户卡里点了三张图里的第 2 张。
 */
export const piScreen: PiScreenMeta = {
  // 文件在下划线目录 _lightbox/ 里（不进画廊）：id 不能以 _ 开头（registry NAME_RE），路由 #/pi/lightbox
  id: "lightbox",
  area: "b",
  title: "图片灯箱（开发屏）",
  states: [
    "单张图（不出「1 / 1」）",
    "原图加载中（居中 Spinner）",
    "取原图失败（居中「加载失败 · 重试」）",
    "左右键 / 左右滑切换",
    "Esc / 点背景 / 手机返回手势关闭",
  ],
  notes:
    "D15（v1.2 D-09）。全屏 var(--cw-pi-lightbox-bg, rgba(0,0,0,.85))；图片按可视区等比缩放（contain），四边 16、手机顶部让出安全区和 × 一行，不放大超过原尺寸；右上 × 白 20 图标、点击区 48×48、aria-label「关闭图片」；多图右下灰字「2 / 3」。版式推断。",
}

/** 三张图：手机截图（竖）、桌面截图（横）、手机截图；原图像素尺寸限制放大 */
const IMAGES: PiLightboxImage[] = [
  { data: "", mimeType: "image/png", bytes: 182_400, aspect: 390 / 844, width: 1170, height: 2532 },
  { data: "", mimeType: "image/png", bytes: 412_800, aspect: 16 / 10, width: 2880, height: 1800 },
  { data: "", mimeType: "image/png", bytes: 176_100, aspect: 390 / 844, width: 1170, height: 2532 },
]

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const [index, setIndex] = useState(1)
  const [open, setOpen] = useState(true)
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
      {open && (
        <PiLightbox static images={IMAGES} index={index} variant={variant} onIndexChange={setIndex} onClose={() => setOpen(false)} />
      )}
    </PiRoot>
  )
}
