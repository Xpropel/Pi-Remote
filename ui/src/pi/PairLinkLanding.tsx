import { useEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Check, KeyRound } from "@/components/kit/icons"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { ASectionLabel, ATextButton, ATokenInput } from "@/components/pi/shell/parts"
import { useNow } from "@/pi/hooks/useNow"
import { ADMIN_TOKEN_COPY, adminTokenReady, pairRemainText, platformLabel } from "@/relay/devices"
import {
  normalizePairCodeInput,
  pairLinkError,
  pairLinkExpired,
  type PairLookupInfo,
} from "@/relay/pairLink"
import type { Relay } from "@/relay/useRelay"

type Phase = "entry" | "lookup" | "confirm" | "success" | "expired" | "invalid"

/**
 * 二维码设备链接的手机落地页（qr-pairing §3.2）：与皮肤无关的单一轻量页，三套皮肤共用这一份。
 * 入口在 PiApp：启动时 takePairLinkFromLocation 命中 #pair= 才进这里（hash 已清掉）。
 * 流程：pair_lookup 查待链接设备 → 核对设备名 / 平台 / 核对字（relay 下发，只显示不计算）→
 * 管理员令牌确认 pair_approve，relay 才核销码、签发设备令牌并下发给 pi 运行端落盘。
 * 扫不了码的兜底也在本页：手输 8 位配对码走同一条 lookup / approve 路径（§6）。
 * 老流程（网页 pair_create 生成码 + attach --pair）不在这里，原样走配对对话框。
 */
