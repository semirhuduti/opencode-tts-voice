/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, onCleanup } from "solid-js"
import { VoiceCommands } from "./commands/voice-commands.js"
import { openVoiceMenu } from "./commands/voice-menu.js"
import { openVoicePicker } from "./commands/voice-picker.js"
import { LatestMessageStore } from "./latest/latest-message-store.js"
import { PlaybackPipeline } from "./playback/playback-pipeline.js"
import { SessionStore } from "./session/session-store.js"
import { IdleController } from "./session/idle-controller.js"
import { QuestionController } from "./session/question-controller.js"
import { TimerRegistry } from "./shared/timer-registry.js"
import { VoiceStateStore } from "./state/voice-state-store.js"
import { voiceStatusLabel } from "./state/voice-status.js"
import { StreamingController } from "./streaming/streaming-controller.js"
import { PLUGIN_ID } from "./voice-constants.js"
import { resolveVoiceConfig } from "./voice-config.js"
import { createLogger } from "./voice-log.js"
import { findVoicePluginOptions, mergeVoicePluginOptions } from "./voice-plugin-options.js"
import { VoiceRpc } from "./voice-rpc.js"
import { createVoiceSpeedController, formatVoiceSpeed } from "./voice-speed.js"
import { createVoiceSelectionController } from "./voice-selection.js"
import type { VoicePluginOptions } from "./voice-types.js"

const log = createLogger("plugin")

