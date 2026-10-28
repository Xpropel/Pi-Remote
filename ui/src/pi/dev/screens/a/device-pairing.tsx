import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { A_PAIR } from "@/pi/dev/fixtures/gallery/a"
import { ADesktop, APhoneList } from "@/pi/dev/frames/AFrames"
import { ADock, ATranscript } from "@/pi/dev/frames/AConversation"
import { PiDevicePairing } from "@/components/pi/shell"
import { MOCK_DEVICES, MOCK_NOW } from "@/pi/dev/fixtures/gallery/shared"
import { PiButton, PiDialog, PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "device-pairing",
  area: "a",
  title: "设备与配对",
  states: [
    "管理员令牌为空（生成配对码、撤销禁用 + 灰字「需要管理员令牌才能生成配对码或撤销设备」）",
    "配对码过期（「配对码已过期，请重新生成」）",
    "配对成功（蓝 ✓「ThinkPad 已配对」+ 重启 pi 与 attach 的提示）",
    "撤销武装（「再点一次撤销」，说明令牌立即作废）",
    "点「更换」输入管理员令牌、键盘弹出（手机全高 PiDialog = PiSheet keyboardOpen，按 §4.3 sheetLayout（pi/model/phoneDock.ts）贴可视视口：sheet 高 ≤ 508 − 47 − 24 = 437，「保存 / 取消」钉在键盘上沿，底部内边距 8，配对码、命令、设备列表在内容区内滚动；桌面无键盘，不变）",
    "relay 未声明 device.token（只显示不支持说明）",
  ],
  notes:
    "C05 G19。令牌已存、配对码有效（pair_create：8 位码按 formatPairCode 显示成 K7Q4-MX2P，剩 9:12）、等新设备出现；命令按 relay/devices.ts pairCommands（macOS / Linux：deploy/attach.sh --pair …；Windows：node deploy\\attach.cjs --pair …）。已登记设备 = MOCK_DEVICES。桌面 PiDialog 560 压暗，手机全高 sheet。推断：整块版式（Cursor 没有配对界面）。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dialog = (
    <PiDialog
      static
      title="设备与配对"
      viewport={viewport}
      width={560}
      footer={
        // 弹窗家族同一套底部按钮（shared PiButton，几何同 c/dialog-usage）
        <PiButton variant={variant} className={phone ? "w-full" : undefined}>
          完成
        </PiButton>
      }
    >
      <PiDevicePairing variant={variant} devices={MOCK_DEVICES} pair={A_PAIR} now={MOCK_NOW} />
    </PiDialog>
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <APhoneList footerPressed="settings" sheet={dialog} />
      ) : (
        <ADesktop selectedId="r-s1" dock={<ADock variant="desktop" />} overlay={dialog}>
          <ATranscript variant="desktop" />
        </ADesktop>
      )}
    </PiRoot>
  )
}
