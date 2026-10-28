import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { ADesktop, APhoneList } from "@/pi/dev/frames/AFrames"
import { ADock, ATranscript } from "@/pi/dev/frames/AConversation"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "session-list",
  area: "a",
  title: "会话列表（首页）",
  themes: ["light", "dark"],
  states: [
    "rail 态（B02：宽 48，只留新建、搜索和一列行首标记）",
    "筛选生效（顶部 chip「只看 MacBook Pro ×」，组头只写目录名）",
    "超过 200 条（列表末尾灰字「只列出最近 200 个会话」）",
    "筛选后为空",
    "展开更多 N（v1.2 M-08：点「… 更多 7」就地展开本组全部 12 行，末行换成「收起」，同样 44 高；展开状态按组记在 usePiUiState，切换分组方式时清空；手机同样处理。piSessionGroups({ expanded: [\"d-mbp:/Users/dev/code/pi-remote\"] })）",
    "不分组（v1.2 D-07，显示选项里选「不分组（按最近活动）」：需要处理组仍在最上；其余会话按 updatedAt 倒序一个列表，没有组头、不折叠「更多」、不出文件夹行，200 条上限不变；每行两行（桌面 46、手机 64），第二行「设备名/目录名」，离线行只淡标记、第二行「ThinkPad/game-tools · 未连接」；设备筛选照常生效。PiSidebar grouping=\"flat\" + piSessionGroups({ grouping: \"flat\" })）",
  ],
  notes:
    "C07 C08 C09 C01 B01 B02 J01 J02 J03 K12。全部设备合进一个列表，按「设备/目录」分组，每组最多 5 行 + 更多；需要处理组在最上（等你回答 / 出错 / 设备未连接 / 完成未读）。桌面当前 r-s1、悬停 r-s2（行尾时间换成 …）。主区 = b 的 PiTranscript（CONVO_SHORT）+ c 的 PiComposerDock。推断：蓝色问号圈、红点、组头 36、手机列表无选中行。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <APhoneList />
      ) : (
        <ADesktop selectedId="r-s1" hoverId="r-s2" dock={<ADock variant="desktop" />}>
          <ATranscript variant="desktop" />
        </ADesktop>
      )}
    </PiRoot>
  )
}
