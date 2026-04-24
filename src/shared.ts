import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PluginOptions } from "@opencode-ai/plugin";

export type MessageRole = "assistant" | "user";
export type RuntimeDevice = "cpu" | "cuda" | "dml" | "gpu" | "wasm" | "webgpu" | null;
export type RuntimeDtype = "fp32" | "fp16" | "q4" | "q4f16" | "q8";
export type SpeakResult = "failed" | "skipped" | "spoken";
export type DebugLog = (message: string, data?: Record<string, unknown>) => void;

export type VoicePluginOptions = {
  announceOnIdle?: boolean;
  cacheDir?: string;
  clauseChunkPauseMs?: number;
  defaultChunkPauseMs?: number;
  device?: string;
  dtype?: string;
  idleMessage?: string;
  leadingAudioPadMs?: number;
  maxTextLength?: number;
  model?: string;
  playerArgs?: string[] | string;
  playerBin?: string;
  readResponses?: boolean;
  shortcuts?: {
    pause?: string;
    skipLatest?: string;
    toggle?: string;
  };
  speechChunkLength?: number;
  speed?: number;
  streamSoftLimit?: number;
  trimSilenceThreshold?: number;
  voice?: string;
};

export interface TtsConfig {
  announceOnIdle: boolean;
  cacheDir: string;
  clauseChunkPauseMs: number;
  defaultChunkPauseMs: number;
  device: RuntimeDevice;
  dtype: RuntimeDtype;
  fallbackDevice: RuntimeDevice;
  idleMessage: string;
  leadingAudioPadMs: number;
  maxTextLength: number;
  model: string;
  playerArgs: string[];
  playerBin: string;
  readResponses: boolean;
  speechChunkLength: number;
  speed: number;
  streamSoftLimit: number;
  trimSilenceThreshold: number;
  voice: string;
}

export interface KokoroAudioLike {
  audio?: Float32Array | ArrayLike<number>;
  data?: Float32Array | ArrayLike<number>;
  sampleRate?: number;
  sampling_rate?: number;
}

export interface KokoroStreamChunk {
  audio: KokoroAudioLike;
  phonemes: string;
  text: string;
}

export interface KokoroTextSplitterStream extends AsyncIterable<string> {
  close(): void;
  flush(): void;
  push(...texts: string[]): void;
}

export interface KokoroRuntime {
  generate(
    text: string,
    options: {
      speed: number;
      voice: string;
    },
  ): Promise<KokoroAudioLike>;
  stream(
    text: string | KokoroTextSplitterStream,
    options: {
      speed: number;
      voice: string;
    },
  ): AsyncGenerator<KokoroStreamChunk, void, void>;
}

export interface KokoroModule {
  KokoroTTS?: {
    from_pretrained(
      model: string,
      options: {
        device: RuntimeDevice;
        dtype: RuntimeDtype;
      },
    ): Promise<KokoroRuntime>;
  };
  TextSplitterStream?: new () => KokoroTextSplitterStream;
}

export interface LoadedKokoroModule {
  KokoroTTS: NonNullable<KokoroModule["KokoroTTS"]>;
  TextSplitterStream: NonNullable<KokoroModule["TextSplitterStream"]>;
}

export interface TransformersEnvironment {
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  backends?: {
    onnx?: {
      logLevel?: "verbose" | "info" | "warning" | "error" | "fatal";
    };
  };
  cacheDir: string;
  useBrowserCache: boolean;
  useFS: boolean;
  useFSCache: boolean;
}

export interface TransformersModule {
  default?: {
    env?: TransformersEnvironment;
  };
  env?: TransformersEnvironment;
}

const SILENCE_THRESHOLD = 0.001;
const LEADING_AUDIO_PAD_MS = 12;
const DEFAULT_CHUNK_PAUSE_MS = 50;
const CLAUSE_CHUNK_PAUSE_MS = 80;

function getDefaultPlayerArgs(): string[] {
  return [];
}

function getDefaultPlayerBin(): string {
  return "ffplay";
}

const defaultConfig: TtsConfig = {
  announceOnIdle: false,
  cacheDir: getDefaultCacheDir(),
  clauseChunkPauseMs: CLAUSE_CHUNK_PAUSE_MS,
  defaultChunkPauseMs: DEFAULT_CHUNK_PAUSE_MS,
  device: "gpu",
  dtype: "q8",
  fallbackDevice: "cpu",
  idleMessage: "Task completed.",
  leadingAudioPadMs: LEADING_AUDIO_PAD_MS,
  maxTextLength: 2000,
  model: "onnx-community/Kokoro-82M-v1.0-ONNX",
  playerArgs: getDefaultPlayerArgs(),
  playerBin: getDefaultPlayerBin(),
  readResponses: true,
  speechChunkLength: 1000,
  speed: 1,
  streamSoftLimit: 180,
  trimSilenceThreshold: SILENCE_THRESHOLD,
  voice: "af_heart",
};

