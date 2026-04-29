import { describe, expect, it } from "bun:test"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import type { QueueTrace } from "../../src/playback/queue.js"
import { QuestionController } from "../../src/session/question-controller.js"
import { DEFAULT_CONFIG } from "../../src/voice-constants.js"
import type { VoiceConfig, VoiceState } from "../../src/voice-types.js"

type Handler = (event: { properties: unknown }) => void

type EnqueuedChunk = {
  text: string
  pauseMs: number
  source: string
  trace?: QueueTrace
}

function createRequest(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: "request-1",
    sessionID: "session-1",
    questions: [
      {
        question: "Should question prompts be spoken?",
        header: "Speak prompts",
        options: [{ label: "Yes", description: "Speak them" }],
      },
    ],
    ...overrides,
  }
}

function createHarness(options: {
  config?: Partial<VoiceConfig>
  state?: Partial<VoiceState>
  route?: { name: string; params?: Record<string, unknown> }
  parentID?: string
} = {}) {
  const handlers = new Map<string, Handler>()
  const enqueued: EnqueuedChunk[] = []
  const api = {
    event: {
      on(name: string, handler: Handler) {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
    },
    route: {
      current: options.route ?? { name: "session", params: { sessionID: "session-1" } },
    },
  }
  const state = {
    snapshot: () => ({
      enabled: true,
      paused: false,
      busy: false,
      generating: false,
      playing: false,
      backend: "auto",
      device: "auto",
      ...options.state,
    }),
  }
  const playback = {
    enqueuePreparedChunk(text: string, pauseMs: number, source: string, trace?: QueueTrace) {
      enqueued.push({ text, pauseMs, source, trace })
      return 1
    },
  }
  const sessionStore = {
    sessionParentID: async () => options.parentID,
  }
  const controller = new QuestionController(
    api as never,
    { ...DEFAULT_CONFIG, ...options.config },
    state as never,
    playback as never,
    sessionStore as never,
  )

  return {
    controller,
    enqueued,
    async ask(request = createRequest()) {
      handlers.get("question.asked")?.({ properties: request })
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe("QuestionController", () => {
  it("speaks an active-session question when enabled", async () => {
    const harness = createHarness()

    await harness.ask()

    expect(harness.enqueued).toHaveLength(1)
    expect(harness.enqueued[0]?.text).toBe("Should question prompts be spoken?")
    expect(harness.enqueued[0]?.source).toBe("question")
    expect(harness.enqueued[0]?.trace).toMatchObject({
      origin: "question.asked",
      sessionID: "session-1",
      requestID: "request-1",
      questionIndex: 0,
      questionCount: 1,
    })
  })

  it("does not speak when question speech is disabled", async () => {
    const harness = createHarness({ config: { speakQuestions: false } })

    await harness.ask()

    expect(harness.enqueued).toHaveLength(0)
  })

  it("does not speak when global speech is disabled", async () => {
    const harness = createHarness({ state: { enabled: false } })

    await harness.ask()

    expect(harness.enqueued).toHaveLength(0)
  })

  it("does not speak when playback is paused", async () => {
    const harness = createHarness({ state: { paused: true } })

    await harness.ask()
    expect(harness.enqueued).toHaveLength(0)
  })

  it("does not speak outside the matching active session route", async () => {
    const home = createHarness({ route: { name: "home" } })
    const otherSession = createHarness({ route: { name: "session", params: { sessionID: "session-2" } } })

    await home.ask()
    await otherSession.ask()

    expect(home.enqueued).toHaveLength(0)
    expect(otherSession.enqueued).toHaveLength(0)
  })

  it("does not speak subagent questions", async () => {
    const harness = createHarness({ parentID: "parent-session" })

    await harness.ask()

    expect(harness.enqueued).toHaveLength(0)
  })

  it("does not enqueue duplicate speech for the same request", async () => {
    const harness = createHarness()
    const request = createRequest()

    await harness.ask(request)
    await harness.ask(request)

    expect(harness.enqueued).toHaveLength(1)
  })

  it("uses only question text and omits headers and options", async () => {
    const harness = createHarness()

    await harness.ask()

    expect(harness.enqueued.map((item) => item.text).join("\n")).toBe("Should question prompts be spoken?")
  })

  it("speaks only the first question from multi-question requests", async () => {
    const harness = createHarness()

    await harness.ask(
      createRequest({
        questions: [
          { question: "First question?", header: "First", options: [] },
          { question: "Second question?", header: "Second", options: [] },
        ],
      }),
    )

    expect(harness.enqueued.map((item) => item.text)).toEqual(["First question?"])
    expect(harness.enqueued.map((item) => item.trace?.questionIndex)).toEqual([0])
    expect(harness.enqueued[0]?.trace?.questionCount).toBe(2)
  })

  it("unsubscribes when disposed", async () => {
    const harness = createHarness()
    harness.controller.dispose()

    await harness.ask()

    expect(harness.enqueued).toHaveLength(0)
  })
})
