const CODE_BLOCK_PLACEHOLDER = "Omitted code block."
const TABLE_PLACEHOLDER = "Omitted table."
const IMAGE_PLACEHOLDER = "Omitted image."
const INLINE_CODE_PLACEHOLDER = "Omitted inline code."
const TECHNICAL_PLACEHOLDER = "Omitted technical output."
const IDENTIFIER_PLACEHOLDER = "identifier omitted"

const FILE_EXTENSIONS = new Set([
  "cjs",
  "css",
  "go",
  "html",
  "js",
  "json",
  "jsx",
  "lock",
  "md",
  "mjs",
  "py",
  "rs",
  "sh",
  "toml",
  "ts",
  "tsx",
  "txt",
  "yaml",
  "yml",
])

const EXTENSION_NAMES: Record<string, string> = {
  cjs: "CommonJS",
  css: "CSS",
  go: "Go",
  html: "HTML",
  js: "JavaScript",
  json: "JSON",
  jsx: "JavaScript React",
  lock: "lock",
  md: "Markdown",
  mjs: "JavaScript module",
  py: "Python",
  rs: "Rust",
  sh: "shell",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TypeScript React",
  txt: "text",
  yaml: "YAML",
  yml: "YAML",
}

const FOLDER_NAMES: Record<string, string> = {
  ".config": "dot config",
  dist: "distribution",
  docs: "docs",
  lib: "library",
  node_modules: "node modules",
  scripts: "scripts",
  src: "source",
  test: "test",
  tests: "tests",
}

