import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Plugin, PluginOptions } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

type MessageRole = "assistant" | "user";
type RuntimeDevice = "cpu" | "cuda" | "dml" | "gpu" | "wasm" | "webgpu" | null;
type RuntimeDtype = "fp32" | "fp16" | "q4" | "q4f16" | "q8";
type SpeakResult = "failed" | "skipped" | "spoken";

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
  };
  type: "message.updated";
};

type MessageRemovedEvent = {
  properties: {
    messageID: string;
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
    delta?: string;
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

type PluginEvent =
  | MessagePartUpdatedEvent
  | MessageRemovedEvent
  | MessageUpdatedEvent
  | SessionIdleEvent
  | {
      type: string;
    };

type VoicePluginOptions = {
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
  speechChunkLength?: number;
  speed?: number;
  streamSoftLimit?: number;
  trimSilenceThreshold?: number;
  voice?: string;
};

interface MessageState {
  completed: boolean;
  partTextById: Map<string, string>;
  role?: MessageRole;
  sessionID: string;
  streamID: string;
}

interface TtsConfig {
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

interface KokoroAudioLike {
  audio?: Float32Array | ArrayLike<number>;
  data?: Float32Array | ArrayLike<number>;
  sampleRate?: number;
  sampling_rate?: number;
}

interface KokoroStreamChunk {
  audio: KokoroAudioLike;
  phonemes: string;
  text: string;
}

interface KokoroTextSplitterStream extends AsyncIterable<string> {
  close(): void;
  flush(): void;
  push(...texts: string[]): void;
}

interface KokoroRuntime {
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

interface KokoroModule {
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

interface LoadedKokoroModule {
  KokoroTTS: NonNullable<KokoroModule["KokoroTTS"]>;
  TextSplitterStream: NonNullable<KokoroModule["TextSplitterStream"]>;
}

interface TransformersEnvironment {
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  cacheDir: string;
  useBrowserCache: boolean;
  useFS: boolean;
  useFSCache: boolean;
}

interface TransformersModule {
  default?: {
    env?: TransformersEnvironment;
  };
  env?: TransformersEnvironment;
}

interface PlaybackController {
  cancelled: boolean;
  playerInput?: ReturnType<typeof createPcmPlayer>["stdin"];
}

interface SpeechStreamState {
  cancelled: boolean;
  closed: boolean;
  controller: PlaybackController;
  rawPendingText: string;
  splitter: KokoroTextSplitterStream;
  streamID: string;
}

const requireFromPlugin = createRequire(import.meta.url);

const SILENCE_THRESHOLD = 0.001;
const LEADING_AUDIO_PAD_MS = 12;
const DEFAULT_CHUNK_PAUSE_MS = 50;
const CLAUSE_CHUNK_PAUSE_MS = 80;
const SENTENCE_CHUNK_PAUSE_MS = 140;

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
  playerArgs: ["-q"],
  playerBin: "aplay",
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

function loadConfig(options?: PluginOptions): TtsConfig {
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

function normalizeSpeechText(text: string): string {
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

function createSpeechStreamID(sessionID: string, messageID: string): string {
  return `${sessionID}:${messageID}`;
}

function splitLongWord(word: string, maxLength: number): string[] {
  const chunks = [];

  for (let index = 0; index < word.length; index += maxLength) {
    chunks.push(word.slice(index, index + maxLength));
  }

  return chunks;
}

function splitSpeechText(text: string, maxLength: number): string[] {
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

function extractSpeakableSegments(
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

function getChunkPauseMs(config: TtsConfig, text: string): number {
  if (/[.!?]["')\]]*$/u.test(text)) {
    return SENTENCE_CHUNK_PAUSE_MS;
  }

  if (/[,;:]["')\]]*$/u.test(text)) {
    return config.clauseChunkPauseMs;
  }

  return config.defaultChunkPauseMs;
}

function getAudioSamples(audio: KokoroAudioLike): Float32Array {
  const rawSamples = audio.audio ?? audio.data;
  return rawSamples instanceof Float32Array ? rawSamples : Float32Array.from(rawSamples ?? []);
}

function getSampleRate(audio: KokoroAudioLike): number {
  return typeof audio.sampling_rate === "number"
    ? audio.sampling_rate
    : typeof audio.sampleRate === "number"
      ? audio.sampleRate
      : 24000;
}

function trimChunkAudio(config: TtsConfig, chunk: KokoroStreamChunk): Float32Array {
  const audio = getAudioSamples(chunk.audio);
  const sampleRate = getSampleRate(chunk.audio);
  let first = -1;
  let last = -1;

  for (let index = 0; index < audio.length; index += 1) {
    if (Math.abs(audio[index] ?? 0) > config.trimSilenceThreshold) {
      first = index;
      break;
    }
  }

  for (let index = audio.length - 1; index >= 0; index -= 1) {
    if (Math.abs(audio[index] ?? 0) > config.trimSilenceThreshold) {
      last = index;
      break;
    }
  }

  if (first < 0 || last < 0) {
    return audio;
  }

  const leadingPad = Math.round((sampleRate * config.leadingAudioPadMs) / 1000);
  const trailingPad = Math.round((sampleRate * getChunkPauseMs(config, chunk.text.trim())) / 1000);
  const start = Math.max(0, first - leadingPad);
  const end = Math.min(audio.length, last + trailingPad + 1);

  return audio.subarray(start, end);
}

function createPcmPlayer(sampleRate: number, config: TtsConfig) {
  const child = spawn(config.playerBin, [
    ...config.playerArgs,
    "-t",
    "raw",
    "-f",
    "S16_LE",
    "-c",
    "1",
    "-r",
    String(sampleRate),
  ], {
    stdio: ["pipe", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${config.playerBin} exited with code ${code}`));
    });
  });

  return {
    done,
    stdin: child.stdin,
  };
}

function toPcm16Buffer(audio: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(audio.length * 2);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  for (let index = 0; index < audio.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, audio[index] ?? 0));
    const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * 2, Math.round(value), true);
  }

  return buffer;
}

async function writeToPlayer(
  stream: ReturnType<typeof createPcmPlayer>["stdin"],
  buffer: Buffer,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      stream.off("error", handleError);
      reject(error);
    };

    stream.once("error", handleError);
    stream.write(buffer, (error?: Error | null) => {
      stream.off("error", handleError);

      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function closePlayerInput(stream: ReturnType<typeof createPcmPlayer>["stdin"]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      stream.off("error", handleError);
      reject(error);
    };

    stream.once("error", handleError);
    stream.end(() => {
      stream.off("error", handleError);
      resolve();
    });
  });
}

async function cancelIterator(iterator: AsyncIterator<KokoroStreamChunk, void, void>): Promise<void> {
  if (typeof iterator.return !== "function") {
    return;
  }

  try {
    await iterator.return();
  } catch {
    // Ignore shutdown errors while cancelling playback.
  }
}

function cancelPlayback(controller: PlaybackController): void {
  controller.cancelled = true;

  if (controller.playerInput && !controller.playerInput.destroyed) {
    controller.playerInput.destroy(new Error("speech cancelled"));
  }
}

async function playGeneratedStream(
  config: TtsConfig,
  stream: AsyncGenerator<KokoroStreamChunk, void, void>,
  controller: PlaybackController,
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  let nextChunkPromise: Promise<IteratorResult<KokoroStreamChunk, void>> | undefined;
  let player: ReturnType<typeof createPcmPlayer> | undefined;

  try {
    if (controller.cancelled) {
      await cancelIterator(iterator);
      return;
    }

    let result = await iterator.next();
    if (result.done || controller.cancelled) {
      await cancelIterator(iterator);
      return;
    }

    const sampleRate = getSampleRate(result.value.audio);
    player = createPcmPlayer(sampleRate, config);
    controller.playerInput = player.stdin;

    nextChunkPromise = iterator.next();
    await writeToPlayer(player.stdin, toPcm16Buffer(trimChunkAudio(config, result.value)));

    while (true) {
      result = await nextChunkPromise;
      if (result.done || controller.cancelled) {
        break;
      }

      const chunkRate = getSampleRate(result.value.audio);
      if (chunkRate !== sampleRate) {
        throw new Error(`inconsistent sample rate: ${chunkRate} !== ${sampleRate}`);
      }

      nextChunkPromise = iterator.next();
      await writeToPlayer(player.stdin, toPcm16Buffer(trimChunkAudio(config, result.value)));
    }

    if (controller.cancelled) {
      player.stdin.destroy(new Error("speech cancelled"));
      try {
        await player.done;
      } catch {
        // Ignore player shutdown errors after explicit cancellation.
      }
      await cancelIterator(iterator);
      return;
    }

    await closePlayerInput(player.stdin);
    await player.done;
  } catch (error) {
    if (nextChunkPromise) {
      void nextChunkPromise.catch(() => {});
    }

    if (player?.stdin && !player.stdin.destroyed) {
      player.stdin.destroy(error instanceof Error ? error : new Error(String(error)));
    }

    if (player) {
      try {
        await player.done;
      } catch {
        // Ignore player shutdown errors and keep the original failure.
      }
    }

    await cancelIterator(iterator);

    if (!controller.cancelled) {
      throw error;
    }
  } finally {
    controller.playerInput = undefined;
  }
}

async function configureTransformersEnvironment(cacheDir: string): Promise<void> {
  const kokoroRuntimePath = requireFromPlugin.resolve("kokoro-js");
  const transformersRuntimePath = requireFromPlugin.resolve("@huggingface/transformers", {
    paths: [path.dirname(kokoroRuntimePath)],
  });
  const transformersRuntime = await import(pathToFileURL(transformersRuntimePath).href) as TransformersModule;
  const env = transformersRuntime.env ?? transformersRuntime.default?.env;

  if (!env) {
    throw new Error(`Unable to resolve the transformers runtime from ${transformersRuntimePath}`);
  }

  await mkdir(cacheDir, { recursive: true });

  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  env.cacheDir = cacheDir;
  env.useFS = true;
  env.useFSCache = true;
  env.useBrowserCache = false;
}

function getCudaProviderLibraryPath(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }

  try {
    const packageJsonPath = requireFromPlugin.resolve("onnxruntime-node/package.json");
    return path.join(
      path.dirname(packageJsonPath),
      "bin",
      "napi-v3",
      process.platform,
      process.arch,
      "libonnxruntime_providers_cuda.so",
    );
  } catch {
    return undefined;
  }
}

async function canUseCudaProvider(): Promise<boolean> {
  const providerPath = getCudaProviderLibraryPath();
  if (!providerPath) {
    return false;
  }

  try {
    await access(providerPath);
  } catch {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const child = spawn("ldd", [providerPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";

    child.on("error", () => {
      resolve(false);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on("close", (code: number | null) => {
      resolve(code === 0 && !stdout.includes("not found"));
    });
  });
}

async function probeKokoroDevice(device: RuntimeDevice, config: TtsConfig): Promise<boolean> {
  if (device !== "gpu" && device !== "cuda") {
    return true;
  }

  if (!await canUseCudaProvider()) {
    return false;
  }

  const probeScript = [
    "import { createRequire } from 'node:module';",
    "import { mkdir } from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const require = createRequire(import.meta.url);",
    "const runtimePath = require.resolve('kokoro-js');",
    "const transformersPath = require.resolve('@huggingface/transformers', { paths: [path.dirname(runtimePath)] });",
    "const transformers = await import(pathToFileURL(transformersPath).href);",
    "const env = transformers.env ?? transformers.default?.env;",
    "if (!env) throw new Error('transformers env unavailable');",
    "await mkdir(process.env.OPENCODE_TTS_PROBE_CACHE_DIR, { recursive: true });",
    "env.allowLocalModels = true;",
    "env.allowRemoteModels = true;",
    "env.cacheDir = process.env.OPENCODE_TTS_PROBE_CACHE_DIR;",
    "env.useFS = true;",
    "env.useFSCache = true;",
    "env.useBrowserCache = false;",
    "const runtime = await import(pathToFileURL(runtimePath).href);",
    "await runtime.KokoroTTS.from_pretrained(process.env.OPENCODE_TTS_PROBE_MODEL, {",
    "  device: process.env.OPENCODE_TTS_PROBE_DEVICE,",
    "  dtype: process.env.OPENCODE_TTS_PROBE_DTYPE,",
    "});",
  ].join(" ");

  return await new Promise<boolean>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", probeScript], {
      env: {
        ...process.env,
        OPENCODE_TTS_PROBE_CACHE_DIR: config.cacheDir,
        OPENCODE_TTS_PROBE_DEVICE: device,
        OPENCODE_TTS_PROBE_DTYPE: config.dtype,
        OPENCODE_TTS_PROBE_MODEL: config.model,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";

    child.on("error", () => {
      resolve(false);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(true);
        return;
      }

      if (stderr.trim()) {
        console.warn(`[voice] ${device} probe failed: ${stderr.trim()}`);
      }
      resolve(false);
    });
  });
}

async function loadKokoroModule(): Promise<LoadedKokoroModule> {
  const modulePath = requireFromPlugin.resolve("kokoro-js");
  const module = await import(pathToFileURL(modulePath).href) as KokoroModule;

  if (!module.KokoroTTS || !module.TextSplitterStream) {
    throw new Error("The resolved kokoro-js module does not expose the required runtime APIs.");
  }

  return {
    KokoroTTS: module.KokoroTTS,
    TextSplitterStream: module.TextSplitterStream,
  };
}

function createTtsEngine(config: TtsConfig) {
  let deviceCandidatesPromise: Promise<RuntimeDevice[]> | undefined;
  let kokoroModulePromise: Promise<LoadedKokoroModule> | undefined;
  let ttsPromise: Promise<KokoroRuntime> | undefined;
  let queueTail = Promise.resolve();
  const speechStreams = new Map<string, Promise<SpeechStreamState>>();

  async function getDeviceCandidates(): Promise<RuntimeDevice[]> {
    if (!deviceCandidatesPromise) {
      deviceCandidatesPromise = (async () => {
        let preferredDevice = config.device;

        if ((preferredDevice === "gpu" || preferredDevice === "cuda") && !await probeKokoroDevice(preferredDevice, config)) {
          console.warn("[voice] GPU runtime probe failed, falling back to CPU before model load.");
          preferredDevice = config.fallbackDevice;
        }

        const candidates = [preferredDevice];

        if (preferredDevice !== config.fallbackDevice) {
          candidates.push(config.fallbackDevice);
        }

        return [...new Set(candidates)];
      })().catch((error) => {
        deviceCandidatesPromise = undefined;
        throw error;
      });
    }

    return deviceCandidatesPromise;
  }

  async function getKokoroModule(): Promise<LoadedKokoroModule> {
    if (!kokoroModulePromise) {
      kokoroModulePromise = loadKokoroModule().catch((error) => {
        kokoroModulePromise = undefined;
        throw error;
      });
    }

    return kokoroModulePromise;
  }

  async function loadTts(): Promise<KokoroRuntime> {
    await configureTransformersEnvironment(config.cacheDir);

    const runtime = await getKokoroModule();
    let loadError: unknown;

    for (const device of await getDeviceCandidates()) {
      try {
        return await runtime.KokoroTTS.from_pretrained(config.model, {
          device,
          dtype: config.dtype,
        });
      } catch (error) {
        loadError = error;
      }
    }

    throw loadError ?? new Error("unable to load Kokoro model");
  }

  async function getTts(): Promise<KokoroRuntime> {
    if (!ttsPromise) {
      ttsPromise = loadTts().catch((error) => {
        ttsPromise = undefined;
        throw error;
      });
    }

    return ttsPromise;
  }

  async function enqueuePlayback(task: () => Promise<void>): Promise<void> {
    const job = queueTail.then(task);
    queueTail = job.catch((error) => {
      console.error("[voice] speech failed", error);
    });
    return job;
  }

  async function speakText(text: string, controller: PlaybackController): Promise<void> {
    const normalizedText = normalizeSpeechText(text);
    if (!normalizedText) {
      return;
    }

    if (normalizedText.length > config.maxTextLength) {
      throw new Error(`text exceeds ${config.maxTextLength} characters`);
    }

    const runtime = await getKokoroModule();
    const splitter = new runtime.TextSplitterStream();
    for (const chunk of splitSpeechText(normalizedText, config.speechChunkLength)) {
      splitter.push(chunk);
      splitter.flush();
    }
    splitter.close();

    if (controller.cancelled) {
      return;
    }

    const tts = await getTts();
    const stream = tts.stream(splitter, {
      speed: config.speed,
      voice: config.voice,
    });

    await playGeneratedStream(config, stream, controller);
  }

  async function createSpeechStream(streamID: string): Promise<SpeechStreamState> {
    const runtime = await getKokoroModule();
    const state: SpeechStreamState = {
      cancelled: false,
      closed: false,
      controller: { cancelled: false },
      rawPendingText: "",
      splitter: new runtime.TextSplitterStream(),
      streamID,
    };

    const playback = enqueuePlayback(async () => {
      if (state.cancelled) {
        return;
      }

      const tts = await getTts();
      if (state.cancelled) {
        return;
      }

      const stream = tts.stream(state.splitter, {
        speed: config.speed,
        voice: config.voice,
      });

      await playGeneratedStream(config, stream, state.controller);
    });

    void playback.catch(() => {}).finally(() => {
      speechStreams.delete(streamID);
    });

    return state;
  }

  async function getSpeechStream(streamID: string): Promise<SpeechStreamState> {
    const existing = speechStreams.get(streamID);
    if (existing) {
      return existing;
    }

    const statePromise = createSpeechStream(streamID).catch((error) => {
      speechStreams.delete(streamID);
      throw error;
    });
    speechStreams.set(streamID, statePromise);
    return statePromise;
  }

  function pushTextToSpeechStream(streamState: SpeechStreamState, text: string, flush: boolean): void {
    streamState.rawPendingText += text;

    const { remainder, segments } = extractSpeakableSegments(
      streamState.rawPendingText,
      flush,
      config.streamSoftLimit,
    );
    streamState.rawPendingText = remainder;

    for (const segment of segments) {
      const normalizedText = normalizeSpeechText(segment);
      if (!normalizedText) {
        continue;
      }

      for (const chunk of splitSpeechText(normalizedText, config.speechChunkLength)) {
        streamState.splitter.push(chunk);
        streamState.splitter.flush();
      }
    }
  }

  return {
    async appendStream(streamID: string, text: string): Promise<void> {
      if (!text) {
        return;
      }

      const streamState = await getSpeechStream(streamID);
      if (streamState.closed) {
        throw new Error("speech stream already closed");
      }

      pushTextToSpeechStream(streamState, text, false);
    },
    async cancelStream(streamID: string): Promise<void> {
      const statePromise = speechStreams.get(streamID);
      if (!statePromise) {
        return;
      }

      const streamState = await statePromise.catch(() => undefined);
      if (!streamState || streamState.cancelled) {
        return;
      }

      streamState.cancelled = true;
      streamState.closed = true;
      streamState.rawPendingText = "";
      cancelPlayback(streamState.controller);
      streamState.splitter.close();
    },
    async finishStream(streamID: string): Promise<void> {
      const statePromise = speechStreams.get(streamID);
      if (!statePromise) {
        return;
      }

      const streamState = await statePromise.catch(() => undefined);
      if (!streamState || streamState.closed) {
        return;
      }

      pushTextToSpeechStream(streamState, "", true);
      streamState.closed = true;
      streamState.splitter.close();
    },
    async speak(text: string): Promise<SpeakResult> {
      if (!normalizeSpeechText(text)) {
        return "skipped";
      }

      const controller: PlaybackController = { cancelled: false };

      try {
        await enqueuePlayback(() => speakText(text, controller));
        return "spoken";
      } catch {
        return "failed";
      }
    },
  };
}

export const VoicePlugin: Plugin = async ({ client }, options) => {
  const config = loadConfig(options);
  const ttsEngine = createTtsEngine(config);
  const messageRoles = new Map<string, MessageRole>();
  const messageStates = new Map<string, MessageState>();
  const roleLookups = new Map<string, Promise<MessageRole | undefined>>();

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

  function clearMessageState(messageID: string, options?: { cancel?: boolean }) {
    const state = messageStates.get(messageID);
    if (state && (options?.cancel || !state.completed)) {
      void ttsEngine.cancelStream(state.streamID);
    }

    messageStates.delete(messageID);
    messageRoles.delete(messageID);
    roleLookups.delete(messageID);
  }

  async function queueSpeech(text: string): Promise<SpeakResult> {
    return ttsEngine.speak(text);
  }

  async function ensureMessageRole(sessionID: string, messageID: string): Promise<MessageRole | undefined> {
    const cachedRole = messageRoles.get(messageID);
    if (cachedRole) {
      return cachedRole;
    }

    if (!client) {
      return undefined;
    }

    const existingLookup = roleLookups.get(messageID);
    if (existingLookup) {
      return existingLookup;
    }

    const lookup = client.session.messages({ path: { id: sessionID } })
      .then((response) => {
        const matchedMessage = (response.data ?? []).find((message) => message.info.id === messageID);
        const role = matchedMessage?.info.role === "assistant" || matchedMessage?.info.role === "user"
          ? matchedMessage.info.role
          : undefined;

        if (role) {
          messageRoles.set(messageID, role);
          const state = messageStates.get(messageID);
          if (state) {
            state.role = role;
          }
        }

        return role;
      })
      .catch(() => undefined)
      .finally(() => {
        roleLookups.delete(messageID);
      });

    roleLookups.set(messageID, lookup);
    return lookup;
  }

  function getTextDelta(state: MessageState, part: TextPart, delta?: string): string {
    const previousText = state.partTextById.get(part.id) ?? "";
    const currentText = typeof part.text === "string" ? part.text : previousText;
    state.partTextById.set(part.id, currentText);

    if (typeof delta === "string" && delta) {
      return delta;
    }

    if (!currentText || currentText === previousText) {
      return "";
    }

    if (currentText.startsWith(previousText)) {
      return currentText.slice(previousText.length);
    }

    return currentText;
  }

  async function handleMessagePartUpdated(event: MessagePartUpdatedEvent) {
    const { delta, part } = event.properties;
    if (part.type !== "text" || part.ignored || part.synthetic) {
      return;
    }

    const textPart = part as TextPart;
    const state = getMessageState(textPart.messageID, textPart.sessionID);
    const role = state.role ?? await ensureMessageRole(textPart.sessionID, textPart.messageID);
    state.role = role;

    if (role !== "assistant") {
      return;
    }

    const textDelta = getTextDelta(state, textPart, delta);
    if (!textDelta) {
      return;
    }

    await ttsEngine.appendStream(state.streamID, textDelta);
  }

  async function handleMessageUpdated(event: MessageUpdatedEvent) {
    const messageInfo = event.properties.info;
    messageRoles.set(messageInfo.id, messageInfo.role);

    const state = messageStates.get(messageInfo.id);
    if (state) {
      state.role = messageInfo.role;
    }

    if (messageInfo.role !== "assistant" || !state) {
      return;
    }

    if (messageInfo.time?.completed || messageInfo.finish) {
      state.completed = true;
      await ttsEngine.finishStream(state.streamID);
      clearMessageState(messageInfo.id);
    }
  }

  function handleSessionIdle(event: SessionIdleEvent) {
    for (const [messageID, state] of messageStates.entries()) {
      if (state.sessionID === event.properties.sessionID) {
        state.completed = true;
        void ttsEngine.finishStream(state.streamID).finally(() => {
          clearMessageState(messageID);
        });
      }
    }

    if (config.announceOnIdle) {
      void queueSpeech(config.idleMessage);
    }
  }

  return {
    event: async ({ event }) => {
      const pluginEvent = event as PluginEvent;

      if (pluginEvent.type === "message.updated") {
        await handleMessageUpdated(pluginEvent as MessageUpdatedEvent);
        return;
      }

      if (!config.readResponses) {
        if (pluginEvent.type === "session.idle" && config.announceOnIdle) {
          handleSessionIdle(pluginEvent as SessionIdleEvent);
        }
        return;
      }

      if (pluginEvent.type === "message.part.updated") {
        await handleMessagePartUpdated(pluginEvent as MessagePartUpdatedEvent);
        return;
      }

      if (pluginEvent.type === "message.removed") {
        clearMessageState((pluginEvent as MessageRemovedEvent).properties.messageID, { cancel: true });
        return;
      }

      if (pluginEvent.type === "session.idle") {
        handleSessionIdle(pluginEvent as SessionIdleEvent);
      }
    },
    tool: {
      speak: tool({
        description: "Speak text aloud using the local Kokoro runtime.",
        args: {
          text: tool.schema.string().describe("The text to speak aloud"),
        },
        async execute(args) {
          const result = await queueSpeech(args.text);
          return result === "failed" ? `[TTS error] \"${args.text}\"` : `\"${args.text}\"`;
        },
      }),
    },
  };
};

export default VoicePlugin;
