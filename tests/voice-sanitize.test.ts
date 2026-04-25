import { describe, expect, it } from "bun:test"
import { createSpeechSanitizer, sanitizeSpeechText } from "../src/voice-sanitize.js"

describe("sanitizeSpeechText", () => {
  it("labels markdown headings", () => {
    expect(sanitizeSpeechText("## The plan")).toBe("Heading, The plan.")
  })

  it("omits fenced code blocks", () => {
    expect(sanitizeSpeechText("Before\n```ts\nconst value = 1\n```\nAfter")).toBe("Before Omitted code block. After")
  })

  it("omits markdown tables", () => {
    const text = "| Name | Value |\n| --- | --- |\n| voice | af_heart |\nDone"

    expect(sanitizeSpeechText(text)).toBe("Omitted table. Done")
  })

  it("keeps link labels and removes raw urls", () => {
    expect(sanitizeSpeechText("See [docs](https://example.com/docs) and https://example.com/raw")).toBe("See docs")
  })

  it("rewrites file paths for speech", () => {
    expect(sanitizeSpeechText("Update src/voice-text.ts and README.md")).toBe(
      "Update the TypeScript file voice text in the source folder and the Markdown file read me",
    )
  })
})

describe("SpeechSanitizer", () => {
  it("omits streaming code blocks split across deltas", () => {
    const sanitizer = createSpeechSanitizer()
    const chunks = [
      sanitizer.push("Before\n```", false),
      sanitizer.push("\nconst value = 1\n", false),
      sanitizer.push("```\nAfter", true),
    ].filter(Boolean)

    expect(chunks.join(" ")).toBe("Before Omitted code block. After")
  })

  it("omits streaming tables split across deltas", () => {
    const sanitizer = createSpeechSanitizer()
    const chunks = [
      sanitizer.push("| Name | Value |\n", false),
      sanitizer.push("| --- | --- |\n| voice | af_heart |\n", false),
      sanitizer.push("Done", true),
    ].filter(Boolean)

    expect(chunks.join(" ")).toBe("Omitted table. Done")
  })
})
