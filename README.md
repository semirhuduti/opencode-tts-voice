# opencode-voice-tts

Local Kokoro TTS plugin for OpenCode.

This plugin moves speech generation and playback into the plugin itself. It does not require the old standalone HTTP TTS server.

## What It Does

- speaks the `speak` tool locally
- reads streamed assistant responses locally
- keeps the Kokoro model hot inside the plugin runtime
- uses `aplay` for local playback
- trims chunk silence and streams speech incrementally
- falls back to CPU if GPU runtime dependencies are unavailable

## Requirements

- Linux with `aplay` available
- OpenCode with plugin support

Optional:

- CUDA runtime libraries if you want GPU execution

If GPU libraries are missing, the plugin falls back to CPU.

## Install

If published to npm:

```bash
opencode plugin @semirhuduti/opencode-tts-voice
```

For local development right now, point OpenCode at this package from your config.

Example local path:

```json
{
  "plugin": [
    [
      "/home/semir/workspace/opencode-voice-tts/src/index.ts",
      {
        "device": "cpu"
      }
    ]
  ]
}
```

## OpenCode Config

OpenCode plugins support options in the config file. Example:

```json
{
  "plugin": [
    [
      "/home/semir/workspace/opencode-voice-tts/src/index.ts",
      {
        "voice": "af_heart",
        "speed": 1,
        "device": "gpu",
        "announceOnIdle": false,
        "readResponses": true,
        "speechChunkLength": 1000,
        "streamSoftLimit": 180
      }
    ]
  ]
}
```

## Plugin Options

Plugin options are preferred over environment variables.

| Option | Type | Accepted values | Default | What it does |
| --- | --- | --- | --- | --- |
| `voice` | string | Any supported Kokoro voice id listed below | `af_heart` | Selects the speaking voice. |
| `speed` | number | Any positive number | `1` | Controls playback speed for synthesis. Values above `1` are faster, below `1` are slower. |
| `device` | string | `auto`, `cpu`, `cuda`, `dml`, `gpu`, `wasm`, `webgpu` | `gpu` | Selects the preferred execution device. On Linux, `gpu` and `cpu` are the practical choices. |
| `dtype` | string | `fp32`, `fp16`, `q4`, `q4f16`, `q8` | `q8` | Controls model precision and memory usage. |
| `model` | string | Any Kokoro model id or compatible local model path | `onnx-community/Kokoro-82M-v1.0-ONNX` | Selects the model to load. |
| `cacheDir` | string | Any writable directory path | OS-specific cache dir under `opencode/kokoro` | Stores downloaded model artifacts. |
| `playerBin` | string | Any executable audio player command | `aplay` | Command used for raw PCM playback. |
| `playerArgs` | string or string[] | A whitespace-separated string or array of argument strings | `-q` | Extra arguments passed to the audio player command. |
| `readResponses` | boolean | `true`, `false` | `true` | Enables speaking streamed assistant responses. |
| `announceOnIdle` | boolean | `true`, `false` | `false` | Speaks the idle message when the session goes idle. |
| `idleMessage` | string | Any non-empty string | `Task completed.` | Message spoken when `announceOnIdle` is enabled. |
| `speechChunkLength` | number | Any positive integer | `1000` | Hard cap for TTS text chunks sent into the generator. |
| `streamSoftLimit` | number | Any positive integer up to `speechChunkLength` | `180` | Flush target for streamed assistant text before speech generation. |
| `maxTextLength` | number | Any positive integer | `2000` | Maximum text length accepted by the manual `speak` tool path. |
| `trimSilenceThreshold` | number | Any positive number | `0.001` | Amplitude threshold used when trimming silence around generated chunks. |
| `leadingAudioPadMs` | number | Any positive integer | `12` | Amount of leading padding preserved before detected speech starts. |
| `defaultChunkPauseMs` | number | Any positive integer | `50` | Trailing pause added after normal chunks. |
| `clauseChunkPauseMs` | number | Any positive integer | `80` | Trailing pause added after clause-ending punctuation like commas and semicolons. |

## Option Notes

- If `device` is set to `gpu` or `cuda`, the plugin probes GPU runtime support first and falls back to CPU if the local CUDA runtime is incomplete.
- If `streamSoftLimit` is larger than `speechChunkLength`, it is clamped down to `speechChunkLength`.
- Invalid option values fall back to the plugin defaults.
- `playerArgs` can be configured either as `"-q"` or as an array like `["-q"]`.

## Supported Voices

Current Kokoro voice ids supported by this plugin:

- `af_heart`
- `af_alloy`
- `af_aoede`
- `af_bella`
- `af_jessica`
- `af_kore`
- `af_nicole`
- `af_nova`
- `af_river`
- `af_sarah`
- `af_sky`
- `am_adam`
- `am_echo`
- `am_eric`
- `am_fenrir`
- `am_liam`
- `am_michael`
- `am_onyx`
- `am_puck`
- `am_santa`
- `bf_alice`
- `bf_emma`
- `bf_isabella`
- `bf_lily`
- `bm_daniel`
- `bm_fable`
- `bm_george`
- `bm_lewis`

The prefixes loosely map to accent and voice family:

- `af` and `am`: American English voices
- `bf` and `bm`: British English voices
- `f` and `m`: feminine and masculine voice variants

## Environment Variables

Environment variables are still supported for compatibility and ad hoc overrides:

- `OPENCODE_TTS_VOICE`
- `OPENCODE_TTS_SPEED`
- `OPENCODE_TTS_DEVICE`
- `OPENCODE_TTS_DTYPE`
- `OPENCODE_TTS_MODEL`
- `OPENCODE_TTS_CACHE_DIR`
- `OPENCODE_TTS_PLAYER_BIN`
- `OPENCODE_TTS_PLAYER_ARGS`
- `OPENCODE_TTS_READ_RESPONSES`
- `OPENCODE_TTS_ANNOUNCE_IDLE`
- `OPENCODE_TTS_IDLE_MESSAGE`
- `OPENCODE_TTS_CHUNK_LENGTH`
- `OPENCODE_TTS_STREAM_SOFT_LIMIT`
- `OPENCODE_TTS_MAX_TEXT_LENGTH`
- `OPENCODE_TTS_SILENCE_THRESHOLD`

## Notes

- No `/api/speech/*` endpoints are used.
- No standalone TTS server is required.
- On systems with broken CUDA installs, the plugin probes GPU support and falls back to CPU safely.

## Publishing

This repository is set up to publish compiled output from `dist/`.

Build the package:

```bash
npm run build
```

Publish after you have logged into npm:

```bash
npm publish --access public
```
