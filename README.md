# @semirhuduti/opencode-tts-voice

Voice output plugin for OpenCode powered by Kokoro, with TUI shortcut support for controlling playback.

## Features

- reads assistant responses aloud while they stream in the TUI
- adds TUI shortcuts for pause, replay latest response, and toggle on or off
- supports configurable voice, speed, model, precision, and playback settings
- supports CPU and GPU execution
- plays audio locally through an isolated helper process

## Requirements

- Linux, macOS, or Windows
- OpenCode with plugin support
- a local `ffplay` or `mpv` command available on the system

Defaults:

- all platforms: `ffplay`

The plugin now launches playback through a detached Node helper process. OpenCode streams PCM audio to the helper over a localhost socket, and the helper owns the actual player process. This isolates playback teardown from the Bun runtime and avoids the `aplay`/`afplay` shutdown path that was causing crashes.

Optional:

- CUDA and cuDNN runtime libraries for GPU execution

## Install

```bash
opencode plugin @semirhuduti/opencode-tts-voice --global
```

OpenCode loads the package automatically.

The voice runtime lives in the package `./tui` entrypoint and runs inside the terminal UI, which gives the plugin proper disposal handling on shutdown.

## Config

Example `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@semirhuduti/opencode-tts-voice",
      {
        "voice": "am_adam",
        "speed": 1.1,
        "dtype": "q4",
        "shortcuts": {
          "pause": "f6",
          "skipLatest": "f7",
          "toggle": "f8"
        }
      }
    ]
  ]
}
```

The plugin works with defaults, so the `shortcuts` block is optional unless you want custom keybinds.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `voice` | string | `af_heart` | Voice ID used for speech generation. |
| `speed` | number | `1` | Speech speed. Higher values are faster. |
| `device` | string | `gpu` | Preferred execution device. Accepted values: `auto`, `cpu`, `cuda`, `dml`, `gpu`, `wasm`, `webgpu`. |
| `dtype` | string | `q8` | Model precision. Accepted values: `fp32`, `fp16`, `q4`, `q4f16`, `q8`. |
| `model` | string | `onnx-community/Kokoro-82M-v1.0-ONNX` | Model ID or compatible local model path. |
| `cacheDir` | string | OS-specific cache directory | Directory used for model downloads and cache data. |
| `playerBin` | string | `ffplay` | Playback backend command. Supported values are `ffplay` and `mpv`. |
| `playerArgs` | string or string[] | `[]` | Additional arguments passed to the playback backend helper. |
| `readResponses` | boolean | `true` | Speak streamed assistant responses. |
| `announceOnIdle` | boolean | `false` | Speak a message when the session becomes idle. |
| `idleMessage` | string | `Task completed.` | Idle message text. |
| `speechChunkLength` | number | `1000` | Maximum chunk size sent to the TTS generator. |
| `streamSoftLimit` | number | `180` | Target flush size for streamed assistant text. |
| `maxTextLength` | number | `2000` | Maximum text length accepted by the `speak` tool. |
| `trimSilenceThreshold` | number | `0.001` | Silence threshold used when trimming generated chunks. |
| `leadingAudioPadMs` | number | `12` | Leading padding preserved before detected speech. |
| `defaultChunkPauseMs` | number | `50` | Pause added after normal chunks. |
| `clauseChunkPauseMs` | number | `80` | Pause added after clause-ending punctuation. |
| `shortcuts.pause` | string | `f6` | TUI shortcut for stopping the current voice playback. |
| `shortcuts.skipLatest` | string | `f7` | TUI shortcut for replaying the latest assistant message in the active session. |
| `shortcuts.toggle` | string | `f8` | TUI shortcut for toggling automatic voice playback on or off. |

## Shortcuts

Default TUI shortcuts:

- `f6`: pause current playback
- `f7`: replay the latest assistant message
- `f8`: toggle voice on or off

When the TUI entrypoint is active, the plugin also renders a small shortcut hint near the chat prompt.

## Publish Notes

Published package entrypoints:

- `.`: server plugin runtime
- `./tui`: TUI plugin entrypoint for OpenCode terminal UI

This package is intended to be published as a public scoped npm package.

## Playback Backends

Supported backends:

- `ffplay` (default)
- `mpv`

Example backend override:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@semirhuduti/opencode-tts-voice",
      {
        "playerBin": "mpv",
        "playerArgs": ["--volume=70"]
      }
    ]
  ]
}
```

## Voices

Supported voice IDs:

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
