import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { ADesktop, APhoneChat, aHead } from "@/pi/dev/frames/AFrames"
import { ADock, ATranscript } from "@/pi/dev/frames/AConversation"
import { aAttachCommand } from "@/components/pi/shell"
import { CONVO_OFFLINE } from "@/pi/dev/fixtures/gallery/b"
import { PiStreamTopLine } from "@/components/pi/conversation/PiStreamLines"
import { PiCopyField, PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "device-offline",
  area: "a",
  title: "设备离线",
  states: [
    "本机 pi 没在跑（A08：流顶「这个会话已结束：电脑上的 pi 没在运行」+「重新启用」；不自动跳到别的会话、不清空正文）",
    "离线且没有快照（「没有可显示的记录」）",
  ],
  notes:
    "C04 A08。打开离线设备 ThinkPad 上的 r-s8：可读 relay 存的最后快照（b 的 CONVO_OFFLINE），输入照写、发送进 outbox（S5）；v1.2（D-02）：占位「写好先排队」，框下状态行「ThinkPad 未连接 · 上线后发送」（tone=warn）+ attach 命令复制框（Windows：deploy\\attach.cmd，同 relay/devices.ts attachCommand）。左栏 ThinkPad 组整体变淡、组头「· 未连接」。推断：状态行与复制框的排法（手机复制框单独一行，点击区 44）。",
}

const ROOM = "r-s8"

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const head = aHead(ROOM)
  const name = head.device?.name ?? "设备"
  const command = aAttachCommand(head.device?.platform)
  const topLine = <PiStreamTopLine lines={[{ text: `${name} 未连接，只能看历史` }]} />
  // v1.2（D-02，design §1.6）：占位只用短句，原因写进框下状态行；attach 命令照旧走 status.copy（手机）/ statusTrailing（桌面）。
  // 原因里已经写了设备名，设备离线时也拿不到分支（get_git_branch 要设备在线），所以桌面不再接「 · 设备 · 分支」
  const status = { note: `${name} 未连接 · 上线后发送`, tone: "warn" as const }
  const placeholder = "写好先排队"
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <APhoneChat
          roomId={ROOM}
          // 手机：命令走 c 的状态行契约 status.copy（状态行下面另起一行整宽 PiCopyField，点击区 44）
          dock={<ADock variant="phone" state="S5" tray={[]} placeholder={placeholder} status={{ ...status, copy: command }} />}
        >
          <ATranscript variant="phone" items={CONVO_OFFLINE} topLine={topLine} />
        </APhoneChat>
      ) : (
        <ADesktop
          selectedId={ROOM}
          dock={
            <ADock
              variant="desktop"
              state="S5"
              tray={[]}
              placeholder={placeholder}
              status={status}
              // 桌面：design 写的是同一行「状态行 + PiCopyField」，用紧凑复制框放进状态行右端（不传 status.copy，免得另起一行）
              statusTrailing={<PiCopyField value={command} size="sm" className="w-[220px]" />}
            />
          }
        >
          <ATranscript variant="desktop" items={CONVO_OFFLINE} topLine={topLine} />
        </ADesktop>
      )}
    </PiRoot>
  )
}
