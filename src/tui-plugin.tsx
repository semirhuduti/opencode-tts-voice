/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { PLUGIN_ID } from "./voice-constants.js"
import { resolveVoiceConfig } from "./voice-config.js"
import { VoiceController } from "./voice-controller.js"
import type { VoicePluginOptions } from "./voice-types.js"

function ShortcutManager(props: {
  api: TuiPluginApi
  controller: VoiceController
  keybinds: ReturnType<TuiPluginApi["keybind"]["create"]>
}) {
  useKeyboard((event) => {
    if (props.keybinds.match("toggle", event)) {
      event.preventDefault()
      event.stopPropagation()
      void props.controller.toggleEnabled()
      return
    }

    if (props.keybinds.match("pause", event)) {
      event.preventDefault()
      event.stopPropagation()
      void props.controller.togglePlayback()
      return
    }

    if (props.keybinds.match("skipLatest", event)) {
      event.preventDefault()
      event.stopPropagation()
      void props.controller.replayLatest()
    }
  })

  return null
}

function ShortcutHint(props: {
  api: TuiPluginApi
  controller: VoiceController
  keybinds: ReturnType<TuiPluginApi["keybind"]["create"]>
}) {
  const [state, setState] = createSignal(props.controller.snapshot())
  const unsubscribe = props.controller.subscribe(() => setState(props.controller.snapshot()))
  onCleanup(unsubscribe)

  const label = createMemo(() => {
    const current = state()
    if (!current.enabled) return "off"
    if (current.paused) return "paused"
    if (current.playing) return "playing"
    if (current.busy) return "queued"
    return "on"
  })

  const theme = () => props.api.theme.current

  return (
    <text fg={theme().textMuted}>
      TTS <span style={{ fg: state().enabled ? theme().success : theme().warning }}>{label()}</span>{" "}
      <span>{props.keybinds.print("pause")} play/pause</span>{" "}
      <span>{props.keybinds.print("skipLatest")} latest</span>{" "}
      <span>{props.keybinds.print("toggle")} toggle</span>
    </text>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const config = resolveVoiceConfig(options as VoicePluginOptions | undefined)
  const controller = new VoiceController(api, config)
  const keybinds = api.keybind.create(
    {
      pause: config.shortcuts.pause,
      skipLatest: config.shortcuts.skipLatest,
      toggle: config.shortcuts.toggle,
    },
    config.shortcuts,
  )

  api.command.register(() => [
    {
      title: "Toggle speech",
      value: "tts.toggle",
      category: "Voice",
      keybind: keybinds.get("toggle"),
      onSelect: () => {
        void controller.toggleEnabled()
      },
    },
    {
      title: "Play or pause speech",
      value: "tts.play-pause",
      category: "Voice",
      keybind: keybinds.get("pause"),
      onSelect: () => {
        void controller.togglePlayback()
      },
    },
    {
      title: "Replay latest assistant message",
      value: "tts.latest",
      category: "Voice",
      keybind: keybinds.get("skipLatest"),
      onSelect: () => {
        void controller.replayLatest()
      },
    },
  ])

  api.slots.register({
    slots: {
      app() {
        return <ShortcutManager api={api} controller={controller} keybinds={keybinds} />
      },
      home_prompt_right() {
        return <ShortcutHint api={api} controller={controller} keybinds={keybinds} />
      },
      session_prompt_right() {
        return <ShortcutHint api={api} controller={controller} keybinds={keybinds} />
      },
    },
  })

  api.lifecycle.onDispose(() => controller.dispose())
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
