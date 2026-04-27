import { describe, expect, it } from "bun:test"
import { PlaybackQueue } from "../../src/playback/queue.js"

describe("PlaybackQueue", () => {
  it("enqueues source chunks and ready audio", () => {
    const queue = new PlaybackQueue()
    const events = queue.enqueuePreparedChunk("Hello", 10, "latest", 0, 100)
    const item = queue.takeSourceItem()

    expect(events).toHaveLength(1)
    expect(item?.text).toBe("Hello")
    expect(item?.source).toBe("latest")

    if (!item) throw new Error("expected source item")
    queue.enqueueReadyAudio(queue.createPauseReadyAudioItem(item))
    expect(queue.takeReadyAudioItem()?.kind).toBe("pause")
  })

  it("coalesces stream chunks when the queue is backed up", () => {
    const queue = new PlaybackQueue()
    for (let index = 0; index < 4; index += 1) {
      queue.enqueuePreparedChunk(`chunk ${index}.`, 10, "stream", 0, 100)
    }

    const events = queue.enqueuePreparedChunk("merged.", 20, "stream", 0, 100)

    expect(events.some((event) => event.type === "coalesced")).toBe(true)
    expect(queue.snapshot().queueLength).toBe(4)
    expect(queue.sourceItems.at(-1)?.text).toContain("merged.")
    expect(queue.sourceItems.at(-1)?.pauseMs).toBe(20)
  })

  it("trims old stream chunks beyond the stream queue limit", () => {
    const queue = new PlaybackQueue()
    for (let index = 0; index < 40; index += 1) {
      queue.enqueuePreparedChunk(`chunk ${index}.`, 10, "stream", 0, 8)
    }

    expect(queue.snapshot().queueLength).toBe(32)
  })

  it("reports duplicate chunk fingerprints", () => {
    const queue = new PlaybackQueue()
    queue.enqueuePreparedChunk("same", 10, "latest", 0, 100)
    const events = queue.enqueuePreparedChunk("same", 10, "latest", 0, 100)

    expect(events.some((event) => event.type === "enqueued" && Boolean(event.duplicate))).toBe(true)
  })
})
