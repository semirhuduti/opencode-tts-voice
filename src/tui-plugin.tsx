/** @jsxImportSource @opentui/solid */

import type { TuiDialogSelectOption, TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { ColorInput, KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { VoiceCommands } from "./commands/voice-commands.js"
import { LatestMessageStore, type AssistantHistoryEntry } from "./latest/latest-message-store.js"
import { MessageStore } from "./messages/message-store.js"
import { PlaybackPipeline } from "./playback/playback-pipeline.js"
import { SessionStore } from "./session/session-store.js"
import { IdleController } from "./session/idle-controller.js"
import { QuestionController } from "./session/question-controller.js"
import { TimerRegistry } from "./shared/timer-registry.js"
import { activeSessionID } from "./shared/voice-utils.js"
import { VoiceStateStore } from "./state/voice-state-store.js"
import { StreamingController } from "./streaming/streaming-controller.js"
import { PLUGIN_ID } from "./voice-constants.js"
import { resolveVoiceConfig } from "./voice-config.js"
import { createLogger } from "./voice-log.js"
import type { VoicePluginOptions } from "./voice-types.js"

const log = createLogger("plugin")
const ACTION_GAP = " "
const HOTKEY = "#ff9d00"
const ACTION_ICON = "#4da3ff"
const TOGGLE_OFF = "#808080"
const ERROR_ICON = "#ff5c57"
const SPINNER_INTERVAL_MS = 90
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function stopKey(event: KeyEvent) {
  event.preventDefault()
  event.stopPropagation()
}

function formatHistoryTimestamp(created: number) {
  const date = new Date(created)
  if (Number.isNaN(date.getTime())) return "--:--"
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function ShortcutChip(props: {
  keyLabel: string
  label: string
  icon: string
  iconColor?: ColorInput
}) {
  return (
    <span>
      [<span style={{ fg: HOTKEY }}>{props.keyLabel}</span> {props.label} <span style={{ fg: props.iconColor ?? ACTION_ICON }}>{props.icon}</span>]
    </span>
  )
}

function ShortcutManager(props: {
  api: TuiPluginApi
  keybinds: ReturnType<TuiPluginApi["keybind"]["create"]>
}) {
  useKeyboard((event) => {
    if (event.defaultPrevented) return
    if (props.api.ui.dialog.open) return

    if (props.keybinds.match("toggle", event)) {
      log.info("keyboard toggle", { key: props.keybinds.print("toggle") })
      event.preventDefault()
      event.stopPropagation()
      props.api.command.trigger("tts.toggle")
      return
    }

    if (props.keybinds.match("pause", event)) {
      log.info("keyboard pause", { key: props.keybinds.print("pause") })
      event.preventDefault()
      event.stopPropagation()
      props.api.command.trigger("tts.play-pause")
      return
    }

    if (props.keybinds.match("history", event)) {
      log.info("keyboard history", { key: props.keybinds.print("history") })
      event.preventDefault()
      event.stopPropagation()
      props.api.command.trigger("tts.history")
      return
    }

    if (props.keybinds.match("skipLatest", event)) {
      log.info("keyboard latest", { key: props.keybinds.print("skipLatest") })
      event.preventDefault()
      event.stopPropagation()
      props.api.command.trigger("tts.latest")
    }
  })

  return null
}

function ShortcutHint(props: {
  api: TuiPluginApi
  stateStore: VoiceStateStore
  latestStore: LatestMessageStore
  keybinds: ReturnType<TuiPluginApi["keybind"]["create"]>
}) {
  const [state, setState] = createSignal(props.stateStore.snapshot())
  const [hasHistory, setHasHistory] = createSignal(false)
  const [spinnerFrame, setSpinnerFrame] = createSignal(0)
  const unsubscribe = props.stateStore.subscribe(() => setState(props.stateStore.snapshot()))
  const unsubscribeHistory = props.latestStore.onHistoryChanged((sessionID) => {
    if (sessionID !== activeSessionID(props.api.route.current)) return
    void props.latestStore.collectDisplayHistory(sessionID, 1).then((entries) => setHasHistory(entries.length > 0))
  })
  onCleanup(unsubscribe)
  onCleanup(unsubscribeHistory)

  createEffect(() => {
    const sessionID = activeSessionID(props.api.route.current)
    if (!sessionID) {
      setHasHistory(false)
      return
    }
    void props.latestStore.collectDisplayHistory(sessionID, 1).then((entries) => setHasHistory(entries.length > 0))
  })

  createEffect(() => {
    if (!state().generating) {
      setSpinnerFrame(0)
      return
    }

    const timer = setInterval(() => {
      setSpinnerFrame((frame) => (frame + 1) % SPINNER_FRAMES.length)
    }, SPINNER_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const theme = () => props.api.theme.current
  const playChip = () => <ShortcutChip keyLabel={props.keybinds.print("pause")} label="play" icon="▶" />
  const pauseChip = () => <ShortcutChip keyLabel={props.keybinds.print("pause")} label="pause" icon="Ⅱ" />
  const historyChip = () => <ShortcutChip keyLabel={props.keybinds.print("history")} label="history" icon="◷" />
  const replayChip = () => <ShortcutChip keyLabel={props.keybinds.print("skipLatest")} label="replay" icon="↻" />
  const errorChip = () => <span>[<span style={{ fg: ERROR_ICON }}>!</span> error]</span>
  const toggleChip = () => {
    const current = state()
    return (
      <ShortcutChip
        keyLabel={props.keybinds.print("toggle")}
        label={current.enabled ? "on" : "off"}
        icon={current.enabled ? "●" : "○"}
        iconColor={current.enabled ? theme().success : TOGGLE_OFF}
      />
    )
  }
  const content = () => {
    const current = state()
    const maybeHistory = () => hasHistory() ? <>{ACTION_GAP}{historyChip()}</> : null
    if (current.error) return <>{errorChip()}{ACTION_GAP}{toggleChip()}</>
    if (!current.enabled) return <>{toggleChip()}{maybeHistory()}</>
    if (current.paused) return <>{playChip()}{maybeHistory()}{ACTION_GAP}{replayChip()}{ACTION_GAP}{toggleChip()}</>
    if (current.busy) {
      return <>{current.generating && <span style={{ fg: ACTION_ICON }}>{SPINNER_FRAMES[spinnerFrame()]}</span>}{current.generating && ACTION_GAP}{pauseChip()}{maybeHistory()}{ACTION_GAP}{toggleChip()}</>
    }

    return <>{playChip()}{maybeHistory()}{ACTION_GAP}{replayChip()}{ACTION_GAP}{toggleChip()}</>
  }

  return <text fg={theme().textMuted}>{content()}</text>
}

function HistoryPickerDialog(props: {
  api: TuiPluginApi
  commands: VoiceCommands
  sessionID: string
  entries: AssistantHistoryEntry[]
}) {
  const options: TuiDialogSelectOption<string>[] = props.entries.map((entry) => ({
    title: `${formatHistoryTimestamp(entry.created)} ${entry.preview}`,
    value: entry.messageID,
  }))
  const [selectedMessageID, setSelectedMessageID] = createSignal(options[0]?.value)
  const play = (messageID: string | undefined, mode: "single" | "continue") => {
    if (!messageID) return
    props.api.ui.dialog.clear()
    void props.commands.playHistory(messageID, mode, props.sessionID)
  }

  useKeyboard((event) => {
    if (event.defaultPrevented) return
    if (event.name !== "return" || !event.shift) return

    stopKey(event)
    play(selectedMessageID(), "continue")
  })

  return (
    <props.api.ui.DialogSelect
      title="Assistant History - enter plays selected, shift+enter continues from selected"
      options={options}
      skipFilter
      current={selectedMessageID()}
      onMove={(option) => setSelectedMessageID(option.value)}
      onSelect={(option) => play(option.value, "single")}
    />
  )
}

const tui: TuiPlugin = async (api, options) => {
  const config = resolveVoiceConfig(options as VoicePluginOptions | undefined)
  log.info("tui init", {
    route: api.route.current.name,
    audioPlayer: config.audioPlayer,
    device: config.device,
    speakResponses: config.speakResponses,
  })
  const timers = new TimerRegistry()
  const stateStore = new VoiceStateStore(api.kv, config, timers)
  const playback = new PlaybackPipeline(config, stateStore, timers, (toast) => api.ui.toast(toast))
  const sessionStore = new SessionStore(api, config.speakSubagentResponses)
  const messageStore = new MessageStore(api)
  const latestStore = new LatestMessageStore(api, config, timers, sessionStore)
  messageStore.onUpdated((message) => latestStore.onMessageUpdated(message))
  const streaming = new StreamingController(api, config, stateStore, playback, sessionStore, messageStore, latestStore)
  const idle = new IdleController(api, config, stateStore, playback, sessionStore)
  const questions = new QuestionController(api, config, stateStore, playback, sessionStore)
  const commands = new VoiceCommands(api.route, config, stateStore, playback, sessionStore, latestStore, (toast) => api.ui.toast(toast))
  playback.start()
  const shortcutKeys = api.keybind.create(
    {
      history: config.shortcuts.history,
      pause: config.shortcuts.pause,
      skipLatest: config.shortcuts.skipLatest,
      toggle: config.shortcuts.toggle,
    },
    config.shortcuts,
  )

  const openHistoryPicker = async () => {
    const sessionID = activeSessionID(api.route.current)
    if (!sessionID) return

    const entries = await commands.historyEntries(sessionID)
    if (entries.length === 0) return

    api.ui.dialog.setSize("large")
    api.ui.dialog.replace(
      () => (
        <HistoryPickerDialog
          api={api}
          commands={commands}
          sessionID={sessionID}
          entries={entries}
        />
      ),
      () => log.info("history picker closed", { sessionID }),
    )
  }

  api.command.register(() => [
    {
      title: "Toggle speech",
      value: "tts.toggle",
      category: "Voice",
      keybind: shortcutKeys.get("toggle"),
      onSelect: () => {
        log.info("command selected", { command: "tts.toggle" })
        void commands.toggleEnabled()
      },
    },
    {
      title: "Play or pause speech",
      value: "tts.play-pause",
      category: "Voice",
      keybind: shortcutKeys.get("pause"),
      onSelect: () => {
        log.info("command selected", { command: "tts.play-pause" })
        void commands.togglePlayback()
      },
    },
    {
      title: "Replay previous assistant message",
      value: "tts.history",
      category: "Voice",
      keybind: shortcutKeys.get("history"),
      onSelect: () => {
        log.info("command selected", { command: "tts.history" })
        void openHistoryPicker()
      },
    },
    {
      title: "Replay latest assistant message",
      value: "tts.latest",
      category: "Voice",
      keybind: shortcutKeys.get("skipLatest"),
      onSelect: () => {
        log.info("command selected", { command: "tts.latest" })
        void commands.replayLatest()
      },
    },
  ])

  api.slots.register({
    slots: {
      app() {
        return <ShortcutManager api={api} keybinds={shortcutKeys} />
      },
      home_prompt_right() {
        return <ShortcutHint api={api} stateStore={stateStore} latestStore={latestStore} keybinds={shortcutKeys} />
      },
      session_prompt_right() {
        return <ShortcutHint api={api} stateStore={stateStore} latestStore={latestStore} keybinds={shortcutKeys} />
      },
    },
  })

  api.lifecycle.onDispose(() => {
    log.info("tui dispose")
    return (async () => {
      streaming.dispose()
      idle.dispose()
      questions.dispose()
      messageStore.dispose()
      sessionStore.dispose()
      await playback.dispose()
      stateStore.dispose()
      timers.dispose()
    })()
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