function getDefaultCacheDir(): string {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "opencode",
      "kokoro",
    );
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "opencode", "kokoro");
  }

  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "opencode", "kokoro");
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizePositiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeDevice(value: string | undefined, fallback: RuntimeDevice): RuntimeDevice {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "auto") {
    return null;
  }

  if (
    normalized === "cpu"
    || normalized === "cuda"
    || normalized === "dml"
    || normalized === "gpu"
    || normalized === "wasm"
    || normalized === "webgpu"
  ) {
    return normalized;
  }

  return fallback;
}

function normalizeDtype(value: string | undefined, fallback: RuntimeDtype): RuntimeDtype {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "fp32"
    || normalized === "fp16"
    || normalized === "q4"
    || normalized === "q4f16"
    || normalized === "q8"
  ) {
    return normalized;
  }

  return fallback;
}

function parsePlayerArgs(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    const args = value.filter((item) => typeof item === "string" && item.trim());
    return args.length > 0 ? args : defaultConfig.playerArgs;
  }

  if (!value?.trim()) {
    return defaultConfig.playerArgs;
  }

  const args = value.trim().split(/\s+/u);
  return args.length > 0 ? args : defaultConfig.playerArgs;
}

function toPluginOptions(options?: PluginOptions): VoicePluginOptions {
  return (options ?? {}) as VoicePluginOptions;
}

export function getTextFromParts(parts: ReadonlyArray<{ text?: string; type?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

export function loadConfig(options?: PluginOptions): TtsConfig {
  const pluginOptions = toPluginOptions(options);
  const speechChunkLength = normalizePositiveInteger(
    typeof pluginOptions.speechChunkLength === "number"
      ? pluginOptions.speechChunkLength
      : Number(process.env.OPENCODE_TTS_CHUNK_LENGTH ?? process.env.TTS_SPEECH_CHUNK_LENGTH ?? defaultConfig.speechChunkLength),
    defaultConfig.speechChunkLength,
  );

  return {
    announceOnIdle: normalizeBoolean(
      pluginOptions.announceOnIdle,
      process.env.OPENCODE_TTS_ANNOUNCE_IDLE === "true",
    ),
    cacheDir: normalizeString(pluginOptions.cacheDir, process.env.OPENCODE_TTS_CACHE_DIR ?? defaultConfig.cacheDir),
    clauseChunkPauseMs: normalizePositiveInteger(
      typeof pluginOptions.clauseChunkPauseMs === "number"
        ? pluginOptions.clauseChunkPauseMs
        : Number(process.env.OPENCODE_TTS_CLAUSE_CHUNK_PAUSE_MS ?? defaultConfig.clauseChunkPauseMs),
      defaultConfig.clauseChunkPauseMs,
    ),
    defaultChunkPauseMs: normalizePositiveInteger(
      typeof pluginOptions.defaultChunkPauseMs === "number"
        ? pluginOptions.defaultChunkPauseMs
        : Number(process.env.OPENCODE_TTS_DEFAULT_CHUNK_PAUSE_MS ?? defaultConfig.defaultChunkPauseMs),
      defaultConfig.defaultChunkPauseMs,
    ),
    device: normalizeDevice(
      typeof pluginOptions.device === "string"
        ? pluginOptions.device
        : process.env.OPENCODE_TTS_DEVICE ?? process.env.KOKORO_DEVICE,
      defaultConfig.device,
    ),
    dtype: normalizeDtype(
      typeof pluginOptions.dtype === "string"
        ? pluginOptions.dtype
        : process.env.OPENCODE_TTS_DTYPE ?? process.env.KOKORO_DTYPE,
      defaultConfig.dtype,
    ),
    fallbackDevice: "cpu",
    idleMessage: normalizeString(pluginOptions.idleMessage, process.env.OPENCODE_TTS_IDLE_MESSAGE ?? defaultConfig.idleMessage),
    leadingAudioPadMs: normalizePositiveInteger(
      typeof pluginOptions.leadingAudioPadMs === "number"
        ? pluginOptions.leadingAudioPadMs
        : Number(process.env.OPENCODE_TTS_LEADING_AUDIO_PAD_MS ?? defaultConfig.leadingAudioPadMs),
      defaultConfig.leadingAudioPadMs,
    ),
    maxTextLength: normalizePositiveInteger(
      typeof pluginOptions.maxTextLength === "number"
        ? pluginOptions.maxTextLength
        : Number(process.env.OPENCODE_TTS_MAX_TEXT_LENGTH ?? process.env.TTS_MAX_TEXT_LENGTH ?? defaultConfig.maxTextLength),
      defaultConfig.maxTextLength,
    ),
    model: normalizeString(pluginOptions.model, process.env.OPENCODE_TTS_MODEL ?? process.env.KOKORO_MODEL ?? defaultConfig.model),
    playerArgs: parsePlayerArgs(pluginOptions.playerArgs ?? process.env.OPENCODE_TTS_PLAYER_ARGS ?? process.env.AUDIO_PLAYER_ARGS),
    playerBin: normalizeString(pluginOptions.playerBin, process.env.OPENCODE_TTS_PLAYER_BIN ?? process.env.AUDIO_PLAYER_BIN ?? defaultConfig.playerBin),
    readResponses: normalizeBoolean(
      pluginOptions.readResponses,
      process.env.OPENCODE_TTS_READ_RESPONSES !== "false",
    ),
    speechChunkLength,
    speed: normalizePositiveNumber(
      typeof pluginOptions.speed === "number"
        ? pluginOptions.speed
        : Number(process.env.OPENCODE_TTS_SPEED ?? process.env.KOKORO_SPEED ?? defaultConfig.speed),
      defaultConfig.speed,
    ),
    streamSoftLimit: Math.min(
      speechChunkLength,
      normalizePositiveInteger(
        typeof pluginOptions.streamSoftLimit === "number"
          ? pluginOptions.streamSoftLimit
          : Number(process.env.OPENCODE_TTS_STREAM_SOFT_LIMIT ?? process.env.TTS_STREAM_SOFT_LIMIT ?? defaultConfig.streamSoftLimit),
        defaultConfig.streamSoftLimit,
      ),
    ),
    trimSilenceThreshold: normalizePositiveNumber(
      typeof pluginOptions.trimSilenceThreshold === "number"
        ? pluginOptions.trimSilenceThreshold
        : Number(process.env.OPENCODE_TTS_SILENCE_THRESHOLD ?? defaultConfig.trimSilenceThreshold),
      defaultConfig.trimSilenceThreshold,
    ),
    voice: normalizeString(pluginOptions.voice, process.env.OPENCODE_TTS_VOICE ?? process.env.KOKORO_VOICE ?? defaultConfig.voice),
  };
}

export function createDebugLog(config: TtsConfig): DebugLog {
  const filePath = path.join(config.cacheDir, "debug.log");

  try {
    mkdirSync(config.cacheDir, { recursive: true });
  } catch {
    // Ignore logger directory creation failures.
  }

  return (message, data) => {
    try {
      const suffix = data ? ` ${JSON.stringify(data)}` : "";
      appendFileSync(filePath, `${new Date().toISOString()} ${message}${suffix}\n`, "utf8");
    } catch {
      // Ignore debug logging failures.
    }
  };
}

export function normalizeSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " Code omitted. ")
    .replace(/\[([^\]]+)\]\([^\)]+\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t\f\v]*\n+[ \t\f\v]*/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,;:.!?])/gu, "$1")
    .trim();
}

