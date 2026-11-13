import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { ModelExplainerCard } from "@/components/kit/menu/ModelExplainerCard"
import { TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiComposerDock } from "@/components/pi/composer"
import { CDesktop, CPhoneChat, CTranscript } from "@/pi/dev/frames/CFrames"
import { C_MODEL_LABEL, C_MODELS, THINKING_CURRENT, THINKING_LEVELS } from "@/pi/dev/fixtures/gallery/c"
import { PiModelMenu } from "@/components/pi/composer/PiModelMenu"
import { PiRoot, PiSheet } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "model-menu",
  area: "c",
  title: "模型选择",
  states: [
    "切换中（行尾 Spinner）",
    "切换失败（选择器回到原值 + warning 通知）",
    "未配置的 provider 不出现在列表里（去设置页配置）",
    "键盘开着时（输入框上方浮层，不用 sheet）",
  ],
  notes:
    "E10 E11 G02；2026-11-09 改版（Cursor 式结构）：搜索 → 模型列表（只列已配置的，行只有名字 + 最右尾列，当前 ✓；Qwen3 Coder 未配置、不进行）。桌面悬停行尾列出 Edit、右侧出介绍卡（事实行 + 费用说明，ch4/ModelExplainerCard 直接 import，费用一行橙色 = 全产品唯一的橙色）；点 Edit 才出参数面板（上下文变体 + 思考级别）。手机为 PiSheet 两级：第一级 Edit 常驻行尾，点 Edit / 点当前行进第二级参数页，无介绍卡。模型表是 mock。",
}

const HOVER = "google/gemini-2.5-pro"
/** 悬停 Gemini 的介绍卡：只有事实（窗口 + 图片）与费用说明，不编简介（改版 §2.4） */
const GEMINI_FACTS_EXPLAINER = {
  title: "Gemini 2.5 Pro",
  tagline: [] as string[],
  context: "上下文窗口 1M · 支持图片输入",
  cost: ["输入超过 200k tokens 时", "单价翻倍"],
  version: ["google/gemini-2.5-pro"],
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  // 桌面：菜单右缘对齐模型选择器右缘（composer 右内距 10 + 圆钮 26 + 间距 10 = 46），说明卡在菜单右侧 8px、垂直居中对齐悬停行
  const menu = phone ? undefined : (
    <div className="flex justify-end pr-[46px]">
      <PiModelMenu static
        models={C_MODELS}
        thinkingLevels={THINKING_LEVELS}
        thinking={THINKING_CURRENT}
        variant="desktop"
        hoverKey={HOVER}
        explainer={
          // 费用一行用 Pi 的警告橙（C5：--cw-orange 在白底只有 3.1:1）；只在这张卡里重设，章节件不改
          <ModelExplainerCard
            data-cw-id="pi-model-explainer"
            explainer={GEMINI_FACTS_EXPLAINER}
            className="[--cw-orange:var(--cw-pi-warning,#8A6516)]"
          />
        }
      />
    </div>
  )
  const dock = (
    <PiComposerDock static
      variant={variant}
      state="S0"
      model={C_MODEL_LABEL}
      tray={[TRAY_CHANGES]}
      status={{ device: "MacBook Pro", branch: "main" }}
      modelOpen
      menu={menu}
    />
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <CPhoneChat
          roomId="r-s1"
          dock={dock}
          sheet={
            <PiSheet static title="模型" bodyClassName="px-4">
              <PiModelMenu static variant="phone" models={C_MODELS} thinkingLevels={THINKING_LEVELS} thinking={THINKING_CURRENT} />
            </PiSheet>
          }
        >
          <CTranscript variant={variant} />
        </CPhoneChat>
      ) : (
        <CDesktop roomId="r-s1" dock={dock}>
          <CTranscript variant={variant} />
        </CDesktop>
      )}
    </PiRoot>
  )
}
