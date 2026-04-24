import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { cancelPlayback, type PlaybackController, playGeneratedStream } from "./player.js";
import {
  type DebugLog,
  type KokoroModule,
  type KokoroRuntime,
  type KokoroTextSplitterStream,
  type LoadedKokoroModule,
  type RuntimeDevice,
  type SpeakResult,
  type TransformersModule,
  type TtsConfig,
  extractSpeakableSegments,
  normalizeSpeechText,
  splitSpeechText,
} from "./shared.js";

interface SpeechStreamState {
  cancelled: boolean;
  closed: boolean;
  controller: PlaybackController;
  rawPendingText: string;
  splitter: KokoroTextSplitterStream;
  streamID: string;
}

export interface TtsEngine {
  appendStream(streamID: string, text: string): Promise<void>;
  cancelStream(streamID: string): Promise<void>;
  finishStream(streamID: string): Promise<void>;
  speak(text: string): Promise<SpeakResult>;
  speakNow(text: string): Promise<boolean>;
  stopAll(): Promise<void>;
  stopAllSync(): void;
}

const requireFromPlugin = createRequire(import.meta.url);

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
    "import { mkdir } from 'node:fs/promises';",
    "import { pathToFileURL } from 'node:url';",
    "const runtimePath = process.env.OPENCODE_TTS_PROBE_RUNTIME_PATH;",
    "const transformersPath = process.env.OPENCODE_TTS_PROBE_TRANSFORMERS_PATH;",
    "if (!runtimePath || !transformersPath) throw new Error('probe runtime paths unavailable');",
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

  const nodeExecutable = process.env.NODE || process.env.npm_node_execpath || "node";
  const runtimePath = requireFromPlugin.resolve("kokoro-js");
  const transformersPath = requireFromPlugin.resolve("@huggingface/transformers", {
    paths: [path.dirname(runtimePath)],
  });

  return await new Promise<boolean>((resolve) => {
    const child = spawn(nodeExecutable, ["--input-type=module", "-e", probeScript], {
      env: {
        ...process.env,
        OPENCODE_TTS_PROBE_CACHE_DIR: config.cacheDir,
        OPENCODE_TTS_PROBE_DEVICE: device,
        OPENCODE_TTS_PROBE_DTYPE: config.dtype,
        OPENCODE_TTS_PROBE_MODEL: config.model,
        OPENCODE_TTS_PROBE_RUNTIME_PATH: runtimePath,
        OPENCODE_TTS_PROBE_TRANSFORMERS_PATH: transformersPath,
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

export function createTtsEngine(config: TtsConfig, debug?: DebugLog): TtsEngine {
  let deviceCandidatesPromise: Promise<RuntimeDevice[]> | undefined;
  let kokoroModulePromise: Promise<LoadedKokoroModule> | undefined;
  let ttsPromise: Promise<KokoroRuntime> | undefined;
  let queueTail = Promise.resolve();
  const speechStreams = new Map<string, Promise<SpeechStreamState>>();
  const resolvedSpeechStreams = new Map<string, SpeechStreamState>();
  const activeControllers = new Set<PlaybackController>();

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

    activeControllers.add(controller);
    try {
      await playGeneratedStream(config, stream, controller, debug);
    } finally {
      activeControllers.delete(controller);
    }
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
    resolvedSpeechStreams.set(streamID, state);

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

      activeControllers.add(state.controller);
      try {
        await playGeneratedStream(config, stream, state.controller, debug);
      } finally {
        activeControllers.delete(state.controller);
      }
    });

    void playback.catch(() => {}).finally(() => {
      speechStreams.delete(streamID);
      resolvedSpeechStreams.delete(streamID);
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

  function cancelSpeechStream(streamState: SpeechStreamState): void {
    if (streamState.cancelled) {
      return;
    }

    streamState.cancelled = true;
    streamState.closed = true;
    streamState.rawPendingText = "";
    cancelPlayback(streamState.controller, debug);

    try {
      streamState.splitter.close();
    } catch {
      // Ignore shutdown errors while closing the speech stream.
    }
  }

  async function appendStream(streamID: string, text: string): Promise<void> {
    if (!text) {
      return;
    }

    const streamState = await getSpeechStream(streamID);
    if (streamState.closed) {
      throw new Error("speech stream already closed");
    }

    pushTextToSpeechStream(streamState, text, false);
  }

  async function cancelStream(streamID: string): Promise<void> {
    const statePromise = speechStreams.get(streamID);
    if (!statePromise) {
      return;
    }

    const streamState = await statePromise.catch(() => undefined);
    debug?.("cancelStream", { streamID, found: Boolean(streamState), alreadyCancelled: streamState?.cancelled ?? null });
    if (!streamState || streamState.cancelled) {
      return;
    }

    cancelSpeechStream(streamState);
  }

  async function finishStream(streamID: string): Promise<void> {
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
  }

  async function speak(text: string): Promise<SpeakResult> {
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
  }

  async function speakNow(text: string): Promise<boolean> {
    const result = await speak(text);
    return result === "spoken";
  }

  async function stopAll(): Promise<void> {
    debug?.("stopAll.start", { streamCount: speechStreams.size, controllerCount: activeControllers.size });
    for (const streamID of speechStreams.keys()) {
      await cancelStream(streamID);
    }

    for (const controller of activeControllers) {
      cancelPlayback(controller, debug);
    }
    debug?.("stopAll.done", { streamCount: speechStreams.size, controllerCount: activeControllers.size });
  }

  function stopAllSync(): void {
    debug?.("stopAllSync.start", { streamCount: resolvedSpeechStreams.size, controllerCount: activeControllers.size });

    for (const streamState of resolvedSpeechStreams.values()) {
      cancelSpeechStream(streamState);
    }

    for (const controller of activeControllers) {
      cancelPlayback(controller, debug);
    }

    debug?.("stopAllSync.done", { streamCount: resolvedSpeechStreams.size, controllerCount: activeControllers.size });
  }

  return {
    appendStream,
    cancelStream,
    finishStream,
    speak,
    speakNow,
    stopAll,
    stopAllSync,
  };
}
