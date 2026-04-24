import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { DebugLog, KokoroAudioLike, KokoroStreamChunk, TtsConfig } from "./shared.js";

const HELPER_READY_TIMEOUT_MS = 5000;
const SENTENCE_CHUNK_PAUSE_MS = 140;

export interface PlaybackController {
  cancelled: boolean;
  playerInput?: Writable;
  playerPid?: number;
  playerProcess?: ChildProcess;
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

function getChunkPauseMs(config: TtsConfig, text: string): number {
  if (/[.!?]["')\]]*$/u.test(text)) {
    return SENTENCE_CHUNK_PAUSE_MS;
  }

  if (/[,;:]["')\]]*$/u.test(text)) {
    return config.clauseChunkPauseMs;
  }

  return config.defaultChunkPauseMs;
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

function getNodeExecutable(): string {
  return process.env.NODE || process.env.npm_node_execpath || "node";
}

async function resolveHelperScriptPath(): Promise<string> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(currentDir, "player-helper.js"),
    path.join(currentDir, "..", "dist", "player-helper.js"),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next packaged location.
    }
  }

  throw new Error("unable to locate the audio helper runtime; run the package build so dist/player-helper.js is available");
}

async function waitForHelperReady(child: ChildProcess, stderrChunks: string[]): Promise<number> {
  const stdout = child.stdout;
  if (!stdout) {
    throw new Error("audio helper did not expose a readable stdout");
  }

  stdout.setEncoding("utf8");

  return await new Promise<number>((resolve, reject) => {
    let buffer = "";

    const cleanup = () => {
      clearTimeout(timeout);
      stdout.off("data", handleData);
      child.off("error", handleError);
      child.off("close", handleClose);
    };

    const fail = (message: string) => {
      cleanup();
      reject(new Error(message));
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const handleClose = (code: number | null, signal: NodeJS.Signals | null) => {
      const stderr = stderrChunks.join("").trim();
      const suffix = signal ? ` (signal ${signal})` : code === null ? "" : ` (code ${code})`;
      fail(stderr || `audio helper exited before startup completed${suffix}`);
    };

    const handleData = (chunk: string) => {
      buffer += chunk;

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }

        try {
          const message = JSON.parse(line) as { port?: number; type?: string };
          if (message.type === "ready" && Number.isInteger(message.port) && (message.port ?? 0) > 0) {
            cleanup();
            resolve(message.port as number);
            return;
          }
        } catch {
          // Ignore non-protocol output until the helper announces readiness.
        }
      }
    };

    const timeout = setTimeout(() => {
      fail("audio helper timed out during startup");
    }, HELPER_READY_TIMEOUT_MS);

    stdout.on("data", handleData);
    child.on("error", handleError);
    child.on("close", handleClose);
  });
}

async function connectToHelper(port: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });

    const cleanup = () => {
      socket.off("connect", handleConnect);
      socket.off("error", handleError);
    };

    const handleConnect = () => {
      cleanup();
      resolve(socket);
    };

    const handleError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };

    socket.on("connect", handleConnect);
    socket.on("error", handleError);
  });
}

function createHelperDonePromise(child: ChildProcess, stderrChunks: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        resolve();
        return;
      }

      const stderr = stderrChunks.join("").trim();
      const suffix = signal ? ` (signal ${signal})` : code === null ? "" : ` (code ${code})`;
      reject(new Error(stderr || `audio helper exited unexpectedly${suffix}`));
    });
  });
}

async function createPcmPlayer(sampleRate: number, config: TtsConfig) {
  const helperPath = await resolveHelperScriptPath();
  const stderrChunks: string[] = [];
  const child = spawn(getNodeExecutable(), [helperPath], {
    detached: true,
    env: {
      ...process.env,
      OPENCODE_TTS_PLAYER_ARGS: JSON.stringify(config.playerArgs),
      OPENCODE_TTS_PLAYER_BIN: config.playerBin,
      OPENCODE_TTS_PLAYER_SAMPLE_RATE: String(sampleRate),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
  });

  const done = createHelperDonePromise(child, stderrChunks);

  try {
    const port = await waitForHelperReady(child, stderrChunks);
    const stdin = await connectToHelper(port);
    return {
      child,
      done,
      stdin,
    };
  } catch (error) {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore helper shutdown errors during failed startup.
      }
    }

    try {
      await done;
    } catch {
      // Preserve the original startup error.
    }

    throw error;
  }
}

