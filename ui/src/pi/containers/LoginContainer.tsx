import { useState } from "react"
import { PiLoginCard } from "@/components/pi/shell"
import { PiPhonePage } from "@/components/pi/shared"
import { relayHostOf } from "@/pi/model/boot"
import type { PiContainerProps } from "./types"

/**
 * 登录（plan §7.1 login，a 线）：PiLoginCard + relay.login / authError；token 去空白后非空才能点"连接"（design §9.2）。
 * auth → auth_result；失败后 relay 清掉本地 token（4003）并写 authError，这里在输入框下红字说明。token 只在输入框和 relay.login 里，不进日志。
 * 脚注的 relay 地址口径同 useRelay 的 wsUrl（VITE_RELAY_URL > 同源 > 127.0.0.1:7002）。
 * 桌面：满屏居中（略偏上）；手机：PiPhonePage 里卡顶在安全区下 96。
 */
export function LoginContainer(props: PiContainerProps) {
  const { relay, variant } = props
  const host = relayHostOf(import.meta.env.VITE_RELAY_URL, location)
  const [value, setValue] = useState("")
  const card = (
    <PiLoginCard
      variant={variant}
      relayHost={host}
      state={relay.authError ? "error" : value.trim() ? "typing" : "empty"}
      value={value}
      onValueChange={setValue}
      onSubmit={() => relay.login(value)}
      // relay 的原话（"token 不正确"）+ 它已经做了的事（清掉本地 token）
      errorText={relay.authError ? `${relay.authError}，已清除这个浏览器里保存的 token` : undefined}
    />
  )
  if (variant === "phone") {
    return <PiPhonePage contentClassName="px-4 pt-24">{card}</PiPhonePage>
  }
  return <div className="absolute inset-0 flex items-center justify-center pb-20">{card}</div>
}
