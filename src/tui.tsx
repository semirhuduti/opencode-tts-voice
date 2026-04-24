/** @jsxImportSource @opentui/solid */

import type { PluginOptions } from "@opencode-ai/plugin";
import type { TuiCommand, TuiKeybindMap, TuiKeybindSet, TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal } from "solid-js";

type VoicePluginOptions = {
  shortcuts?: {
    pause?: string;
    skipLatest?: string;
    toggle?: string;
  };
};

const PLUGIN_ID = "@semirhuduti/opencode-tts-voice";
const CONTROL_COMMANDS = {
  stop: "voice.stop",
  skipLatest: "voice.skip-latest",
  toggle: "voice.toggle",
} as const;
const UI_COMMANDS = {
  stop: "voice.ui.stop",
  skipLatest: "voice.ui.skip-latest",
  toggle: "voice.ui.toggle",
} as const;
const KV_KEYS = {
  enabled: `${PLUGIN_ID}:enabled`,
} as const;
const SHORTCUT_DEFAULTS = {
  pause: "f6",
  skipLatest: "f7",
  toggle: "f8",
} as const;

type HintChipProps = {
  accent: string;
  icon: string;
  keyLabel: string;
  label: string;
  muted: string;
};

type ShortcutHintBarProps = {
  enabled: boolean;
  isStopping: boolean;
  keys: TuiKeybindSet;
  muted: string;
  success: string;
  warning: string;
};

function pickShortcut(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getShortcutMap(options?: PluginOptions): TuiKeybindMap {
  const pluginOptions = (options ?? {}) as VoicePluginOptions;
  const shortcuts = pluginOptions.shortcuts;

  return {
    pause: pickShortcut(shortcuts?.pause, SHORTCUT_DEFAULTS.pause),
    skipLatest: pickShortcut(shortcuts?.skipLatest, SHORTCUT_DEFAULTS.skipLatest),
    toggle: pickShortcut(shortcuts?.toggle, SHORTCUT_DEFAULTS.toggle),
  };
}

function createCommands(
  api: Parameters<TuiPlugin>[0],
  keys: TuiKeybindSet,
  handlers: {
    onSkipLatest(): void;
    onStop(): void;
    onToggle(): void;
  },
): TuiCommand[] {
  const publishControlCommand = (command: string) => {
    void api.client.tui.publish({
      body: {
        type: "tui.command.execute",
        properties: { command },
      },
    });
  };

  return [
    {
      title: "Pause voice playback",
      value: UI_COMMANDS.stop,
      description: "Stop the current spoken response",
      category: "Voice",
      keybind: keys.get("pause"),
      slash: { name: "voice-pause" },
      onSelect() {
        handlers.onStop();
        publishControlCommand(CONTROL_COMMANDS.stop);
      },
    },
    {
      title: "Replay latest assistant message",
      value: UI_COMMANDS.skipLatest,
      description: "Read the last assistant response again",
      category: "Voice",
      keybind: keys.get("skipLatest"),
      slash: { name: "voice-latest" },
      onSelect() {
        handlers.onSkipLatest();
        publishControlCommand(CONTROL_COMMANDS.skipLatest);
      },
    },
    {
      title: "Toggle voice playback",
      value: UI_COMMANDS.toggle,
      description: "Enable or disable automatic voice playback",
      category: "Voice",
      keybind: keys.get("toggle"),
      slash: { name: "voice-toggle" },
      onSelect() {
        handlers.onToggle();
        publishControlCommand(CONTROL_COMMANDS.toggle);
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

function ShortcutHintBar(props: ShortcutHintBarProps) {
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
        label="pause"
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

export const VoiceTuiPlugin: TuiPlugin = async (api, options) => {
  const keys = api.keybind.create(getShortcutMap(options));
  const [enabled, setEnabled] = createSignal(Boolean(api.kv.get(KV_KEYS.enabled, true)));
  const [isStopping, setIsStopping] = createSignal(false);

  api.lifecycle.onDispose(() => {
    setIsStopping(false);
  });

  function markEnabled(next: boolean): void {
    setEnabled(next);
    api.kv.set(KV_KEYS.enabled, next);
  }

  api.command.register(() => createCommands(api, keys, {
    onSkipLatest() {
      setIsStopping(false);
    },
    onStop() {
      setIsStopping(true);
    },
    onToggle() {
      markEnabled(!enabled());
      setIsStopping(false);
    },
  }));

  api.slots.register({
    slots: {
      home_prompt(ctx, value) {
        return (
          <box flexDirection="column" gap={1} width="100%">
            <api.ui.Prompt workspaceID={value.workspace_id} />
            <ShortcutHintBar
              enabled={enabled()}
              isStopping={isStopping()}
              keys={keys}
              muted={ctx.theme.current.textMuted}
              success={ctx.theme.current.success}
              warning={ctx.theme.current.warning}
            />
          </box>
        );
      },
      session_prompt(ctx, value) {
        return (
          <box flexDirection="column" gap={1} width="100%">
            <api.ui.Prompt sessionID={value.session_id} visible={value.visible} disabled={value.disabled} onSubmit={value.on_submit} ref={value.ref} />
            <ShortcutHintBar
              enabled={enabled()}
              isStopping={isStopping()}
              keys={keys}
              muted={ctx.theme.current.textMuted}
              success={ctx.theme.current.success}
              warning={ctx.theme.current.warning}
            />
          </box>
        );
      },
      session_prompt_right(ctx) {
        return <text fg={enabled() ? ctx.theme.current.success : ctx.theme.current.textMuted}>voice</text>;
      },
    },
  });
};

const plugin: TuiPluginModule = {
  id: PLUGIN_ID,
  tui: VoiceTuiPlugin,
};

export default plugin;