function Status(props: { state: VoiceStateStore; api: Context; speed: () => number }) {
  const [state, setState] = createSignal(props.state.snapshot())
  onCleanup(props.state.subscribe(() => setState(props.state.snapshot())))
  return (
    <text fg={props.api.theme.text.muted}>
      {`[${voiceStatusLabel(state())} - ${formatVoiceSpeed(props.speed())}x - Ctrl+F9]`}
    </text>
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(api) {
    let configuredOptions: VoicePluginOptions | undefined
    try {
      configuredOptions = findVoicePluginOptions(await api.client.config.get())
    } catch (error) {
      log.warn("could not read plugin options from OpenCode config", { error: String(error) })
    }
    const config = resolveVoiceConfig(mergeVoicePluginOptions(configuredOptions, api.options))
    const voice = api.client.rpc(VoiceRpc)
    const location = api.location ?? api.data.location.default()
    let enabled: boolean = true
    let pendingUpdates = 0
    let latestEvent: boolean | undefined
    let onStateChanged: ((enabled: boolean) => void) | undefined
    const removeStateListener = voice.events.on("stateChanged", (event) => {
      if (event.location.directory !== location.directory) return
      const next = (event.data as { enabled?: unknown }).enabled
      if (typeof next !== "boolean") return
      latestEvent = next
      if (pendingUpdates > 0) return
      onStateChanged?.(next)
    })
    try {
      const result = await voice.getEnabled({}, { location })
      if (typeof result !== "object" || result === null || !("enabled" in result) || typeof result.enabled !== "boolean") {
        throw new Error("Invalid voice state response")
      }
      enabled = latestEvent ?? result.enabled
    } catch (error) {
      removeStateListener()
      log.error("voice state unavailable", { error: String(error) })
      api.ui.toast.show({ variant: "error", message: "Voice server plugin unavailable" })
      return
    }

    const speedController = createVoiceSpeedController(api.options.speed, config.speed, api.storage, (error) => {
      log.warn("voice speed update failed", { error: String(error) })
      api.ui.toast.show({ variant: "error", message: "Could not save speech speed" })
    })
    const selectionController = createVoiceSelectionController(api.options.voice, config.voice, api.storage, (error) => {
      log.warn("voice selection update failed", { error: String(error) })
      api.ui.toast.show({ variant: "error", message: "Could not save voice selection" })
    })
    config.speed = speedController.speed
    config.voice = selectionController.voice
    const timers = new TimerRegistry()
    let pendingState = Promise.resolve()
    let disposed = false
    let stateStore: VoiceStateStore
    let playback: PlaybackPipeline
    stateStore = new VoiceStateStore({
      get: <T,>(_key: string, fallback: T): T => typeof fallback === "boolean" ? enabled as T : fallback,
      set: <T,>(_key: string, value: T) => {
        if (typeof value !== "boolean") return
        enabled = value
        latestEvent = undefined
        pendingUpdates++
        pendingState = pendingState.then(() => voice.setEnabled({ enabled: value }, { location })).then(() => undefined).catch(async (error) => {
          log.warn("voice state update failed", { error: String(error) })
          api.ui.toast.show({ variant: "error", message: "Could not save voice state" })
          try {
            if (disposed || pendingUpdates > 1) return
            const saved = await voice.getEnabled({}, { location }) as { enabled: boolean }
            if (disposed || pendingUpdates > 1) return
            latestEvent = undefined
            enabled = saved.enabled
            if (!saved.enabled) await playback.reset(false)
            stateStore.patch({ enabled: saved.enabled })
          } catch (restoreError) {
            log.warn("voice state recovery failed", { error: String(restoreError) })
          }
        }).finally(() => {
          pendingUpdates--
          if (!disposed && pendingUpdates === 0 && latestEvent !== undefined) onStateChanged?.(latestEvent)
        })
      },
    }, config, timers)
    playback = new PlaybackPipeline(config, stateStore, timers, (toast) => api.ui.toast.show(toast))
    onStateChanged = (next) => {
      enabled = next
      if (!next && stateStore.snapshot().enabled) void playback.reset(false)
      stateStore.patch({ enabled: next })
    }
    if (latestEvent !== undefined && latestEvent !== enabled) onStateChanged(latestEvent)
    const sessionStore = new SessionStore(api, config.speakSubagentResponses)
    const latestStore = new LatestMessageStore(api, config, sessionStore)
    const streaming = new StreamingController(api, config, stateStore, playback, sessionStore)
    const idle = new IdleController(api, config, stateStore, playback, sessionStore)
    const questions = new QuestionController(api, config, stateStore, playback, sessionStore)
    const removeIdleRefresh = api.data.on("session.idle", (event) => {
      const current = api.ui.router.current()
      if (current.type === "session" && current.sessionID === event.data.sessionID) latestStore.refresh(event.data.sessionID)
    })
    const route = {
      get current(): { name: string; params?: Record<string, unknown> } {
        const current = api.ui.router.current()
        return current.type === "session"
          ? { name: "session", params: { sessionID: current.sessionID } }
          : { name: current.type }
      },
    }
    const commands = new VoiceCommands(route, config, stateStore, playback, sessionStore, latestStore, (toast) => api.ui.toast.show(toast))
    playback.start()
    const [speed, setSpeed] = createSignal(speedController.percent)
    const adjustSpeed = (direction: -1 | 1) => {
      const next = speedController.adjust(direction)
      config.speed = next
      setSpeed(speedController.percent)
      api.ui.toast.show({ variant: "info", message: `Speech speed: ${formatVoiceSpeed(speedController.percent)}x` })
    }

    async function openHistory() {
      const sessionID = route.current.params?.sessionID
      if (typeof sessionID !== "string") return
      const entries = await commands.historyEntries(sessionID)
      if (disposed) return
      if (route.current.params?.sessionID !== sessionID) return
      if (!entries.length) {
        api.ui.toast.show({ variant: "warning", message: "No assistant message available" })
        return
      }
      const selected = await api.ui.dialog.select({
        title: "Assistant history",
        options: entries.map((entry) => ({ title: entry.preview, value: entry.messageID })),
        actions: [{
          bind: "shift+return",
          title: "Play from selected",
          onTrigger: (messageID) => {
            api.ui.dialog.clear()
            if (route.current.params?.sessionID === sessionID) {
              void commands.playHistory(messageID, "continue", sessionID)
            }
          },
        }],
      })
      if (disposed) return
      if (selected && route.current.params?.sessionID === sessionID) await commands.playHistory(selected, "single", sessionID)
    }

    const voiceActions = {
      history: openHistory,
      pause: async () => { await commands.togglePlayback() },
      latest: async () => { await commands.replayLatest() },
      toggle: () => commands.toggleEnabled(),
      slower: async () => { adjustSpeed(-1) },
      faster: async () => { adjustSpeed(1) },
      choose: async () => {
        await openVoicePicker(api, config.voice, (voiceID) => playback.previewVoice(voiceID), (voiceID) => {
          if (!selectionController.select(voiceID)) return
          config.voice = voiceID
          api.ui.toast.show({ variant: "info", message: `Voice: ${voiceID}` })
        }, () => disposed)
      },
    }

    api.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "tts.history", title: "Replay previous assistant message", group: "Voice", bind: config.shortcuts.history, palette: true, run: voiceActions.history },
        { id: "tts.play-pause", title: "Play or pause speech", group: "Voice", bind: config.shortcuts.pause, palette: true, run: voiceActions.pause },
        { id: "tts.latest", title: "Replay latest assistant message", group: "Voice", bind: config.shortcuts.skipLatest, palette: true, run: voiceActions.latest },
        { id: "tts.toggle", title: "Toggle speech", group: "Voice", bind: config.shortcuts.toggle, palette: true, run: voiceActions.toggle },
        { id: "tts.slower", title: "Slow down speech", group: "Voice", bind: "ctrl+f6", palette: true, run: voiceActions.slower },
        { id: "tts.faster", title: "Speed up speech", group: "Voice", bind: "ctrl+f7", palette: true, run: voiceActions.faster },
        { id: "tts.choose-voice", title: "Choose voice", group: "Voice", palette: true, run: voiceActions.choose },
        { id: "tts.shortcuts", title: "Voice shortcuts", group: "Voice", bind: "ctrl+f9", palette: true, run: () => openVoiceMenu(api, voiceActions, () => disposed) },
      ],
      bindings: ["tts.history", "tts.play-pause", "tts.latest", "tts.toggle", "tts.slower", "tts.faster", "tts.choose-voice", "tts.shortcuts"],
    }))
    const removeHome = api.ui.slot({ append: "home.footer.status", render: () => <Status state={stateStore} api={api} speed={speed} /> })
    const removeSession = api.ui.slot({ append: "prompt.footer.status", render: () => <Status state={stateStore} api={api} speed={speed} /> })

    return async () => {
      disposed = true
      removeHome()
      removeSession()
      removeStateListener()
      removeIdleRefresh()
      streaming.dispose()
      idle.dispose()
      questions.dispose()
      latestStore.dispose()
      sessionStore.dispose()
      try {
        await Promise.all([speedController.flush(), selectionController.flush()])
        await playback.dispose()
      } finally {
        stateStore.dispose()
        timers.dispose()
      }
    }
  },
})
