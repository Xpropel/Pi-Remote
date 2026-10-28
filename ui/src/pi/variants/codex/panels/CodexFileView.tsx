import { useEffect, useState } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { fileErrorTextOf, fileImageSrcOf, fileKindOf, filePayloadOf, type PiFilePayload } from "@/pi/model/filePayload"
import { piBaseName, piBytes } from "../logic/view"
import { CodexCentered, CodexSpinner } from "../primitives/primitives"
import { codexHighlight } from "./CodexHighlight"

type State = { phase: "loading" } | { phase: "error"; error: string } | { phase: "ready"; payload: PiFilePayload }

/** 读文件（路径/会话变化重读；卸载后回包丢弃） */
function useFile(getFile: VariantAppProps["relay"]["getFile"], path: string | null, roomId: string): State & { retry: () => void } {
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<State>({ phase: "loading" })
  useEffect(() => {
    if (!path) return
    let alive = true
    setState({ phase: "loading" })
    getFile(path).then(
      (data) => {
        if (!alive) return
        const payload = filePayloadOf(data)
        setState(payload ? { phase: "ready", payload } : { phase: "error", error: "返回的文件数据不完整" })
      },
      (error) => {
        if (alive) setState({ phase: "error", error: fileErrorTextOf(error) })
      },
    )
    return () => {
      alive = false
    }
  }, [getFile, path, roomId, nonce])
  return { ...state, retry: () => setNonce((n) => n + 1) }
}

/** 文件视图（[X-图10④] / X-11-3）：打开文件行 + 文本/图片/二进制/截断；失败行「读取失败 · 重试」 */
export function CodexFileView({ p, path, onOpen }: { p: VariantAppProps; path: string | null; onOpen: (path: string) => void }) {
  const [draft, setDraft] = useState("")
  const view = useFile(p.relay.getFile, path, p.relay.roomId)
  return (
    <div className="cx-files" data-p4-surface="CX-PANEL-02" data-p4-ready="">
      <div className="cx-file-open">
        <input
          className="cx-file-open-input"
          value={draft}
          placeholder="打开文件…（路径）"
          aria-label="打开文件"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.trim()) onOpen(draft.trim())
          }}
        />
        <button type="button" className="cx-panel-action" onClick={() => draft.trim() && onOpen(draft.trim())}>
          打开
        </button>
      </div>
      {!path ? (
        <CodexCentered title="还没有打开文件" body="在对话里点文件名，或在上方输入路径" />
      ) : view.phase === "loading" ? (
        <CodexCentered spinner title="正在读取文件…" body={path} />
      ) : view.phase === "error" ? (
        <CodexCentered
          title="读取失败"
          body={
            <>
              {view.error} ·{" "}
              <button type="button" className="cx-inline-link" onClick={view.retry}>
                重试
              </button>
            </>
          }
        />
      ) : fileKindOf(view.payload) === "image" ? (
        <div className="cx-file-image">
          <img src={fileImageSrcOf(view.payload)} alt={path} />
        </div>
      ) : fileKindOf(view.payload) === "binary" ? (
        <CodexCentered title="二进制文件，不能预览" body={`${piBaseName(path)} · ${piBytes(view.payload.size ?? 0)}`} />
      ) : (
        <div className="cx-file-view">
          <div className="cx-file-view-head">
            <span className="cx-file-path">{path}</span>
            <span className="cx-file-meta">
              {piBytes(view.payload.size ?? 0)}
              {view.payload.truncated ? " · 只显示前 5 MB" : ""}
            </span>
          </div>
          <pre className="cx-file-code">
            {codexHighlight(view.payload.data ?? "").map((tokens, index) => (
              <div className="cx-file-line" key={index}>
                <span className="cx-file-ln" aria-hidden>
                  {index + 1}
                </span>
                <span className="cx-file-line-code">
                  {tokens.map((token, tokenIndex) => (
                    <span key={tokenIndex} className={token.tone === "plain" ? undefined : `cx-tok-${token.tone}`}>
                      {token.text}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </pre>
        </div>
      )}
      <CodexSpinner size={0} />
    </div>
  )
}