const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const LONG_HEX_PATTERN = /\b[0-9a-f]{32,}\b/gi
const PATH_PATTERN = /(^|[\s("'`])((?:~|\.{1,2}|\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)(?=$|[\s).,;:'"`])/g
const FILE_PATTERN = /(^|[\s("'`])([A-Za-z0-9_.-]+\.([A-Za-z0-9]+))(?=$|[\s).,;:'"`])/g

function normalizeSpeechText(text: string) {
  return text
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\t ]+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([,.!?;:])(?=[^\s\n])/g, "$1 ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\b(?:and|or)[,.!?;:]*\s*$/i, "")
    .trim()
}

function ensureSentence(text: string) {
  const next = text.trim()
  if (!next) return ""
  if (/[,;:]$/.test(next)) return `${next.slice(0, -1)}.`
  return /[.!?]$/.test(next) ? next : `${next}.`
}

function isCodeFenceLine(text: string) {
  return /^(```+|~~~+)/.test(text.trim())
}

function isHorizontalRule(text: string) {
  return /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(text)
}

function isTableSeparatorLine(text: string) {
  const trimmed = text.trim()
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false
  return /^\|?[\s:-]+(?:\|[\s:-]+)+\|?$/.test(trimmed)
}

function isPotentialTableRow(text: string) {
  const trimmed = text.trim()
  if (!trimmed.includes("|")) return false
  if (trimmed.startsWith("|") || trimmed.endsWith("|")) return true
  return (trimmed.match(/\|/g)?.length ?? 0) >= 2
}

function isDenseTechnicalLine(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/^at\s+\S+/.test(trimmed)) return true
  if (/^(@@|diff\s+--git|---\s+|\+\+\+\s+)/.test(trimmed)) return true
  if (/^[{}[\],:"'0-9A-Za-z_\s.-]+$/.test(trimmed) && /^[{[]/.test(trimmed) && /[}\]]$/.test(trimmed)) {
    const symbols = trimmed.match(/[{}[\],:"]/g)?.length ?? 0
    return trimmed.length > 40 && symbols / trimmed.length > 0.12
  }
  const symbols = trimmed.match(/[{}[\]<>|\\=;]/g)?.length ?? 0
  return trimmed.length > 100 && symbols / trimmed.length > 0.16
}

function humanizeName(value: string) {
  const leadingDot = value.startsWith(".")
  const base = leadingDot ? value.slice(1) : value
  const normalized = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\.+/g, " dot ")
    .replace(/\s+/g, " ")
    .trim()

  const spoken = normalized.toLowerCase() === "readme" ? "read me" : normalized
  return leadingDot ? `dot ${spoken}` : spoken
}

function humanizeFolder(value: string) {
  return FOLDER_NAMES[value] ?? humanizeName(value)
}

function describeFile(file: string) {
  const match = file.match(/^(.*)\.([A-Za-z0-9]+)$/)
  if (!match) return `file ${humanizeName(file)}`

  const [, rawName, rawExtension] = match
  const extension = rawExtension.toLowerCase()
  const fileType = EXTENSION_NAMES[extension] ?? `${humanizeName(extension)} file`
  const name = rawName ? humanizeName(rawName) : "unnamed"
  return `${fileType} file ${name}`
}

function describeFolders(folders: string[]) {
  const meaningful = folders.filter((part) => part !== ".")
  const visible = meaningful.length > 3 ? meaningful.slice(-3) : meaningful
  if (visible.length === 0) return "the current folder"
  if (visible.length === 1) return `the ${humanizeFolder(visible[0])} folder`
  return visible.map((folder) => `the ${humanizeFolder(folder)} folder`).join(", then ")
}

function speakPath(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^['"`(]+|[,'"`.)]+$/g, "")
  const parts = normalized.split("/").filter(Boolean)
  const last = parts.at(-1)
  if (!last) return "the current folder"

  const hasFile = /\.([A-Za-z0-9]+)$/.test(last)
  if (!hasFile) return describeFolders(parts)

  const folders = parts.slice(0, -1)
  const file = describeFile(last)
  return folders.length > 0 ? `the ${file} in ${describeFolders(folders)}` : `the ${file}`
}

function rewritePaths(text: string) {
  return text
    .replace(PATH_PATTERN, (_match, prefix: string, path: string) => `${prefix}${speakPath(path)}`)
    .replace(FILE_PATTERN, (match, prefix: string, file: string, extension: string) => {
      if (!FILE_EXTENSIONS.has(extension.toLowerCase())) return match
      return `${prefix}${speakPath(file)}`
    })
}

function looksLikePath(value: string) {
  if (value.includes("/")) return true
  const extension = value.match(/\.([A-Za-z0-9]+)$/)?.[1]
  return Boolean(extension && FILE_EXTENSIONS.has(extension.toLowerCase()))
}

function shouldOmitInlineCode(value: string) {
  if (value.length > 80) return true
  if (/\n/.test(value)) return true
  if (/^[A-Za-z_$][\w$.-]*$/.test(value)) return false
  if (looksLikePath(value)) return false
  if (/\b(?:bun|curl|docker|git|node|npm|pnpm|python|yarn)\b/.test(value) && /\s/.test(value)) return true
  return /[{}[\]<>|;&$]/.test(value) && /\s/.test(value)
}

function speakInlineCode(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ""
  if (shouldOmitInlineCode(trimmed)) return INLINE_CODE_PLACEHOLDER
  if (looksLikePath(trimmed)) return speakPath(trimmed)
  return humanizeName(trimmed.replace(/\$/g, ""))
}

function stripMarkdownEmphasis(text: string) {
  return text
    .replace(/\*\*\s*([^*\n]*?\S[^*\n]*?)\s*\*\*/g, "$1")
    .replace(/__\s*([^_\n]*?\S[^_\n]*?)\s*__/g, "$1")
    .replace(/~~\s*([^~\n]*?\S[^~\n]*?)\s*~~/g, "$1")
    .replace(/(^|\W)\*\s*([^*\n]*?\S[^*\n]*?)\s*\*(?=\W|$)/g, "$1$2")
    .replace(/(^|\W)_\s*([^_\n]*?\S[^_\n]*?)\s*_(?=\W|$)/g, "$1$2")
}

function replaceCommaSeparators(text: string) {
  return text.replace(/([.!?])?,\s+(?:(?:and|or)\s+)?/gi, (_match, punctuation: string | undefined) => {
    return punctuation ? `${punctuation} ` : ". "
  })
}

function sanitizeInline(text: string) {
  return replaceCommaSeparators(
    rewritePaths(
      stripMarkdownEmphasis(text)
        .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, (_match, alt: string) => alt.trim() || IMAGE_PLACEHOLDER)
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
        .replace(/<https?:\/\/[^>]+>/gi, " ")
        .replace(URL_PATTERN, " ")
        .replace(UUID_PATTERN, IDENTIFIER_PLACEHOLDER)
        .replace(LONG_HEX_PATTERN, IDENTIFIER_PLACEHOLDER)
        .replace(/`([^`\n]+)`/g, (_match, code: string) => speakInlineCode(code))
        .replace(/&/g, " and ")
        .replace(/(?:->|=>)/g, " to ")
        .replace(/[<>]/g, " ")
        .replace(/[`]/g, " "),
    ),
  )
}

function stripLinePrefixes(line: string) {
  let next = line.trim()

  while (/^>\s?/.test(next)) {
    next = next.replace(/^>\s?/, "").trimStart()
  }

  next = next.replace(/^\[![A-Za-z]+\]\s*/, "")
  next = next.replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, "")
  next = next.replace(/^\[[ xX]\]\s+/, "")
  return next
}

export class SpeechSanitizer {
  private buffer = ""
  private inCodeBlock = false
  private inTable = false
  private pendingTableHeader: string | undefined
  private atLineStart = true

