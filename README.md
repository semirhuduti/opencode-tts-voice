# @semirhuduti/opencode-tts-voice

Voice output plugin for OpenCode powered by Kokoro.

## Features

- speaks text through the `speak` tool
- reads assistant responses aloud while they stream
- supports configurable voice, speed, model, precision, and playback settings
- supports CPU and GPU execution
- plays audio locally with the system audio player

## Requirements

- Linux or macOS
- OpenCode with plugin support
- a local audio player command available on the system

Defaults:

- Linux: `aplay`
- macOS: `afplay`

Optional:

- CUDA and cuDNN runtime libraries for GPU execution

## Install

```bash
opencode plugin @semirhuduti/opencode-tts-voice --global
```

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
        "dtype": "q4"
      }
    ]
  ]
}
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `voice` | string | `af_heart` | Voice ID used for speech generation. |
| `speed` | number | `1` | Speech speed. Higher values are faster. |
| `device` | string | `gpu` | Preferred execution device. Accepted values: `auto`, `cpu`, `cuda`, `dml`, `gpu`, `wasm`, `webgpu`. |
| `dtype` | string | `q8` | Model precision. Accepted values: `fp32`, `fp16`, `q4`, `q4f16`, `q8`. |
| `model` | string | `onnx-community/Kokoro-82M-v1.0-ONNX` | Model ID or compatible local model path. |
| `cacheDir` | string | OS-specific cache directory | Directory used for model downloads and cache data. |
| `playerBin` | string | OS-specific | Playback command. Defaults to `aplay` on Linux and `afplay` on macOS. |
| `playerArgs` | string or string[] | OS-specific | Additional arguments passed to the playback command. Defaults to `-q` on Linux and no extra arguments on macOS. |
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
