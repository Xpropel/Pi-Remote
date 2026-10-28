/** 错误行（[X-图10⑤] 语言：失败明写原因 + Retry，不装作没事） */
export function CodexErrorPart({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="cx-turn-error" role="alert">
      <span>{text}</span>
      {onRetry ? (
        <button type="button" className="cx-inline-link" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  )
}
