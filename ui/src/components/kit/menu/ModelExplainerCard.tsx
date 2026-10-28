import type { ComponentProps } from "react"
import { menuShadowClass, menuSurfaceClass } from "@/components/kit"
import { cn } from "@/lib/utils"

/** 说明卡内容。每个数组 = 一个段落里按图固定的折行；段落之间空一行（#19） */
export interface ModelExplainer {
  /** 粗体模型名 */
  title: string
  /** 定位语（紧接标题，不空行） */
  tagline: string[]
  /** 上下文窗口一行 */
  context?: string
  /** 橙色费用警告（全图唯一的橙色，run-brief 第 2 条） */
  cost?: string[]
  /** 斜体版本行 */
  version?: string[]
}

export interface ModelExplainerCardProps extends Omit<ComponentProps<"div">, "children"> {
  /** 说明卡内容（P3：不再默认 GPT-5.4 的原文，由使用方给） */
  explainer: ModelExplainer
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <span key={i} className="block">
          {line}
        </span>
      ))}
    </>
  )
}

/**
 * 悬停模型行时浮在 ModelMenu 右侧的说明卡（#19）。白卡同 MenuSurface（圆角、细边、柔和投影），全是 13px 文字、左对齐：
 * 粗体名 → 定位语 →（空行）上下文窗口 →（空行）橙色费用警告 →（空行）斜体版本行。行高 17、段间空一行（实测）。
 * 宽 208.8、内距 8 / 10（#19 实测）；位置由 ModelMenu 给（菜单右侧 5.3、垂直中心对齐悬停行）。
 */
export function ModelExplainerCard({ explainer, className, ...rest }: ModelExplainerCardProps) {
  const para = "mt-[17px]"
  return (
    <div
      role="tooltip"
      data-slot="model-explainer-card"
      className={cn(
        menuSurfaceClass,
        menuShadowClass("popover"),
        "w-[208.8px] px-[9.7px] pt-[8px] pb-[8px] text-(length:--cw-text-md) leading-[17px] whitespace-nowrap select-text",
        className,
      )}
      {...rest}
    >
      <span className="block font-(--cw-weight-semibold) text-(--cw-text)">{explainer.title}</span>
      <span className="block text-(--cw-text)">
        <Lines lines={explainer.tagline} />
      </span>
      {explainer.context && <span className={cn("block text-(--cw-text)", para)}>{explainer.context}</span>}
      {explainer.cost && (
        <span data-slot="model-explainer-cost" className={cn("block text-(--cw-orange)", para)}>
          <Lines lines={explainer.cost} />
        </span>
      )}
      {explainer.version && (
        <span className={cn("block text-(--cw-text) italic", para)}>
          <Lines lines={explainer.version} />
        </span>
      )}
    </div>
  )
}