export function createSpeechStreamID(sessionID: string, messageID: string): string {
  return `${sessionID}:${messageID}`;
}

function splitLongWord(word: string, maxLength: number): string[] {
  const chunks = [];

  for (let index = 0; index < word.length; index += maxLength) {
    chunks.push(word.slice(index, index + maxLength));
  }

  return chunks;
}

export function splitSpeechText(text: string, maxLength: number): string[] {
  if (!text) {
    return [];
  }

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  const pushChunk = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
  };

  const sentences = text.split(/(?<=[.!?])\s+/u);
  let current = "";

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) {
      continue;
    }

    if (trimmedSentence.length > maxLength) {
      pushChunk(current);
      current = "";

      let wordChunk = "";
      for (const word of trimmedSentence.split(/\s+/u)) {
        if (!word) {
          continue;
        }

        if (word.length > maxLength) {
          pushChunk(wordChunk);
          wordChunk = "";
          for (const splitWord of splitLongWord(word, maxLength)) {
            pushChunk(splitWord);
          }
          continue;
        }

        const candidate = wordChunk ? `${wordChunk} ${word}` : word;
        if (candidate.length > maxLength) {
          pushChunk(wordChunk);
          wordChunk = word;
          continue;
        }

        wordChunk = candidate;
      }

      pushChunk(wordChunk);
      continue;
    }

    const candidate = current ? `${current} ${trimmedSentence}` : trimmedSentence;
    if (candidate.length > maxLength) {
      pushChunk(current);
      current = trimmedSentence;
      continue;
    }

    current = candidate;
  }

  pushChunk(current);
  return chunks;
}

export function extractSpeakableSegments(
  text: string,
  flush: boolean,
  softLimit: number,
): { remainder: string; segments: string[] } {
  const segments = [];
  let current = "";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    const nextCharacter = text[index + 1] ?? "";
    current += character;

    const punctuationBoundary = /[.!?]/u.test(character) && (!nextCharacter || /\s/u.test(nextCharacter));
    const softBoundary = current.length >= softLimit && /\s/u.test(character);

    if (punctuationBoundary || softBoundary) {
      segments.push(current);
      current = "";
    }
  }

  if (flush && current.trim()) {
    segments.push(current);
    current = "";
  }

  return {
    remainder: current,
    segments,
  };
}
