/** @jsxImportSource @opentui/solid */

import type { PluginOptions } from "@opencode-ai/plugin";
import type { TuiCommand, TuiKeybindMap, TuiKeybindSet } from "@opencode-ai/plugin/tui";
import type { RGBA } from "@opentui/core";

import type { VoicePluginOptions } from "./shared.js";

const CONTROL_COMMANDS = {
  stop: "voice.stop",
  skipLatest: "voice.skip-latest",
  toggle: "voice.toggle",
} as const;

const SHORTCUT_DEFAULTS = {
  pause: "f6",
  skipLatest: "f7",
  toggle: "f8",
} as const;

type HintChipProps = {
  accent: RGBA;
  icon: string;
  keyLabel: string;
  label: string;
  muted: RGBA;
};

type ShortcutHintBarProps = {
  enabled: boolean;
  isStopping: boolean;
  keys: TuiKeybindSet;
  muted: RGBA;
  success: RGBA;
  warning: RGBA;
};

function pickShortcut(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function getShortcutMap(options?: PluginOptions): TuiKeybindMap {
  const pluginOptions = (options ?? {}) as VoicePluginOptions;
  const shortcuts = pluginOptions.shortcuts;

  return {
    pause: pickShortcut(shortcuts?.pause, SHORTCUT_DEFAULTS.pause),
    skipLatest: pickShortcut(shortcuts?.skipLatest, SHORTCUT_DEFAULTS.skipLatest),
    toggle: pickShortcut(shortcuts?.toggle, SHORTCUT_DEFAULTS.toggle),
  };
}

export function createCommands(
  keys: TuiKeybindSet,
  handlers: {
    onSkipLatest(): Promise<void>;
    onStop(): Promise<void>;
    onToggle(): Promise<void>;
  },
): TuiCommand[] {
  return [
    {
      title: "Pause voice playback",
      value: CONTROL_COMMANDS.stop,
      description: "Stop the current spoken response",
      category: "Voice",
      keybind: keys.get("pause"),
      slash: { name: "voice-pause" },
      onSelect() {
        void handlers.onStop();
      },
    },
    {
      title: "Replay latest assistant message",
      value: CONTROL_COMMANDS.skipLatest,
      description: "Read the last assistant response again",
      category: "Voice",
      keybind: keys.get("skipLatest"),
      slash: { name: "voice-latest" },
      onSelect() {
        void handlers.onSkipLatest();
      },
    },
    {
      title: "Toggle voice playback",
      value: CONTROL_COMMANDS.toggle,
      description: "Enable or disable automatic voice playback",
      category: "Voice",
      keybind: keys.get("toggle"),
      slash: { name: "voice-toggle" },
      onSelect() {
        void handlers.onToggle();
      },
    },
  ];
}

function HintChip(props: HintChipProps) {
  return (
    <box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
      <text fg={props.accent}>{props.icon}</text>
      <text fg={props.muted}>{props.label}</text>
      <text fg={props.accent}>{props.keyLabel}</text>
    </box>
  );
}

export function ShortcutHintBar(props: ShortcutHintBarProps) {
  const toggleAccent = () => props.enabled ? props.success : props.muted;
  const pauseAccent = () => props.isStopping ? props.warning : props.muted;
  const pauseIcon = () => props.isStopping ? "||" : ">";
  const toggleIcon = () => props.enabled ? "●" : "○";

  return (
    <box flexDirection="row" justifyContent="center" gap={3} width="100%" flexWrap="wrap">
      <HintChip
        accent={pauseAccent()}
        icon={pauseIcon()}
        keyLabel={props.keys.print("pause")}
        label="pauzzze"
        muted={props.muted}
      />
      <HintChip
        accent={props.warning}
        icon=">>"
        keyLabel={props.keys.print("skipLatest")}
        label="latest"
        muted={props.muted}
      />
      <HintChip
        accent={toggleAccent()}
        icon={toggleIcon()}
        keyLabel={props.keys.print("toggle")}
        label={props.enabled ? "voice on" : "voice off"}
        muted={props.muted}
      />
    </box>
  );
}
