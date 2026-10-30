import { createContext, useContext } from "react"
import { dataUrlFor } from "@/conversation/remoteImage"
import type { PiAssistantItem, PiImagePart, PiUserItem } from "@/components/pi/shared/types"

/*
 * 对话流里各处点击的去处（P5.4，可交互态）：PiTranscript 收到 actions prop 后放进这个 context，
 * 叶子部件（PiProse 的文件 chip、用户卡的"重试"、操作行、过大图占位、回合出错的"重新回答"）各取所需。
 * 静态态（画廊）不传 actions：叶子部件拿到 null，不挂任何回调，DOM 和冻结版一样。部件不认识 relay（D10），回调由容器给。
 */

/** 一张图的按需加载状态（get_image；口径同 conversation/remoteImage.ts 的 RemoteImageState） */
export type PiImageLoad = {
  phase: "idle" | "loading" | "ready" | "compressed" | "error"
  /** ready 时的 data URL */
  src?: string
  /** compressed / error 的说明 */
  error?: string
}

export interface PiTranscriptActions {
  /** 正文里的文件（FileChip / 像路径的行内代码）：打开文件视图 */
  openFile?: (path: string) => void
  /** 用户卡"发送失败 · 重试" */
  retrySend?: (item: PiUserItem) => void
  /** Queued-bubble actions (F4): the item is a remote-queue entry still
   *  waiting to be injected (item.queued / item.queueId). Send-now and
   *  cancel act on the queue entry directly; edit opens the queue panel,
   *  whose editor owns the full-text fetch and conflict handling. */
  queueSendNow?: (item: PiUserItem) => void
  queueCancel?: (item: PiUserItem) => void
  queueEdit?: (item: PiUserItem) => void
  /** 回合出错的"重新回答"、操作行的 ↻ */
  regenerate?: () => void
  /** 操作行的"复制回复"：resolve true = 已复制（✓ 1.2 秒） */
  copyReply?: (item: PiAssistantItem) => Promise<boolean>
  /** 过大占位块的"加载原图" / 失败后的"重试" */
  loadImage?: (image: PiImagePart) => void
  /** 某张图的按需加载状态；没有加载过返回 undefined */
  imageLoad?: (image: PiImagePart) => PiImageLoad | undefined
}

export const PiTranscriptActionsContext = createContext<PiTranscriptActions | null>(null)

/** 叶子部件取回调；静态态 / 不在对话流里时是 null */
export function usePiTranscriptActions(): PiTranscriptActions | null {
  return useContext(PiTranscriptActionsContext)
}

/** 这张图能直接显示的地址：随消息带了像素（data）就用它；过大没传的图按需取到原图后用取回来的；都没有（mock 的中性占位）返回 undefined */
export function piImageSrcOf(image: PiImagePart, loaded?: PiImageLoad): string | undefined {
  if (image.data) return dataUrlFor(image.mimeType, image.data)
  return loaded?.phase === "ready" ? loaded.src : undefined
}
