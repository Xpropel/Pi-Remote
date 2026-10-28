import { cn } from "@/lib/utils"
import { SuggestionPills } from "@/components/kit/composer/SuggestionPills"
import { Plus } from "@/components/kit/icons"
import { PiCenteredState, PiMark, usePiStatic } from "@/components/pi/shared"

export interface PiNoDevicesProps {
  variant: "desktop" | "phone"
  /** relay 没声明 device.token：不显示"配对新设备"，只写接入说明（states） */
  pairingSupported?: boolean
  /** P5：点"配对新设备"（开设备与配对）。静态态不接 */
  onPair?: () => void
  /** P5：点"查看接入说明" */
  onGuide?: () => void
  className?: string
}

const PILLS_ID = "pi-no-devices-pills"

/**
 * 还没有设备（design §3.3 no-devices；PiCenteredState + PiMark + ch4/SuggestionPills）。
 * 两步说明 + 一黑一描边 pill；手机 pill 竖排整宽、高 44。
 * 可交互（P5）：kit SuggestionPills 没有逐颗的回调，pill 是 <button data-cw-id="<id>-<key>">，这里在外层按 data-cw-id 分派（kit 不改）。
 */
export function PiNoDevices({ variant, pairingSupported = true, onPair, onGuide, className }: PiNoDevicesProps) {
  const isStatic = usePiStatic()
  const phone = variant === "phone"
  const items = pairingSupported
    ? [
        { key: "pair", label: "配对新设备", primary: true, icon: <Plus strokeWidth={2} /> },
        { key: "guide", label: "查看接入说明" },
      ]
    : [{ key: "guide", label: "查看接入说明", primary: true }]
  return (
    <PiCenteredState
      icon={<PiMark size={32} />}
      title="还没有电脑连上 Pi-Remote"
      body={
        <ol className="m-0 mt-1 flex list-none flex-col gap-1 p-0 text-left">
          <li>1. 在设置 › 设备里用管理员令牌生成配对码；</li>
          <li>2. 在电脑终端运行页面给出的配对命令。</li>
        </ol>
      }
      actions={
        <SuggestionPills
          data-cw-id={PILLS_ID}
          items={items}
          className={cn(phone && "w-full flex-col items-stretch gap-2.5")}
          pillClassName={phone ? "h-11 w-full justify-center text-[15px]" : undefined}
          onClick={
            isStatic
              ? undefined
              : (event) => {
                  const id = (event.target as Element).closest("[data-cw-id]")?.getAttribute("data-cw-id")
                  if (id === `${PILLS_ID}-pair`) onPair?.()
                  else if (id === `${PILLS_ID}-guide`) onGuide?.()
                }
          }
        />
      }
      actionsClassName={phone ? "w-full" : undefined}
      className={className}
    />
  )
}
