import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiComposerDock } from "@/components/pi/composer"
import { CDesktop, CPhoneChat, CTranscript } from "@/pi/dev/frames/CFrames"
import { C_MODEL_LABEL, C_STATS } from "@/pi/dev/fixtures/gallery/c"
import { MOCK_USAGE } from "@/pi/dev/fixtures/gallery/shared"
import { PiUsageDialog } from "@/components/pi/composer/PiUsageDialog"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "dialog-usage",
  area: "c",
  title: "用量与费用（弹窗家族代表）",
  states: [
    "加载中",
    "读取失败（「读取失败 · 重试」）",
    "窗口不可信（只写 token 数，无圆环）",
    "压缩（G04：可选总结要求 + 黑「开始压缩」→「压缩中…」→ 完成写前后 token）",
    "分叉（G08：用户消息列表，冷分叉确认）",
    "克隆（G09）",
    "会话树（G10：跳转方式、筛选、搜索、缩进节点、当前叶加粗）",
    "导出（G12：文本预览 + 复制 / 下载 .txt，≤512KB）",
    "本机设置（G14：JSON，敏感键 ***）",
    "系统提示词（G15：全文 + 字数 + 截断标记）",
    "工具（G16：勾选行 + 保存）",
    "当前状态（G17：键值行）",
    "检视本机信息（G18：分类页签 + JSON）",
    "命令失败（弹窗不关，按钮行上方一行红字，例如「压缩失败：pi 正忙」；按钮恢复可点）",
  ],
  notes:
    "G05 G06（/stats + /usage 合并成一个弹窗）。数据：get_session_stats（totalMessages 48 = 你 8 + pi 20 + 工具结果 20；工具调用 20。design 写的 12 / 36 / 63 凑不出 48，按真实字段口径改了计数）+ r-s1 的 usage_state（MOCK_USAGE：费用 $3.84、上下文 61.8k / 200k = 30.9%、缓存命中 = cacheRead / (input + cacheRead) = 87%、按模型两行）。不再用绿色进度条。桌面 PiDialog 480 居中压暗；手机 PiDialog 自动变成全高 PiSheet。描边「刷新」按钮是自组的（kit Button 只有实心黑 / 蓝，推断）。",
}

/** 示例会话名（r-s1 的标题）：部件不再带默认示例值，画廊屏自己传（lane-requests/p5-c.md 第 4 条） */
const SAMPLE_SUBTITLE = "修复手机键盘收起时输入框跳动"

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dock = (
    <PiComposerDock static variant={variant} state="S0" model={C_MODEL_LABEL} tray={[TRAY_CHANGES]} status={{ device: "MacBook Pro", branch: "main" }} />
  )
  const dialog = <PiUsageDialog static viewport={viewport} usage={MOCK_USAGE} stats={C_STATS} subtitle={SAMPLE_SUBTITLE} />
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <CPhoneChat roomId="r-s1" dock={dock} sheet={dialog}>
          <CTranscript variant={variant} />
        </CPhoneChat>
      ) : (
        <CDesktop roomId="r-s1" dock={dock} overlay={dialog}>
          <CTranscript variant={variant} />
        </CDesktop>
      )}
    </PiRoot>
  )
}
