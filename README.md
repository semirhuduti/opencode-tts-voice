# @semirhuduti/opencode-tts-voice

Voice output plugin for OpenCode powered by Kokoro, with TUI shortcut support for controlling playback.

## ALFA

Still wip, make sure to install sharp versions if you want a bit more reliability.

## Features

- reads assistant responses aloud while they stream in the TUI
- adds TUI shortcuts for pause, replay latest response, and toggle on or off
- supports configurable voice, speed, model, precision, and playback settings
- uses local playback via `ffplay`, `mpv`, `paplay`, or `aplay`
- prefers GPU-capable execution when available and falls back to CPU automatically

## Requirements

- Linux, macOS, or Windows
- OpenCode with plugin support
- one of `ffplay`, `mpv`, `paplay`, or `aplay` available on the system

Optional:

- CUDA and cuDNN runtime libraries for GPU execution

## Install

```bash
opencode plugin @semirhuduti/opencode-tts-voice --global
```

OpenCode loads the package automatically.

This package exposes a TUI plugin entrypoint and runs inside the OpenCode terminal UI.

## Config

Example `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "@semirhuduti/opencode-tts-voice",
      {
        "voice": "am_adam",
        "speed": 1.1,
        "dtype": "q4",
        "voiceBlocks": ["reason", "message", "idle"],
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

If you install locally, OpenCode may write the plugin entry into your project `.opencode/tui.json` instead.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `voice` | string | `af_heart` | Voice ID used for speech generation. |
| `speed` | number | `1` | Speech speed. Higher values are faster. |
| `device` | string | `auto` | Preferred execution device. Accepted values: `auto`, `cpu`, `cuda`, `dml`, `gpu`, `wasm`, `webgpu`. The plugin falls back to CPU automatically if the preferred backend cannot initialize. |
| `dtype` | string | `q8` | Model precision. Accepted values: `fp32`, `fp16`, `q4`, `q4f16`, `q8`. |
| `model` | string | `onnx-community/Kokoro-82M-v1.0-ONNX` | Model ID or compatible local model path. |
| `cacheDir` | string | Transformers.js default cache | Directory used for model downloads and cache data. |
| `playerBin` | string | `auto` | Playback backend command. `auto` picks the first installed backend from `ffplay`, `mpv`, `paplay`, or `aplay`. |
| `playerArgs` | string or string[] | `[]` | Additional arguments passed to the playback backend helper. |
| `readResponses` | boolean | `true` | Speak streamed assistant responses. |
| `announceOnIdle` | boolean | `false` | Speak a message when the session becomes idle. |
| `idleMessage` | string | `Task completed.` | Idle message text. |
| `voiceBlocks` | string[] | `["reason", "message", "idle"]` | Fine-grained speech source filter. Accepted values: `reason`, `message`, `idle`. |
| `speechChunkLength` | number | `1000` | Maximum chunk size sent to the TTS generator. |
| `streamSoftLimit` | number | `180` | Target flush size for streamed assistant text. |
| `maxTextLength` | number | `2000` | Maximum text length accepted for a single spoken chunk. |
| `trimSilenceThreshold` | number | `0.001` | Silence threshold used when trimming generated chunks. |
| `leadingAudioPadMs` | number | `12` | Leading padding preserved before detected speech. |
| `defaultChunkPauseMs` | number | `50` | Pause added after normal chunks. |
| `clauseChunkPauseMs` | number | `80` | Pause added after clause-ending punctuation. |
| `shortcuts.pause` | string | `f6` | TUI shortcut for play or pause. If audio is already playing, it pauses. If playback is idle, it replays the latest assistant response. |
| `shortcuts.skipLatest` | string | `f7` | TUI shortcut for replaying the latest assistant message in the active session. |
| `shortcuts.toggle` | string | `f8` | TUI shortcut for enabling or disabling automatic speech. |

## Shortcuts

Default TUI shortcuts:

- `f6`: play or pause speech
- `f7`: replay the latest assistant message
- `f8`: enable or disable speech

When the TUI entrypoint is active, the plugin also renders a small shortcut hint near the chat prompt using these symbols:

- `►` for play
- `⏸` for pause
- `▁ ▂ ▃ ▄ ▅ ▆ ▇ █ ▇ ▆ ▅ ▄ ▃ ▁` animated while audio is generating
- `↠` for replay latest
- `●` green when TTS is enabled, gray when it is disabled

`voiceBlocks` works as a source filter on top of the existing booleans:

- `readResponses` still enables or disables streamed response playback
- `announceOnIdle` still enables or disables idle announcements
- `voiceBlocks` decides which of `reason`, `message`, and `idle` are allowed to be spoken when those features are active

## Publish Notes

Published package entrypoints:

- `./tui`: TUI plugin entrypoint for OpenCode terminal UI

This package is intended to be published as a public scoped npm package.

## Playback Backends

Supported backends:

- `auto` (default)
- `ffplay`
- `mpv`
- `paplay`
- `aplay`

Example backend override:

```json
{
  "$schema": "https://opencode.ai/tui.json",
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

The plugin accepts Kokoro voice IDs. Common English voices include:

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

`kokoro-js` ships additional voices beyond this list. If upstream adds new voices, you can usually use them directly through the `voice` option.