  push(text: string, final = false) {
    this.buffer += text
    const output: string[] = []

    while (true) {
      if (this.inCodeBlock) {
        if (this.skipCodeBlock(final)) continue
        break
      }

      if (this.inTable) {
        const line = this.takeLine(final)
        if (line === undefined) break
        if (isPotentialTableRow(line) || !line.trim()) continue
        this.inTable = false
        output.push(this.processLine(line))
        continue
      }

      if (this.pendingTableHeader !== undefined) {
        const line = this.takeLine(final)
        if (line === undefined) break

        if (isTableSeparatorLine(line)) {
          output.push(TABLE_PLACEHOLDER)
          this.pendingTableHeader = undefined
          this.inTable = true
          continue
        }

        const header = this.pendingTableHeader
        this.pendingTableHeader = undefined
        output.push(this.processPlainLine(header, true), this.processLine(line))
        continue
      }

      const line = this.takeLine(final)
      if (line === undefined) {
        if (!final && this.buffer && !this.shouldHoldPartialLine()) {
          const partial = this.takePartialText()
          if (!partial) break
          output.push(sanitizeInline(partial))
          this.atLineStart = false
          continue
        }
        break
      }

      output.push(this.processLine(line))
    }

    if (final) {
      if (this.pendingTableHeader !== undefined) {
        output.push(this.processPlainLine(this.pendingTableHeader, true))
        this.pendingTableHeader = undefined
      }
      this.buffer = ""
      this.inCodeBlock = false
      this.inTable = false
      this.atLineStart = true
    }

    return normalizeSpeechText(output.filter(Boolean).join("\n"))
  }

  private takeLine(final: boolean) {
    const newline = this.buffer.indexOf("\n")
    if (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "")
      this.buffer = this.buffer.slice(newline + 1)
      this.atLineStart = true
      return line
    }

    if (!final || !this.buffer) return undefined
    const line = this.buffer.replace(/\r$/, "")
    this.buffer = ""
    this.atLineStart = true
    return line
  }

  private takePartialText() {
    const whitespace = this.buffer.search(/\s+\S*$/)
    const cut = whitespace >= 0 ? whitespace + (this.buffer.slice(whitespace).match(/^\s+/)?.[0].length ?? 0) : -1

    if (cut > 0) {
      const text = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut)
      return text
    }

    if (/[.!?;:]$/.test(this.buffer) || this.buffer.length > 240) {
      const text = this.buffer
      this.buffer = ""
      return text
    }

    return undefined
  }

  private skipCodeBlock(final: boolean) {
    const match = this.buffer.match(/(^|\n)[ \t]{0,3}(```+|~~~+)/)
    if (!match || match.index === undefined) {
      if (final) {
        this.buffer = ""
        this.inCodeBlock = false
        return true
      }

      const partialFence = this.buffer.match(/(^|\n)[ \t]{0,3}(`{1,2}|~{1,2})$/)
      this.buffer = partialFence ? partialFence[0].replace(/^\n/, "") : ""
      return false
    }

    const fenceStart = match.index + (match[1] ? match[1].length : 0)
    const lineEnd = this.buffer.indexOf("\n", fenceStart)
    this.buffer = lineEnd >= 0 ? this.buffer.slice(lineEnd + 1) : ""
    this.inCodeBlock = false
    this.atLineStart = true
    return true
  }

  private shouldHoldPartialLine() {
    if (!this.atLineStart) return false

    const trimmed = this.buffer.trimStart()
    if (!trimmed) return true
    if (/^(#{1,6}\s|>|[-*+]\s|\d{1,3}[.)]\s|```|~~~)/.test(trimmed)) return true
    if (/^(#{1,6}|[-*+]|\d{1,3}[.)]?|`{1,2}|~{1,2})$/.test(trimmed)) return true
    if (isPotentialTableRow(trimmed)) return true
    return false
  }

  private processLine(line: string) {
    const trimmed = line.trim()
    if (!trimmed) return ""

    if (isCodeFenceLine(trimmed)) {
      this.inCodeBlock = true
      return CODE_BLOCK_PLACEHOLDER
    }

    if (isPotentialTableRow(trimmed)) {
      this.pendingTableHeader = line
      return ""
    }

    return this.processPlainLine(line, true)
  }

  private processPlainLine(line: string, lineBreak = false) {
    const withoutPrefixes = stripLinePrefixes(line)
    if (!withoutPrefixes) return ""
    if (isHorizontalRule(withoutPrefixes)) return ""

    const heading = withoutPrefixes.match(/^#{1,6}\s+(.+?)\s*#*$/)
    if (heading) return ensureSentence(`Heading, ${sanitizeInline(heading[1])}`)

    if (isDenseTechnicalLine(withoutPrefixes)) return TECHNICAL_PLACEHOLDER
    const sanitized = sanitizeInline(withoutPrefixes)
    return lineBreak ? ensureSentence(sanitized) : sanitized
  }
}

export function createSpeechSanitizer() {
  return new SpeechSanitizer()
}

export function sanitizeSpeechText(text: string) {
  return createSpeechSanitizer().push(text, true)
}
