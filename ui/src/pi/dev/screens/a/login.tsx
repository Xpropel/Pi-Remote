import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiLoginCard } from "@/components/pi/shell"
import { MOCK_RELAY_HOST } from "@/pi/dev/fixtures/gallery/shared"
import { PiPhonePage, PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "login",
  area: "a",
  title: "登录",
  themes: ["light", "dark"],
  states: [
    "输入中（「连接」可点）",
    "token 错误（输入框下红字：token 不正确，已清除这个浏览器里保存的 token）",
    "连接中（按钮内 Spinner + 正在连接…）",
    "退出登录后回到本页",
    "手机键盘弹出时卡片上移到顶栏位置下方",
  ],
  notes:
    "A01、清单·品牌标志。本图 = 空表单，「连接」禁用（design §9.2：token 去空白后非空才可点）。推断：登录卡整体（Cursor 帧里没有登录页）、PiMark 单色 π 标、深色配色。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <PiPhonePage contentClassName="px-4 pt-24">
          <PiLoginCard variant="phone" relayHost={MOCK_RELAY_HOST} />
        </PiPhonePage>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center pb-20">
          <PiLoginCard variant="desktop" relayHost={MOCK_RELAY_HOST} />
        </div>
      )}
    </PiRoot>
  )
}
