import { EN } from "./en.ts"
import { getLanguage, type Language } from "./locale.ts"
export { getLanguage } from "./locale.ts"

/** Exact source copy and recognized approval labels only; never free-form user/session text. */
export function translate(source: string, values: readonly unknown[] = [], language: Language = getLanguage()): string {
  let message = source
  if (language === "en") {
    if (Object.hasOwn(EN, source)) message = EN[source]
    else if (Object.hasOwn(EN, source.trim())) {
      message = (source.match(/^\s+/)?.[0] ?? "") + EN[source.trim()] + (source.match(/\s+$/)?.[0] ?? "")
    }
  }
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const position = Number(index)
    return position < values.length ? String(values[position]) : placeholder
  })
}

/** Tagged templates preserve evaluation order and keep values out of the catalog. */
export function template(parts: TemplateStringsArray, ...values: unknown[]): string {
  const source = parts.reduce((message, part, index) => message + (index ? `{${index - 1}}` : "") + part, "")
  return translate(source, values)
}
