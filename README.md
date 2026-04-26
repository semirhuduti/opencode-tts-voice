# @semirhuduti/opencode-tts-voice

Voice output plugin for OpenCode powered by Kokoro, with TUI shortcut support for controlling playback.

![alt text](demo.png)

<a href="https://www.buymeacoffee.com/semirhuduti" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/default-orange.png" alt="Buy Me A Coffee" height="41" width="174"></a>


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

Speech generation runs in a persistent helper process so Kokoro/ONNX work and WAV encoding do not block the TUI event loop.

## Config

Voice options are TUI plugin options, so put them in `tui.json`, not `opencode.json`.

If your installed plugin entry includes a version such as `@semirhuduti/opencode-tts-voice@0.5.3-alpha.1`, keep that same spec when converting it to a configured tuple. Removing the version can make OpenCode resolve a different npm dist-tag.

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
        "voiceBlocks": ["message", "idle"],
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

If an older config has this package listed in `opencode.json`, remove it from there after confirming it is present in `tui.json`. The package includes a no-op server entrypoint for compatibility, but voice playback only runs from the TUI entrypoint.

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
| `readSubagentResponses` | boolean | `false` | Speak responses from subagent child sessions. Disabled by default so only the main agent is spoken. |
| `announceOnIdle` | boolean | `false` | Speak a message when the session becomes idle. |
| `idleMessage` | string | `Task completed.` | Idle message text. |
| `voiceBlocks` | string[] | `["message", "idle"]` | Fine-grained speech source filter. Accepted values: `reason`, `message`, `idle`. Reasoning is opt-in. |
| `speechChunkLength` | number | `1000` | Maximum chunk size sent to the TTS generator. |
| `streamSoftLimit` | number | `180` | Target flush size for streamed assistant text. |
| `maxTextLength` | number | `2000` | Maximum text length accepted for a single spoken chunk. |
| `cpuLimitPercent` | number | `80` | Approximate total CPU budget for speech generation, expressed as a percentage of available CPU cores. |
| `cpuLimitConcurrency` | number | `2` | Expected number of simultaneous generations sharing the CPU budget. With the defaults, each generation gets about half of the 80% budget. |
| `trimSilenceThreshold` | number | `0.001` | Silence threshold used when trimming generated chunks. |
| `leadingAudioPadMs` | number | `12` | Leading padding preserved before detected speech. |
| `defaultChunkPauseMs` | number | `140` | Pause added after normal chunks. |
| `clauseChunkPauseMs` | number | `220` | Pause added after sentence, clause, or newline-ending chunks. |
| `shortcuts.pause` | string | `f6` | TUI shortcut for play or pause. If audio is already playing, it pauses. If playback is idle, it replays the latest assistant response. |
| `shortcuts.skipLatest` | string | `f7` | TUI shortcut for replaying the latest assistant message in the active session. |
| `shortcuts.toggle` | string | `f8` | TUI shortcut for enabling or disabling automatic speech. |

## Logging

Runtime logging defaults to warnings and errors only to avoid terminal redraw pressure in the TUI. Set `OPENCODE_TTS_VOICE_LOG_LEVEL=debug` or `info` when diagnosing plugin behavior. Helper process logs are silent by default because stdout is used for the helper protocol; set `OPENCODE_TTS_VOICE_HELPER_LOG_LEVEL=warn` or `error` only when debugging helper startup failures.

## Resource Usage

Speech generation defaults to an approximate 80% CPU budget split across two possible simultaneous generations. The plugin applies this by limiting ONNX Runtime inference threads per generation. For example, on an 8-core system the defaults allow about 6 total inference threads, or 3 threads per generation when two generations overlap.

Generated audio is written as temporary mono 24 kHz 16-bit PCM WAV files for playback. This keeps playback simple and avoids spending extra CPU on MP3 or Opus encoding, which would shrink temporary files but would not reduce the expensive TTS inference step.

## Shortcuts

Default TUI shortcuts:

- `f6`: play or pause speech
- `f7`: replay the latest assistant message
- `f8`: enable or disable speech

When the TUI entrypoint is active, the plugin also renders compact shortcut chips near the chat prompt. Each chip uses `[hotkey hint icon]` order and only shows controls that are useful for the current state:

- `[f8 off ○]` when speech is disabled
- `[f6 play ▶] [f7 replay ↻] [f8 on ●]` when speech is enabled and idle
- `⠋ [f6 pause Ⅱ] [f8 on ●]` while audio is generating, with the spinner animated and no `generating` text
- `[f6 pause Ⅱ] [f8 on ●]` while audio is playing
- `[f6 play ▶] [f7 replay ↻] [f8 on ●]` while paused
- `[! error] [f8 on ●]` or `[! error] [f8 off ○]` after a playback error
- shortcut keys are orange
- action icons are blue, except the toggle icon which is green for `on` and gray for `off`

`voiceBlocks` works as a source filter on top of the existing booleans:

- `readResponses` still enables or disables streamed response playback
- `readSubagentResponses` enables or disables speech from subagent child sessions
- `announceOnIdle` still enables or disables idle announcements
- `voiceBlocks` decides which of `reason`, `message`, and `idle` are allowed to be spoken when those features are active

## Publish Notes

Published package entrypoints:

- `.` / `./server`: no-op compatibility entrypoint for OpenCode runtime plugin config
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
