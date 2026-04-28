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
      "Update the voice text TypeScript file in the src folder and the read me Markdown file.",
    )
  })

  it("reads ambiguous slash text literally", () => {
    expect(sanitizeSpeechText("Use task/issue and api/backoffice-v1/dashboard")).toBe(
      "Use task slash issue and api slash backoffice-v1 slash dashboard.",
    )
  })

  it("reads route-looking slash text literally", () => {
    expect(sanitizeSpeechText("Call /api/users or GET /api/users.json")).toBe(
      "Call slash api slash users or GET slash api slash users.json.",
    )
  })

  it("speaks concise file and folder paths", () => {
    expect(sanitizeSpeechText("Open src/api/items/Article.ts, dist/tui-plugin.js, and ./src/api")).toBe(
      "Open the Article TypeScript file in the items folder. the tui plugin JavaScript file in the dist folder. the api folder.",
    )
  })

  it("preserves literal folder names and file casing", () => {
    expect(sanitizeSpeechText("Use ./src and src/api/items/Article.ts")).toBe(
      "Use the src folder and the Article TypeScript file in the items folder.",
    )
  })

  it("recognizes common modern file extensions", () => {
    expect(sanitizeSpeechText("Edit components/App.vue, icon.svg, and image.png")).toBe(
      "Edit the App Vue file in the components folder. the icon SVG image file. the image PNG image file.",
    )
  })

  it("uses configured file extensions", () => {
    expect(sanitizeSpeechText("Open project/widget.foo and README.md", { fileExtensions: ["foo"] })).toBe(
      "Open the widget foo file in the project folder and the read me Markdown file.",
    )
  })

  it("reads unknown standalone extensions literally", () => {
    expect(sanitizeSpeechText("Open widget.foo and assets/icon.foo")).toBe(
      "Open widget.foo and the icon foo file in the assets folder.",
    )
  })

  it("sanitizes slash phrases inside inline code and markdown link labels", () => {
    expect(sanitizeSpeechText("See `task/issue` and [api/users](https://example.com)")).toBe(
      "See task slash issue and api slash users.",
    )
  })

  it("supports Windows style paths", () => {
    expect(sanitizeSpeechText("Open C:\\repo\\src\\Article.ts")).toBe("Open the Article TypeScript file in the src folder.")
  })

  it("turns line breaks into sentence boundaries", () => {
    expect(sanitizeSpeechText("First line\nSecond line")).toBe("First line.\nSecond line.")
  })

  it("converts comma separated prose to period separated speech", () => {
    expect(sanitizeSpeechText("One, two, and three")).toBe("One. two. three.")
  })

  it("strips spaced emphasis markers", () => {
    expect(sanitizeSpeechText("This has ** bold text ** and * italic text *")).toBe(
      "This has bold text and italic text.",
    )
  })

  it("sanitizes a broad markdown sample", () => {
    const markdown = `# 1. Main Heading

## 2. Subheading

### 3. Smaller Heading

This paragraph has ** bold text **, * italic text *, \`inline code\`, and a [link to example](https://example.com).

> This is a blockquote.
>
> It spans multiple lines.

- Bullet item one
- Bullet item two with \`src/voice-text.ts\`
  - Nested bullet item
  - Nested bullet item with **bold** and *italic*

1. Numbered item one
2. Numbered item two
3. Numbered item three

- [x] Completed task
- [ ] Pending task

---

| Name | Value | Notes |
| --- | --- | --- |
| voice | Kokoro | TTS engine |
| file | \`src/voice-controller.ts\` | local source |
| path | \`/home/semir/workspace/opencode-voice-tts/src/voice-text.ts\` | absolute path |

\`\`\`ts
function demo(value: string) {
  return \`Heading: \${value}\`
}

console.log(demo("example"))
\`\`\`

Inline technical text: \`npm run build\`, \`voice-sanitize.ts\`, and \`dist/tui-plugin.js\`.

![Alt text for image](https://example.com/image.png)

---

## 4. Another Heading

Some final text with a [relative path reference](./README.md) and a URL: https://opencode.ai/docs/plugins/`

    expect(sanitizeSpeechText(markdown)).toBe(
      [
        "Heading, 1. Main Heading.",
        "Heading, 2. Subheading.",
        "Heading, 3. Smaller Heading.",
        "This paragraph has bold text. italic text. inline code. a link to example.",
        "This is a blockquote.",
        "It spans multiple lines.",
        "Bullet item one.",
        "Bullet item two with the voice text TypeScript file in the src folder.",
        "Nested bullet item.",
        "Nested bullet item with bold and italic.",
        "Numbered item one.",
        "Numbered item two.",
        "Numbered item three.",
        "Completed task.",
        "Pending task.",
        "Omitted table.",
        "Omitted code block.",
        "Inline technical text: Omitted inline code. the voice sanitize TypeScript file. the tui plugin JavaScript file in the dist folder.",
        "Alt text for image.",
        "Heading, 4. Another Heading.",
        "Some final text with a relative path reference and a URL.",
      ].join("\n"),
    )
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

  it("applies slash and path rules while streaming", () => {
    const sanitizer = createSpeechSanitizer()
    const chunks = [sanitizer.push("Use task/", false), sanitizer.push("issue and src/api/items/Article.ts", true)].filter(Boolean)

    expect(chunks.join(" ")).toBe("Use task slash issue and the Article TypeScript file in the items folder.")
  })
})

describe("voice text pipeline", () => {
  it("prepares double hash headings before Kokoro receives text", () => {
    expect(prepareSpeechText("## Something", DEFAULT_CONFIG.maxSpeechChars)).toBe("Heading, Something.")
  })

  it("prepares playback text with configured extensions", () => {
    expect(prepareSpeechText("Open app/widget.foo", DEFAULT_CONFIG.maxSpeechChars, { fileExtensions: ["foo"] })).toBe(
      "Open the widget foo file in the app folder.",
    )
  })

  it("splits playback text after heading sanitization", () => {
    expect(splitPlaybackText("## Something", DEFAULT_CONFIG).map((chunk) => chunk.text)).toEqual(["Heading, Something."])
  })

  it("does not split streamed text on commas", () => {
    const config = { ...DEFAULT_CONFIG, streamFlushChars: 12, maxSpeechChunkChars: 25 }
    const drained = drainStreamChunks("First, second third fourth.", config, false)

    expect(drained.chunks.map((chunk) => chunk.text)).toEqual([])
    expect(drained.rest).toBe("First, second third fourth.")
  })

  it("does not split streamed text on semicolons or colons", () => {
    const config = { ...DEFAULT_CONFIG, streamFlushChars: 12, maxSpeechChunkChars: 60 }
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
