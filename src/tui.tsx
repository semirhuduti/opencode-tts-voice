/** @jsxImportSource @opentui/solid */

import type { PluginOptions } from "@opencode-ai/plugin";
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal } from "solid-js";
import { createTtsEngine } from "./generation.js";
import { createCommands, getShortcutMap, ShortcutHintBar } from "./shortcuts.js";
import { createDebugLog, createSpeechStreamID, getTextFromParts, loadConfig, type MessageRole } from "./shared.js";

type MessageInfo = {
  finish?: string;
  id: string;
  role: MessageRole;
  time?: {
    completed?: number;
  };
};

type MessageUpdatedEvent = {
  properties: {
    info: MessageInfo;
    sessionID: string;
  };
  type: "message.updated";
};

type MessageRemovedEvent = {
  properties: {
    messageID: string;
    sessionID: string;
  };
  type: "message.removed";
};

type SessionIdleEvent = {
  properties: {
    sessionID: string;
  };
  type: "session.idle";
};

type TextPart = {
  id: string;
  ignored?: boolean;
  messageID: string;
  sessionID: string;
  synthetic?: boolean;
  text?: string;
  type: "text";
};

type MessagePartUpdatedEvent = {
  properties: {
    part: {
      id: string;
      ignored?: boolean;
      messageID: string;
      sessionID: string;
      synthetic?: boolean;
      text?: string;
      type: string;
    };
  };
  type: "message.part.updated";
};

type TuiSessionSelectEvent = {
  properties: {
    sessionID: string;
  };
  type: "tui.session.select";
};

interface MessageState {
  completed: boolean;
  partTextById: Map<string, string>;
  role?: MessageRole;
  sessionID: string;
  streamID: string;
}

const PLUGIN_ID = "@semirhuduti/opencode-tts-voice";
const KV_KEYS = {
  enabled: `${PLUGIN_ID}:enabled`,
} as const;

