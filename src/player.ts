import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";

import type { DebugLog, KokoroAudioLike, KokoroStreamChunk, TtsConfig } from "./shared.js";

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
    stdio: ["pipe", "ignore", "ignore"],
  });

  if (!child.stdin) {
    throw new Error(`${config.playerBin} did not expose a writable stdin`);
  }

  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${config.playerBin} exited with code ${code}`));
    });
  });

  return {
    child,
    done,
    stdin: child.stdin,
  };
}

function createWavBuffer(audio: Float32Array, sampleRate: number): Buffer {
  const pcm = toPcm16Buffer(audio);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function isAfplayPlayer(config: TtsConfig): boolean {
  return process.platform === "darwin" && path.basename(config.playerBin) === "afplay";
}

function isAplayPlayer(config: TtsConfig): boolean {
  return process.platform === "linux" && path.basename(config.playerBin) === "aplay";
}

function useFilePlayback(config: TtsConfig): boolean {
  return isAfplayPlayer(config) || isAplayPlayer(config);
}

function useDetachedFilePlayback(config: TtsConfig): boolean {
  return isAplayPlayer(config);
}

async function spawnDetachedFilePlayer(config: TtsConfig, filePath: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        'player="$1"; shift; command -v -- "$player" >/dev/null 2>&1 || exit 127; "$player" "$@" </dev/null >/dev/null 2>&1 & printf "%s\\n" "$!"',
        "sh",
        config.playerBin,
        ...config.playerArgs,
        filePath,
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let stdout = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`failed to launch ${config.playerBin}: exit ${code}`));
        return;
      }

      const pid = Number.parseInt(stdout.trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        reject(new Error(`failed to launch ${config.playerBin}: invalid pid '${stdout.trim()}'`));
        return;
      }

      resolve(pid);
    });
  });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  while (isProcessRunning(pid)) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
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

async function playAudioFile(
  config: TtsConfig,
  filePath: string,
  controller: PlaybackController,
): Promise<void> {
  if (useDetachedFilePlayback(config)) {
    const pid = await spawnDetachedFilePlayer(config, filePath);
    controller.playerPid = pid;

    try {
      if (controller.cancelled) {
        killProcessQuietly(pid);
        return;
      }

      await waitForProcessExit(pid);
      return;
    } finally {
      if (controller.playerPid === pid) {
        controller.playerPid = undefined;
      }
    }
  }

  const child = spawn(config.playerBin, [...config.playerArgs, filePath], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  controller.playerProcess = child;

  try {
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code: number | null) => {
        if (controller.cancelled && code !== 0) {
          resolve();
          return;
        }

        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`${config.playerBin} exited with code ${code}`));
      });
    });
  } finally {
    if (controller.playerProcess === child) {
      controller.playerProcess = undefined;
    }
  }
}

async function playChunkViaFile(
  config: TtsConfig,
  audio: Float32Array,
  sampleRate: number,
  controller: PlaybackController,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-tts-"));
  const filePath = path.join(tempDir, "chunk.wav");

  try {
    await writeFile(filePath, createWavBuffer(audio, sampleRate));
    await playAudioFile(config, filePath, controller);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
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
  let player: ReturnType<typeof createPcmPlayer> | undefined;

  try {
    debug?.("playGeneratedStream.start", { filePlayback: useFilePlayback(config), playerBin: config.playerBin });

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
    if (useFilePlayback(config)) {
      nextChunkPromise = iterator.next();
      await playChunkViaFile(config, trimChunkAudio(config, result.value), sampleRate, controller);

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
        await playChunkViaFile(config, trimChunkAudio(config, result.value), sampleRate, controller);
      }

      if (controller.cancelled) {
        debug?.("playGeneratedStream.file.cancelled");
        await cancelIterator(iterator);
        return;
      }
    } else {
      player = createPcmPlayer(sampleRate, config);
      controller.playerInput = player.stdin;
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
        debug?.("playGeneratedStream.pipe.cancelled");
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
    }
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
          // Ignore process shutdown errors and keep the original failure.
        }
      }
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
    controller.playerPid = undefined;
    controller.playerProcess = undefined;
  }
}