export function PairLinkLanding({
  relay,
  initialCode,
  onExit,
  onShowDevices,
}: {
  relay: Relay
  /** 扫码带来的码（已规整）；null = 命中了入口但码不可用，先手输 */
  initialCode: string | null
  /** 退出落地页回主界面 */
  onExit: () => void
  /** 成功后去设备列表：回主界面并打开「设备与配对」 */
  onShowDevices: () => void
}) {
  const now = useNow(1000)
  const [code, setCode] = useState<string | null>(initialCode)
  const [phase, setPhase] = useState<Phase>(initialCode ? "lookup" : "entry")
  const [info, setInfo] = useState<PairLookupInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)
  const [lookupNonce, setLookupNonce] = useState(0)
  const [codeDraft, setCodeDraft] = useState("")
  const [codeError, setCodeError] = useState<string | null>(null)
  // 管理员令牌：与配对对话框同一 localStorage 口径（relay.adminToken / setAdminToken，只存本机）
  const [adminDraft, setAdminDraft] = useState("")
  const [adminEditing, setAdminEditing] = useState(false)
  const adminSaved = adminTokenReady(relay.adminToken)
  const adminReady = adminSaved && !adminEditing
  // 挂载时置回 true（同 PairingContainer 的 StrictMode 口径）
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const ranLookup = useRef("")

  // 已登录 + 有码 + 在 lookup 态：每个（码, nonce）只查一次。lookup 只查不核销，重查安全。
  useEffect(() => {
    if (!relay.authed || !code || phase !== "lookup") return
    const key = `${code}:${lookupNonce}`
    if (ranLookup.current === key) return
    ranLookup.current = key
    setError(null)
    relay.lookupPairLink(code).then(
      (next) => {
        if (!alive.current) return
        setInfo(next)
        setPhase(pairLinkExpired(next.expiresAt, Date.now()) ? "expired" : "confirm")
      },
      (e) => {
        if (!alive.current) return
        const mapped = pairLinkError(e)
        if (mapped.kind === "invalid") setPhase("invalid")
        else if (mapped.kind === "expired") setPhase("expired")
        else setError(mapped.text)
      },
    )
  }, [relay.authed, relay.lookupPairLink, code, phase, lookupNonce])

  // 确认页开着时码到期：立即换成过期态，不让用户对着一个已作废的码点确认
  useEffect(() => {
    if (phase === "confirm" && info && pairLinkExpired(info.expiresAt, now)) setPhase("expired")
  }, [phase, info, now])

  const submitCode = () => {
    const next = normalizePairCodeInput(codeDraft)
    if (!next) {
      setCodeError("配对码是 8 位字母和数字，请照电脑上的显示核对")
      return
    }
    setCodeError(null)
    setError(null)
    setInfo(null)
    setCode(next)
    setCodeDraft("")
    setLookupNonce((n) => n + 1)
    setPhase("lookup")
  }

  const approve = async () => {
    if (!code || approving || !adminReady) return
    setApproving(true)
    setError(null)
    try {
      await relay.approvePairLink(code, relay.adminToken)
      if (alive.current) setPhase("success")
    } catch (e) {
      if (!alive.current) return
      const mapped = pairLinkError(e)
      if (mapped.kind === "expired") setPhase("expired")
      else if (mapped.kind === "invalid") setPhase("invalid")
      else {
        setError(mapped.text)
        // 本地存的管理员令牌被 relay 拒了：摊开输入框重输，存好才能再点确认
        if (mapped.kind === "admin") {
          setAdminDraft("")
          setAdminEditing(true)
        }
      }
    } finally {
      if (alive.current) setApproving(false)
    }
  }

  const deviceName = info?.name || "未命名设备"

  return (
    <main className="flex min-h-dvh items-center justify-center bg-(--cw-bg) px-4 py-10">
      <div className="flex w-full max-w-[420px] flex-col rounded-(--cw-radius-card) border border-solid border-(--cw-border) bg-(--cw-surface) p-5 sm:p-6">
        <p className="m-0 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">Pi-Remote</p>
        <h1 className="mt-1 mb-0 text-(length:--cw-text-xl) leading-(--cw-leading-tight) font-semibold text-(--cw-text)">链接新设备</h1>

        {!relay.authed ? (
          <LoginSection relay={relay} onExit={onExit} />
        ) : phase === "lookup" ? (
          <section className="mt-4 flex flex-col gap-3">
            {error ? (
              <>
                <p role="alert" className="m-0 text-(length:--cw-text-md) leading-[20px] text-(--cw-pi-error)">
                  {error}
                </p>
                <PrimaryButton
                  onClick={() => {
                    setError(null)
                    setLookupNonce((n) => n + 1)
                  }}
                >
                  重试
                </PrimaryButton>
                <div className="flex items-center justify-between">
                  <ATextButton tone="link" onClick={() => setPhase("entry")}>
                    手输配对码
                  </ATextButton>
                  <ATextButton onClick={onExit}>返回</ATextButton>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 text-(length:--cw-text-md) text-(--cw-pi-text-secondary)">
                <PiSpinner size={14} tone="muted" label="正在确认这台设备" />
                正在确认这台设备…
              </div>
            )}
          </section>
        ) : phase === "confirm" && info ? (
          <section className="mt-4 flex flex-col">
            <ASectionLabel className="mb-2">有台设备在等你确认</ASectionLabel>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-(length:--cw-text-lg) leading-(--cw-leading-tight) font-medium text-(--cw-text)">{deviceName}</span>
              <span className="mt-0.5 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">
                {platformLabel(info.platform) || "未知平台"} · {pairRemainText(info.expiresAt - now)} 后过期
              </span>
            </div>

            <div className="mt-4 flex flex-col items-center gap-1 rounded-(--cw-radius-card) bg-(--cw-code-bg) px-4 py-3">
              <span className="text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">核对字</span>
              <span className="font-mono text-[36px] leading-[42px] font-semibold text-(--cw-text)">{info.checkDigits.split("").join(" ")}</span>
              <span className="text-center text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">
                请和电脑屏幕上显示的核对字对一对：两边一致再确认，对不上就不要确认。
              </span>
            </div>

            <p className="mt-4 mb-0 text-(length:--cw-text-md) leading-[20px] text-(--cw-text-2)">
              确认后，这台设备会获得设备令牌，出现在你的设备名册里，之后可以连接你的 pi 会话。你随时可以在「设备与配对」里撤销它。
            </p>
            <p className="mt-2 mb-0 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">
              只链接你自己正在出示二维码的这台设备。
            </p>

            <div aria-hidden className="my-4 h-px bg-(--cw-divider-soft)" />
            <ASectionLabel className="mb-2">管理员令牌</ASectionLabel>
            {adminEditing || !adminSaved ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <ATokenInput
                    label="管理员令牌"
                    placeholder="输入管理员令牌"
                    value={adminDraft}
                    onValueChange={setAdminDraft}
                    revealLabel="显示令牌"
                    autoComplete="off"
                    className="min-w-0 flex-1"
                  />
                  <ATextButton
                    tone="link"
                    disabled={!adminTokenReady(adminDraft)}
                    onClick={() => {
                      relay.setAdminToken(adminDraft.trim())
                      setAdminDraft("")
                      setAdminEditing(false)
                    }}
                  >
                    保存
                  </ATextButton>
                  {adminSaved ? (
                    <ATextButton
                      onClick={() => {
                        setAdminDraft("")
                        setAdminEditing(false)
                      }}
                    >
                      取消
                    </ATextButton>
                  ) : null}
                </div>
                <p className="m-0 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">
                  {ADMIN_TOKEN_COPY.hint}
                  {adminSaved ? "" : ` ${ADMIN_TOKEN_COPY.required}。`}
                </p>
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-2 text-(length:--cw-text-md) text-(--cw-text-2)">
                <KeyRound aria-hidden size={14} strokeWidth={1.5} className="shrink-0 text-(--cw-text-3)" />
                <span className="min-w-0 truncate">已保存在这个浏览器</span>
                <span aria-hidden className="text-(--cw-text-4)">·</span>
                <ATextButton
                  tone="link"
                  className="-ml-1"
                  onClick={() => {
                    setAdminDraft("")
                    setAdminEditing(true)
                  }}
                >
                  更换
                </ATextButton>
              </div>
            )}

            {error ? (
              <p role="alert" className="mt-3 mb-0 text-(length:--cw-text-md) leading-[18px] text-(--cw-pi-error)">
                {error}
              </p>
            ) : null}

            <PrimaryButton disabled={!adminReady || approving} onClick={() => void approve()} className="mt-4">
              {approving ? "正在链接…" : "确认链接"}
            </PrimaryButton>
            <div className="mt-2 flex items-center justify-between">
              <ATextButton onClick={onExit}>不是这台设备</ATextButton>
              <ATextButton
                tone="link"
                onClick={() => {
                  setError(null)
                  setPhase("entry")
                }}
              >
                手输配对码
              </ATextButton>
            </div>
          </section>
        ) : phase === "success" ? (
          <section className="mt-4 flex flex-col gap-2">
            <div role="status" className="flex items-center gap-1.5 text-(length:--cw-text-lg) font-medium text-(--cw-text)">
              <Check aria-hidden size={18} strokeWidth={2} className="text-(--cw-green)" />
              已链接
            </div>
            <p className="m-0 text-(length:--cw-text-md) leading-[20px] text-(--cw-text-2)">
              「{deviceName}」已获得设备令牌并加入设备名册。电脑端会自动完成保存，回到电脑前就能用了。
            </p>
            <PrimaryButton onClick={onShowDevices} className="mt-2">
              查看设备列表
            </PrimaryButton>
            <ATextButton onClick={onExit} className="self-center">
              完成
            </ATextButton>
          </section>
        ) : phase === "expired" ? (
          <section className="mt-4 flex flex-col">
            <h2 className="m-0 text-(length:--cw-text-lg) font-medium text-(--cw-text)">这个链接已过期</h2>
            <p className="mt-2 mb-0 text-(length:--cw-text-md) leading-[20px] text-(--cw-text-2)">
              配对码 10 分钟内有效，过期就作废。回到电脑上重新运行 attach --link 出示新码再扫一次；新码出来后，也可以直接在下面输入。
            </p>
            <CodeEntry draft={codeDraft} error={codeError} onChange={setCodeDraft} onSubmit={submitCode} />
            <ATextButton onClick={onExit} className="mt-2 self-start">
              返回
            </ATextButton>
          </section>
        ) : phase === "invalid" ? (
          <section className="mt-4 flex flex-col">
            <h2 className="m-0 text-(length:--cw-text-lg) font-medium text-(--cw-text)">这个链接无效</h2>
            <p className="mt-2 mb-0 text-(length:--cw-text-md) leading-[20px] text-(--cw-text-2)">
              它可能已经被用过，或者电脑端已经关掉了出示窗口。回电脑上重新出示后，再扫一次或在下面输码。
            </p>
            <CodeEntry draft={codeDraft} error={codeError} onChange={setCodeDraft} onSubmit={submitCode} />
            <ATextButton onClick={onExit} className="mt-2 self-start">
              返回
            </ATextButton>
          </section>
        ) : (
          <section className="mt-4 flex flex-col">
            <p className="m-0 text-(length:--cw-text-md) leading-[20px] text-(--cw-text-2)">
              在电脑上运行 attach --link，它会出示二维码和 8 位配对码。扫码会自动把码带进来；手动打开这一页时，在下面输那 8 位码，效果一样。
            </p>
            <CodeEntry draft={codeDraft} error={codeError} onChange={setCodeDraft} onSubmit={submitCode} />
            <ATextButton onClick={onExit} className="mt-2 self-start">
              返回
            </ATextButton>
          </section>
        )}
      </div>
    </main>
  )
}

