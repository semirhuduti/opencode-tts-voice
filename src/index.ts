import type { PluginModule } from "@opencode-ai/plugin";

export { createTtsEngine } from "./generation.js";
export type { TtsEngine } from "./generation.js";
export {
  createDebugLog,
  createSpeechStreamID,
  getTextFromParts,
  loadConfig,
} from "./shared.js";
export type {
  DebugLog,
  MessageRole,
  SpeakResult,
  TtsConfig,
  VoicePluginOptions,
} from "./shared.js";

export const VoicePlugin: PluginModule = {
  id: "@semirhuduti/opencode-tts-voice",
  // The voice runtime lives in the TUI plugin. The server side stays as a
  // no-op module so package-root plugin specs remain valid in opencode.json.
  server: async () => ({}),
};

export default VoicePlugin;