async function writeToPlayer(stream: Writable, buffer: Buffer): Promise<void> {
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

async function closePlayerInput(stream: Writable): Promise<void> {
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

function closePlayerInputQuietly(stream: Writable | undefined): void {
  if (!stream || stream.destroyed) {
    return;
  }

  try {
    stream.end();
  } catch {
    try {
      stream.destroy();
    } catch {
      // Ignore shutdown errors during forced playback teardown.
    }
  }
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

function killProcessQuietly(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid) {
    return;
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      // Ignore process shutdown errors during forced playback teardown.
    }
  }
}

export function cancelPlayback(controller: PlaybackController, debug?: DebugLog): void {
  controller.cancelled = true;

  const playerInput = controller.playerInput;
  const playerPid = controller.playerPid;
  const playerProcess = controller.playerProcess;
  controller.playerInput = undefined;
  controller.playerPid = undefined;
  controller.playerProcess = undefined;

  debug?.("cancelPlayback", {
    hasInput: Boolean(playerInput),
    inputDestroyed: playerInput?.destroyed ?? null,
    hasPid: Boolean(playerPid),
    playerPid: playerPid ?? null,
    hasProcess: Boolean(playerProcess),
    processKilled: playerProcess?.killed ?? null,
  });

  closePlayerInputQuietly(playerInput);
  killProcessQuietly(playerPid);

  if (playerProcess && !playerProcess.killed) {
    try {
      playerProcess.kill("SIGTERM");
    } catch {
      // Ignore process shutdown errors during forced playback teardown.
    }
  }
}

export async function playGeneratedStream(
  config: TtsConfig,
  stream: AsyncGenerator<KokoroStreamChunk, void, void>,
  controller: PlaybackController,
  debug?: DebugLog,
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  let nextChunkPromise: Promise<IteratorResult<KokoroStreamChunk, void>> | undefined;
  let player: Awaited<ReturnType<typeof createPcmPlayer>> | undefined;

  try {
    debug?.("playGeneratedStream.start", { playerBin: config.playerBin });

    if (controller.cancelled) {
      debug?.("playGeneratedStream.cancelled.before-first-chunk");
      await cancelIterator(iterator);
      return;
    }

    let result = await iterator.next();
    if (result.done || controller.cancelled) {
      debug?.("playGeneratedStream.cancelled.after-first-chunk", { done: result.done, cancelled: controller.cancelled });
      await cancelIterator(iterator);
      return;
    }

    const sampleRate = getSampleRate(result.value.audio);
    player = await createPcmPlayer(sampleRate, config);
    controller.playerInput = player.stdin;
    controller.playerPid = player.child.pid;
    controller.playerProcess = player.child;

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
      debug?.("playGeneratedStream.cancelled");
      try {
        await player.done;
      } catch {
        // Ignore helper shutdown errors after explicit cancellation.
      }
      await cancelIterator(iterator);
      return;
    }

    await closePlayerInput(player.stdin);
    await player.done;
  } catch (error) {
    debug?.("playGeneratedStream.error", {
      cancelled: controller.cancelled,
      error: error instanceof Error ? error.message : String(error),
    });

    if (nextChunkPromise) {
      void nextChunkPromise.catch(() => {});
    }

    if (player && !controller.cancelled) {
      closePlayerInputQuietly(player.stdin);
      if (!player.child.killed) {
        try {
          player.child.kill("SIGTERM");
        } catch {
          // Ignore helper shutdown errors and keep the original failure.
        }
      }
    }

    if (player) {
      try {
        await player.done;
      } catch {
        // Ignore helper shutdown errors and keep the original failure.
      }
    }

    await cancelIterator(iterator);

    if (!controller.cancelled) {
      throw error;
    }
  } finally {
    controller.playerInput = undefined;
    controller.playerPid = undefined;
    controller.playerProcess = undefined;
  }
}