function PrimaryButton({
  children,
  disabled,
  onClick,
  className,
}: {
  children: ReactNode
  disabled?: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-11 w-full items-center justify-center rounded-(--cw-radius-button) bg-(--cw-primary) px-4 text-(length:--cw-text-md) font-medium text-(--cw-primary-fg) hover:bg-(--cw-primary)/85 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  )
}

/** 手输配对码（兜底，§6）：扫不了码时输 8 位码，和扫码走同一条 lookup / approve 路径。 */
function CodeEntry({
  draft,
  error,
  onChange,
  onSubmit,
}: {
  draft: string
  error: string | null
  onChange: (value: string) => void
  onSubmit: () => void
}) {
  return (
    <form
      className="mt-4 flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <ASectionLabel>配对码</ASectionLabel>
      <div className="flex min-w-0 items-center gap-2">
        <input
          type="text"
          aria-label="配对码"
          placeholder="XXXX-XXXX"
          value={draft}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-11 min-w-0 flex-1 rounded-(--cw-radius-button) border border-solid border-(--cw-border) bg-(--cw-surface) px-3 font-mono text-[17px] tracking-[0.08em] text-(--cw-text) outline-none placeholder:text-(--cw-text-4) focus:border-(--cw-pi-field-focus-border)"
        />
        <ATextButton tone="link" type="submit" disabled={!draft.trim()}>
          继续
        </ATextButton>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-error)">
          {error}
        </p>
      ) : null}
    </form>
  )
}

