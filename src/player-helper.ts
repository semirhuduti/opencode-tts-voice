import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Socket } from "node:net";

type HelperConfig = {
  playerArgs: string[];
  playerBin: string;
  sampleRate: number;
};

type StreamBackend = {
  args(sampleRate: number, playerArgs: string[]): string[];
  command: string;
};

function loadConfig(): HelperConfig {
  const sampleRate = Number(process.env.OPENCODE_TTS_PLAYER_SAMPLE_RATE ?? "24000");
  const playerBin = process.env.OPENCODE_TTS_PLAYER_BIN?.trim() || "ffplay";
  const rawArgs = process.env.OPENCODE_TTS_PLAYER_ARGS;

  let playerArgs: string[] = [];
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (Array.isArray(parsed)) {
        playerArgs = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      }
    } catch {
      // Ignore malformed player args and fall back to defaults.
    }
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`invalid sample rate '${process.env.OPENCODE_TTS_PLAYER_SAMPLE_RATE ?? ""}'`);
  }

  return {
    playerArgs,
    playerBin,
    sampleRate: Math.floor(sampleRate),
  };
}

function getBackend(config: HelperConfig): StreamBackend {
  if (config.playerBin === "ffplay") {
    return {
      command: config.playerBin,
      args(sampleRate: number, playerArgs: string[]) {
        return [
          "-nodisp",
          "-autoexit",
          "-loglevel",
          "quiet",
          ...playerArgs,
          "-f",
          "s16le",
          "-ar",
          String(sampleRate),
          "-ac",
          "1",
          "pipe:0",
        ];
      },
    };
  }

  if (config.playerBin === "mpv") {
    return {
      command: config.playerBin,
      args(sampleRate: number, playerArgs: string[]) {
        return [
          "--no-terminal",
          "--really-quiet",
          ...playerArgs,
          `--audio-samplerate=${sampleRate}`,
          "--audio-channels=mono",
          "--demuxer=rawaudio",
          "--demuxer-rawaudio-format=s16le",
          `--demuxer-rawaudio-rate=${sampleRate}`,
          "fd://0",
        ];
      },
    };
  }

  throw new Error(`unsupported audio backend '${config.playerBin}'. Use 'ffplay' or 'mpv'.`);
}

function createPlayback(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal === "SIGTERM" || signal === "SIGINT") {
        resolve();
        return;
      }

      reject(new Error(`audio backend exited unexpectedly${signal ? ` (signal ${signal})` : code === null ? "" : ` (code ${code})`}`));
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const backend = getBackend(config);
  const child = spawn(backend.command, backend.args(config.sampleRate, config.playerArgs), {
    stdio: ["pipe", "ignore", "ignore"],
  });

  if (!child.stdin) {
    throw new Error(`${backend.command} did not expose a writable stdin`);
  }

  const playbackDone = createPlayback(child);
  let activeSocket: Socket | undefined;

  const server = createServer((socket) => {
    if (activeSocket) {
      socket.destroy();
      return;
    }

    activeSocket = socket;

    socket.on("error", () => {
      if (activeSocket === socket) {
        activeSocket = undefined;
      }
    });

    socket.on("close", () => {
      if (activeSocket === socket) {
        activeSocket = undefined;
      }

      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
    });

    socket.pipe(child.stdin);
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("audio helper failed to bind an ephemeral port");
  }

  process.stdout.write(`${JSON.stringify({ port: address.port, type: "ready" })}\n`);

  const shutdown = () => {
    activeSocket?.destroy();
    server.close();

    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore backend shutdown errors during forced helper teardown.
      }
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await playbackDone;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    activeSocket?.destroy();
    server.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
