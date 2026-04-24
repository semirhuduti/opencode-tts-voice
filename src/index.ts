import type { Plugin } from "@opencode-ai/plugin";

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

export const VoicePlugin: Plugin = async () => {
  // The voice runtime now lives entirely in the TUI plugin so it can use
  // lifecycle-managed disposal instead of process exit handlers.
  return {};
};

export default VoicePlugin;
