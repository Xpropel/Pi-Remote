/**
 * diff family 的数据形状（不是组件，不进 catalog）。
 * 依据：specs/ch3.md §1.2–§1.4、specs/ch1.md §6.3 D。
 */
import type { ReactNode } from "react"
import type { Forced } from "@/components/kit/types"

export type { Forced }

export type DiffLineKind = "context" | "add" | "del"

/**
 * 词级高亮范围：[起, 止) 字符下标，或一段子串（取该行里第一次出现的位置）。
 * 例：" with Python's http.server"（#10 卡 1 增行）、"design "（#10 卡 2 增行）。
 */
export type DiffMark = readonly [start: number, end: number] | string

export interface DiffLine {
  kind: DiffLineKind
  /**
   * 行号，只有一列：context / add 行写新文件行号，del 行写旧文件行号
   * （#15 "607 .join(' ');" 后紧跟 del 行 607/608/609，specs/ch3 §1.3）。InlineDiffCard 不显示行号。
   */
  n?: number | string
  /** 行文字，行首空格照写；不折行，超出卡右缘被截掉 */
  text: string
  /** 词级高亮（增行 --cw-diff-add-word，删行 --cw-diff-del-word） */
  marks?: readonly DiffMark[]
  /** "hover"：静态显示行号栏右端的蓝色 "+"（#15 第 126 行） */
  forced?: Forced
}

/**
 * 折叠条的两种样子（specs/ch3 §1.4）：
 * - handles：#14，高 36、左右内缩 10/9、左端 31 宽的浅色把手区放 ∨∧，文字 13px
 * - plain：#15，高 26、几乎通栏、没有把手，文字 12px
 */
export type UnmodifiedLinesBarVariant = "handles" | "plain"

/**
 * 把手区里的图标：
 * - down-up：上 chevron-down、下 chevron-up 两枚分开叠放（#14）
 * - up：单个 chevron-up（#5 "9 unmodified lines"，specs/ch1 §6.3）
 * - down：单个 chevron-down
 * - fold：lucide chevrons-down-up 一枚（#5 "8 unmodified lines"）
 */
export type UnmodifiedLinesHandle = "down-up" | "up" | "down" | "fold"

/** UnifiedDiff 里的一条折叠条（"N unmodified lines"） */
export interface DiffFold {
  kind: "fold"
  count: number
  /** 默认 "N unmodified lines" */
  label?: ReactNode
  variant?: UnmodifiedLinesBarVariant
  handle?: UnmodifiedLinesHandle
  forced?: Forced
  /** 按帧微调尺寸（例：#5 的条高 27 → "h-[27px] my-1"） */
  className?: string
}

export type DiffRow = DiffLine | DiffFold

/** 文件类型图标（FileTypeIcon，specs/ch3 §1.8） */
export type FileKind = "json" | "html" | "ts" | "tsx" | "txt" | "file"

/** PR 状态胶囊 */
export type PrStatus = "open" | "draft"
