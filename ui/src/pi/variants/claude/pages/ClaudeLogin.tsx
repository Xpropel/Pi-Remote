import { useState } from "react"
import { ArrowRight } from "lucide-react"
import { relayHostOf } from "@/pi/model/boot"
import type { PiContainerProps } from "@/pi/containers/types"
import { ClaudeMark } from "../primitives/ClaudePrimitives"

/**
 * 登录（C-12 / design-spec §5.1 推导）：暖纸居中卡、衬线字标 + 细环输入 + 陶土主按钮（墨字）+ relay 地址脚注。
 * 逻辑：relay.login / relay.authError（token 去空白后非空才能点）。
 */
export function ClaudeLogin({ p }: { p: PiContainerProps }) {
  const { relay } = p
  const [value, setValue] = useState("")
  const host = relayHostOf(import.meta.env.VITE_RELAY_URL, location)
  const ready = value.trim().length > 0
  const error = relay.authError ? `${relay.authError}，已清除这个浏览器里保存的 token` : ""
  return (
    <div data-pi-ui-part="page" className="claude-login">
      <form
        className="claude-login-card"
        aria-label="连接 Pi-Remote"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready) relay.login(value)
        }}
      >
        <ClaudeMark size={34} />
        <h1 className="claude-login-title">连接 Pi-Remote</h1>
        <p className="claude-login-note">输入查看端 token。token 只存在这个浏览器里。</p>
        <label className="claude-field">
          <span className="claude-field-label">查看端 token</span>
          <input
            className="claude-input"
            type="password"
            autoComplete="off"
            autoFocus
            value={value}
            placeholder="查看端 token"
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </label>
        {error ? (
          <p className="claude-login-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="claude-btn claude-btn-primary claude-login-submit" disabled={!ready}>
          连接
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <p className="claude-login-host">
          服务器 <span className="claude-mono">{host}</span>
        </p>
      </form>
    </div>
  )
}
