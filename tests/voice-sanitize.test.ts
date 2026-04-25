import { describe, expect, it } from "bun:test"
import { DEFAULT_CONFIG } from "../src/voice-constants.js"
import { createSpeechSanitizer, sanitizeSpeechText } from "../src/voice-sanitize.js"
import { drainStreamChunks, prepareSpeechText, splitPlaybackText } from "../src/voice-text.js"

describe("sanitizeSpeechText", () => {
  it("labels markdown headings", () => {
    expect(sanitizeSpeechText("## The plan")).toBe("Heading, The plan.")
  })

  it("labels all markdown heading levels", () => {
    expect(
      sanitizeSpeechText(["# One", "## Two", "### Three", "#### Four", "##### Five", "###### Six"].join("\n")),
    ).toBe("Heading, One.\nHeading, Two.\nHeading, Three.\nHeading, Four.\nHeading, Five.\nHeading, Six.")
  })

  it("omits fenced code blocks", () => {
    expect(sanitizeSpeechText("Before\n```ts\nconst value = 1\n```\nAfter")).toBe("Before.\nOmitted code block.\nAfter.")
  })

  it("omits markdown tables", () => {
    const text = "| Name | Value |\n| --- | --- |\n| voice | af_heart |\nDone"

    expect(sanitizeSpeechText(text)).toBe("Omitted table.\nDone.")
  })

  it("keeps link labels and removes raw urls", () => {
    expect(sanitizeSpeechText("See [docs](https://example.com/docs) and https://example.com/raw")).toBe("See docs")
  })

  it("rewrites file paths for speech", () => {
    expect(sanitizeSpeechText("Update src/voice-text.ts and README.md")).toBe(
      "Update the TypeScript file voice text in the source folder and the Markdown file read me.",
    )
  })

  it("turns line breaks into sentence boundaries", () => {
    expect(sanitizeSpeechText("First line\nSecond line")).toBe("First line.\nSecond line.")
  })
})

describe("SpeechSanitizer", () => {
  it("labels headings split across streaming deltas", () => {
    const sanitizer = createSpeechSanitizer()
    const chunks = [sanitizer.push("##", false), sanitizer.push(" Streaming heading", false), sanitizer.push("", true)].filter(
      Boolean,
    )

    expect(chunks.join(" ")).toBe("Heading, Streaming heading.")
  })

  it("omits streaming code blocks split across deltas", () => {
    const sanitizer = createSpeechSanitizer()
    const chunks = [
      sanitizer.push("Before\n```", false),
      sanitizer.push("\nconst value = 1\n", false),
      sanitizer.push("```\nAfter", true),
    ].filter(Boolean)

    expect(chunks.join("\n")).toBe("Before.\nOmitted code block.\nAfter.")
  })

  it("omits streaming tables split across deltas", () => {
    const sanitizer = createSpeechSanitizer()
    const chunks = [
      sanitizer.push("| Name | Value |\n", false),
      sanitizer.push("| --- | --- |\n| voice | af_heart |\n", false),
      sanitizer.push("Done", true),
    ].filter(Boolean)

    expect(chunks.join("\n")).toBe("Omitted table.\nDone.")
  })
})

describe("voice text pipeline", () => {
  it("prepares double hash headings before Kokoro receives text", () => {
    expect(prepareSpeechText("## Something", DEFAULT_CONFIG.maxTextLength)).toBe("Heading, Something.")
  })

  it("splits playback text after heading sanitization", () => {
    expect(splitPlaybackText("## Something", DEFAULT_CONFIG).map((chunk) => chunk.text)).toEqual(["Heading, Something."])
  })

  it("does not split streamed text on commas", () => {
    const config = { ...DEFAULT_CONFIG, streamSoftLimit: 12, speechChunkLength: 25 }
    const drained = drainStreamChunks("First, second third fourth.", config, false)

    expect(drained.chunks.map((chunk) => chunk.text)).toEqual([])
    expect(drained.rest).toBe("First, second third fourth.")
  })

  it("does not split streamed text on semicolons or colons", () => {
    const config = { ...DEFAULT_CONFIG, streamSoftLimit: 12, speechChunkLength: 60 }
    const drained = drainStreamChunks("First; second: third fourth", config, false)

    expect(drained.chunks.map((chunk) => chunk.text)).toEqual([])
    expect(drained.rest).toBe("First; second: third fourth")
  })

  it("uses sanitized newlines as playback split boundaries", () => {
    expect(splitPlaybackText("First line\nSecond line", DEFAULT_CONFIG).map((chunk) => chunk.text)).toEqual([
      "First line.",
      "Second line.",
    ])
  })
})
