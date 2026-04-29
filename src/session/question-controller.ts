import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import type { PlaybackPipeline } from "../playback/playback-pipeline.js"
import { activeSessionID, formatError } from "../shared/voice-utils.js"
import type { VoiceStateStore } from "../state/voice-state-store.js"
import { splitPlaybackText } from "../voice-text.js"
import type { VoiceConfig } from "../voice-types.js"
import { createLogger } from "../voice-log.js"
import type { SessionStore } from "./session-store.js"

export class QuestionController {
  private readonly log = createLogger("question")
  private readonly cleanup: Array<() => void> = []
  private readonly processedRequests = new Set<string>()
  private disposed = false

  constructor(
    private readonly api: TuiPluginApi,
    private readonly config: VoiceConfig,
    private readonly state: VoiceStateStore,
    private readonly playback: PlaybackPipeline,
    private readonly sessionStore: SessionStore,
  ) {
    this.cleanup.push(
      api.event.on("question.asked", (event) => this.runEventTask("question.asked", this.onQuestionAsked(event.properties))),
    )
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.cleanup) off()
    this.cleanup.length = 0
    this.processedRequests.clear()
  }

  private runEventTask(eventName: string, task: Promise<void>) {
    task.catch((error) => {
      this.log.warn("event handler failed", { eventName, error: formatError(error) })
    })
  }

  private async onQuestionAsked(request: QuestionRequest) {
    if (this.processedRequests.has(request.id)) return
    this.processedRequests.add(request.id)

    if (!this.config.speakQuestions) return

    const state = this.state.snapshot()
    if (!state.enabled || state.paused) return

    const active = activeSessionID(this.api.route.current)
    if (!active || active !== request.sessionID) return

    const parentID = await this.sessionStore.sessionParentID(request.sessionID)
    if (parentID) {
      this.log.debug("question skipped for subagent session", { sessionID: request.sessionID, parentID, requestID: request.id })
      return
    }

    const questionTexts = request.questions
      .map((question, index) => ({ index, text: question.question.trim() }))
      .filter((question) => Boolean(question.text))
    if (questionTexts.length === 0) return

    const currentQuestion = questionTexts[0]
    const fullText = currentQuestion.text
    const chunks = splitPlaybackText(currentQuestion.text, this.config).map((chunk) => ({
      ...chunk,
      questionIndex: currentQuestion.index,
    }))
    this.log.info("question asked", {
      sessionID: request.sessionID,
      requestID: request.id,
      questionCount: questionTexts.length,
      spokenQuestionIndex: currentQuestion.index,
      chunkCount: chunks.length,
      fullTextLength: fullText.length,
    })

    chunks.forEach((chunk, index) => {
      this.playback.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "question", {
        origin: "question.asked",
        sessionID: request.sessionID,
        requestID: request.id,
        questionIndex: chunk.questionIndex,
        questionCount: questionTexts.length,
        fullTextLength: fullText.length,
        chunkIndex: index,
        chunkCount: chunks.length,
      })
    })
  }
}