/**
 * 还没登录时的落地页：先用 viewer 令牌登录这个中转站（和平时打开 Pi-Remote 同一个令牌、同一 localStorage 口径），
 * 登录成功后上面的 lookup 流程自动接着走，码不丢（只存在内存里，hash 已清）。
 */
function LoginSection({ relay, onExit }: { relay: Relay; onExit: () => void }) {
  const [draft, setDraft] = useState("")
  const showForm = !relay.token || !!relay.authError
  return (
    <section className="mt-4 flex flex-col gap-3">
      {showForm ? (
        <>
          <p className="m-0 text-(length:--cw-text-md) leading-[20px] text-(--cw-text-2)">
            扫码链接前，先用 viewer 令牌登录这个中转站（和平时打开 Pi-Remote 用的是同一个）。
          </p>
          <div className="flex min-w-0 items-center gap-2">
            <ATokenInput
              label="viewer 令牌"
              placeholder="输入 viewer 令牌"
              value={draft}
              onValueChange={setDraft}
              revealLabel="显示令牌"
              autoComplete="off"
              className="min-w-0 flex-1"
            />
            <ATextButton tone="link" disabled={!draft.trim()} onClick={() => relay.login(draft)}>
              登录
            </ATextButton>
          </div>
          {relay.authError ? (
            <p role="alert" className="m-0 text-(length:--cw-text-md) leading-[18px] text-(--cw-pi-error)">
              {relay.authError}
            </p>
          ) : null}
        </>
      ) : (
        <div className="flex items-center gap-2 text-(length:--cw-text-md) text-(--cw-pi-text-secondary)">
          <PiSpinner size={14} tone="muted" label="正在连接" />
          正在连接…{relay.status && relay.status !== "未连接" ? `（${relay.status}）` : ""}
        </div>
      )}
      <ATextButton onClick={onExit} className="self-start">
        返回
      </ATextButton>
    </section>
  )
}