export const VoiceTuiPlugin: TuiPlugin = async (api, options) => {
  const config = loadConfig(options);
  const debug = createDebugLog(config);
  const ttsEngine = createTtsEngine(config, debug);
  const keys = api.keybind.create(getShortcutMap(options));
  const [enabled, setEnabled] = createSignal(Boolean(api.kv.get(KV_KEYS.enabled, true)));
  const [isStopping, setIsStopping] = createSignal(false);
  const messageRoles = new Map<string, MessageRole>();
  const messageStates = new Map<string, MessageState>();
  const latestAssistantMessageIDBySession = new Map<string, string>();
  const initialRoute = api.route.current;
  let activeSessionID = initialRoute.name === "session" && typeof initialRoute.params?.sessionID === "string"
    ? initialRoute.params.sessionID
    : undefined;

  function runTask(label: string, task: () => Promise<void>): void {
    void task().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      debug("tui.task.error", { label, error: message });
      console.error(`[voice] ${label} failed`, error);
    });
  }

  async function stopPlayback(): Promise<void> {
    debug("stopPlayback.start");
    await ttsEngine.stopAll();
    debug("stopPlayback.done");
  }

  function markEnabled(next: boolean): void {
    setEnabled(next);
    api.kv.set(KV_KEYS.enabled, next);
  }

  function getMessageRole(sessionID: string, messageID: string): MessageRole | undefined {
    const cachedRole = messageRoles.get(messageID);
    if (cachedRole) {
      return cachedRole;
    }

    const message = api.state.session.messages(sessionID)
      .find((item) => item.id === messageID) as { id: string; role?: string } | undefined;

    if (message?.role === "assistant" || message?.role === "user") {
      messageRoles.set(messageID, message.role);
      return message.role;
    }

    return undefined;
  }

  function getMessageState(messageID: string, sessionID: string): MessageState {
    const existingState = messageStates.get(messageID);
    if (existingState) {
      return existingState;
    }

    const state: MessageState = {
      completed: false,
      partTextById: new Map(),
      role: messageRoles.get(messageID),
      sessionID,
      streamID: createSpeechStreamID(sessionID, messageID),
    };
    messageStates.set(messageID, state);
    return state;
  }

  function clearMessageState(messageID: string, opts?: { cancel?: boolean }): void {
    const state = messageStates.get(messageID);
    if (state && (opts?.cancel || !state.completed)) {
      runTask("cancelStream", async () => {
        await ttsEngine.cancelStream(state.streamID);
      });
    }

    messageStates.delete(messageID);
    messageRoles.delete(messageID);
  }

  async function queueSpeech(text: string): Promise<"failed" | "skipped" | "spoken"> {
    if (!enabled()) {
      return "skipped";
    }

    return ttsEngine.speak(text);
  }

  async function replayLatestAssistantMessage(sessionID: string): Promise<boolean> {
    const latestMessageID = latestAssistantMessageIDBySession.get(sessionID)
      ?? [...api.state.session.messages(sessionID)]
        .reverse()
        .find((message) => message.role === "assistant")
        ?.id;

    if (!latestMessageID || !enabled()) {
      return false;
    }

    await stopPlayback();

    const text = getTextFromParts(api.state.part(latestMessageID) as ReadonlyArray<{ text?: string; type?: string }>);
    if (!text) {
      return false;
    }

    return (await ttsEngine.speak(text)) === "spoken";
  }

  function getTextDelta(state: MessageState, part: TextPart): string {
    const previousText = state.partTextById.get(part.id) ?? "";
    const currentText = typeof part.text === "string" ? part.text : previousText;
    state.partTextById.set(part.id, currentText);

    if (!currentText || currentText === previousText) {
      return "";
    }

    if (currentText.startsWith(previousText)) {
      return currentText.slice(previousText.length);
    }

    return currentText;
  }

  async function handleMessagePartUpdated(event: MessagePartUpdatedEvent): Promise<void> {
    const { part } = event.properties;
    if (part.type !== "text" || part.ignored || part.synthetic) {
      return;
    }

    const textPart = part as TextPart;
    activeSessionID ??= textPart.sessionID;
    const state = getMessageState(textPart.messageID, textPart.sessionID);
    const role = state.role ?? getMessageRole(textPart.sessionID, textPart.messageID);
    state.role = role;

    if (role !== "assistant") {
      return;
    }

    latestAssistantMessageIDBySession.set(textPart.sessionID, textPart.messageID);

    if (!enabled()) {
      getTextDelta(state, textPart);
      return;
    }

    const textDelta = getTextDelta(state, textPart);
    if (!textDelta) {
      return;
    }

    await ttsEngine.appendStream(state.streamID, textDelta);
  }

  async function handleMessageUpdated(event: MessageUpdatedEvent): Promise<void> {
    const { info, sessionID } = event.properties;
    messageRoles.set(info.id, info.role);

    const state = messageStates.get(info.id);
    if (state) {
      state.role = info.role;
    }

    if (info.role !== "assistant") {
      return;
    }

    latestAssistantMessageIDBySession.set(sessionID, info.id);

    if (!state) {
      return;
    }

    if (info.time?.completed || info.finish) {
      state.completed = true;
      await ttsEngine.finishStream(state.streamID);
      clearMessageState(info.id);
    }
  }

  function handleSessionIdle(event: SessionIdleEvent): void {
    activeSessionID ??= event.properties.sessionID;

    for (const [messageID, state] of messageStates.entries()) {
      if (state.sessionID !== event.properties.sessionID) {
        continue;
      }

      state.completed = true;
      runTask("finishStream", async () => {
        await ttsEngine.finishStream(state.streamID);
        clearMessageState(messageID);
      });
    }

    if (config.announceOnIdle) {
      runTask("announceOnIdle", async () => {
        await queueSpeech(config.idleMessage);
      });
    }
  }

  api.lifecycle.onDispose(async () => {
    await stopPlayback().catch(() => {});

    try {
    } catch {
      // Ignore shutdown errors while the TUI is disposing.
    }

    setIsStopping(false);
  });

  api.event.on("tui.session.select", (event) => {
    activeSessionID = (event as TuiSessionSelectEvent).properties.sessionID;
  });

  api.event.on("message.updated", (event) => {
    runTask("message.updated", async () => {
      await handleMessageUpdated(event as MessageUpdatedEvent);
    });
  });

  api.event.on("message.removed", (event) => {
    clearMessageState((event as MessageRemovedEvent).properties.messageID, { cancel: true });
  });

  if (config.readResponses) {
    api.event.on("message.part.updated", (event) => {
      runTask("message.part.updated", async () => {
        await handleMessagePartUpdated(event as MessagePartUpdatedEvent);
      });
    });
  }

  if (config.readResponses || config.announceOnIdle) {
    api.event.on("session.idle", (event) => {
      handleSessionIdle(event as SessionIdleEvent);
    });
  }

  api.command.register(() => createCommands(keys, {
    async onSkipLatest() {
      setIsStopping(false);
      if (!activeSessionID) {
        return;
      }

      await replayLatestAssistantMessage(activeSessionID);
    },
    async onStop() {
      setIsStopping(true);
      try {
        await stopPlayback();
      } finally {
        setIsStopping(false);
      }
    },
    async onToggle() {
      const next = !enabled();
      markEnabled(next);
      setIsStopping(false);

      if (!next) {
        await stopPlayback();
      }
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
