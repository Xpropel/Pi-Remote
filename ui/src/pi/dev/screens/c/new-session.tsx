import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { SuggestionPills } from "@/components/kit/composer/SuggestionPills"
import { CDesktop } from "@/pi/dev/frames/CFrames"
import { C_MODEL_LABEL, NEW_SESSION_SUGGESTIONS } from "@/pi/dev/fixtures/gallery/c"
import { PiEmptyComposer } from "@/components/pi/composer/PiEmptyComposer"
import { PiPhonePage, PiRoot, PiTopBar } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "new-session",
  area: "c",
  title: "新建会话",
  themes: ["light", "dark"],
  states: [
    "还没选目录（「选择目录 ∨」，发送不可点）",
    "只有一台设备（不出现设备段）",
    "启动中（框下「正在 MacBook Pro 上启动 pi… 12s」，输入锁定、草稿保留）",
    "启动失败（框下红字：device_offline / cwd_not_allowed / session_not_found / spawn_failed / 超时 + 「重试」）",
    "设备离线（设备段「ThinkPad · 未连接」，发送禁用并写原因）",
    "设备在线但没有会话（预选这台设备和它的第一个目录，用户直接写第一条）",
    "会话为空时选择器只读（设备 / 目录只显示文字，去掉 ∨，不可点）",
    "P9 C：设备有浏览根目录（新 attach）→「打开文件夹…」可用；旧 attach「需要更新」、没开浏览「没有开启文件夹浏览」、设备离线「设备未连接」三种置灰原因",
  ],
  notes:
    "C06 D22。先选目录、写第一条，发送时才启动 pi（待用户确认 12）。选择器 = 文字 + ∨ 不画框（empty-state-composer）；建议 pill 用 ch4/SuggestionPills（一黑两描边，文案来自现有空会话建议）。输入框空 → 黑圆钮是浅灰 send-muted（hunt-og-render#9 口径）。深色整套推断。P9 C：文件夹选择器的两级菜单见 c/new-session-picker，浏览器见开发屏 _folder/folder-browser。",
}

function Composer({ variant }: { variant: "desktop" | "phone" }) {
  return (
    <PiEmptyComposer static
      variant={variant}
      device={{ name: "MacBook Pro", platform: "darwin" }}
      folder="pi-remote"
      model={C_MODEL_LABEL}
      below={
        variant === "desktop" ? (
          <SuggestionPills data-cw-id="pi-new-suggestions" items={NEW_SESSION_SUGGESTIONS} />
        ) : undefined
      }
    />
  )
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <PiPhonePage
          topBar={<PiTopBar variant="phone-page" title="新会话" />}
          contentClassName="h-full"
          dock={
            <div className="px-4 pt-2 pb-2">
              <Composer variant="phone" />
            </div>
          }
        >
          <div className="flex h-full flex-col justify-center px-4">
            <SuggestionPills
              data-cw-id="pi-new-suggestions"
              items={NEW_SESSION_SUGGESTIONS}
              className="flex-col items-stretch gap-2.5"
              pillClassName="h-11 w-full justify-center text-[15px]"
            />
          </div>
        </PiPhonePage>
      ) : (
        <CDesktop navSelected="new">
          <div className="absolute inset-0 flex justify-center px-10 pt-[268px]">
            <div className="w-full max-w-[640px]">
              <Composer variant="desktop" />
            </div>
          </div>
        </CDesktop>
      )}
    </PiRoot>
  )
}
