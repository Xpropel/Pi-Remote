/**
 * 配对与 attach 的显示口径（P3.3 从 a/mock.ts 拆出：这些是界面逻辑，不是 mock）。
 * 和 ui/src/relay/devices.ts 的 formatPairCode / pairCommands / attachCommand / COPY.pairHint 同口径。
 */
/** 同 relay/devices.ts formatPairCode */
export function aFormatPairCode(code: string): string {
  const raw = code.replace(/[^0-9A-Za-z]/g, "").toUpperCase()
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

/** 同 relay/devices.ts pairCommands（macOS 和 Linux 共用 attach.sh） */
export function aPairCommands(code: string): { platform: "windows" | "unix"; label: string; command: string }[] {
  const shown = aFormatPairCode(code)
  return [
    { platform: "unix", label: "macOS / Linux", command: `deploy/attach.sh --pair ${shown}` },
    { platform: "windows", label: "Windows", command: `node deploy\\attach.cjs --pair ${shown}` },
  ]
}

/** 同 relay/devices.ts attachCommand：Mac / Linux 是 deploy/attach.sh，Windows 是 deploy\attach.cmd */
export function aAttachCommand(platform?: string | null): string {
  return platform === "windows" || platform === "win32" ? "deploy\\attach.cmd" : "deploy/attach.sh"
}

/** relay/devices.ts COPY.pairHint */
export const A_PAIR_HINT = "配对码 10 分钟内有效，只能用一次。配对成功后按提示重启 pi。"
