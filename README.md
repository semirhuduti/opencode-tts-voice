# OpenCode Spoken Replies

OpenCode Spoken Replies adds local text-to-speech to OpenCode. It reads assistant responses aloud as they arrive, using the Kokoro voice model, and provides TUI controls to pause, replay, and choose voices. Speech is generated on your machine; the model is downloaded from Hugging Face on first use.

This is an independently maintained fork of [opencode-tts-voice](https://github.com/semirhuduti/opencode-tts-voice), with a distinct package name. It is not maintained, endorsed, or supported by the original author.

If you appreciate the original author's work, please [buy Semir Huduti a coffee](https://www.buymeacoffee.com/semirhuduti).

[![Buy Semir Huduti a coffee](https://cdn.buymeacoffee.com/buttons/default-orange.png)](https://www.buymeacoffee.com/semirhuduti)

## Features

- Listen to assistant replies as they arrive instead of staying focused on the terminal.
- Choose and preview a voice, then adjust speaking speed to suit your preference.
- Pause, resume, replay the latest reply, or revisit earlier replies whenever you need.
- Hear OpenCode question prompts aloud; optionally hear completion announcements and direct subagent replies.
- Turn speech on or off quickly, with the current voice status and speed visible in OpenCode.
- Keep speech generation on your machine; no separate cloud speech service or API key is required.

## Installation

Requirements:

- OpenCode **2.3.2 or newer in the 2.x line** (the package currently targets `^2.3.2`).
- An audio player available on `PATH`: `ffplay`, `mpv`, `paplay`, or `aplay`. `mpv` is recommended. Install it with your operating system's package manager.
- Internet access the first time a model is needed, unless you configure a compatible local model and cache.

Once this package is published, add it to the `plugins` array in your OpenCode `opencode.json` or `opencode.jsonc` configuration. OpenCode supports published npm plugins and loads the package's server and TUI parts together. To install it globally from the terminal after publication, use:

```sh
opencode plugin add @scotteza/opencode-spoken-replies
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@scotteza/opencode-spoken-replies"
  ]
}
```

For project-only use, put this in that project's OpenCode config. For global use, add it to `~/.config/opencode/opencode.json` (or `.jsonc`), preserving existing settings and plugin entries. You can pin a published release with `@scotteza/opencode-spoken-replies@VERSION`.

**The package is not published yet.** Until it is available from npm, a local checkout can be loaded as a directory:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-spoken-replies",
      "options": {}
    }
  ]
}
```

The local checkout must have its dependencies installed and its `dist/` output built. The `npm run build` script requires Node.js 20.9 or later and Bun. Users of the published package will not need to clone or build the source.

After restarting or reloading OpenCode, look for the voice status in the home or session footer. On first use, Kokoro downloads its model; the initial load can take time and disk space.

## Usage

Speech is enabled by default. Assistant responses are spoken as they stream. Question prompts in the active session are also spoken by default. Use the shortcuts below to pause, replay, or toggle speech. Voice actions are also available in OpenCode's command palette under **Voice**.

Choose **Choose voice** from the **Voice shortcuts** menu or command palette to search voices by name, accent, gender, or ID. Press **Ctrl+O** to preview the highlighted voice and **Enter** to select it. Previews queue behind current speech and require speech to be enabled and unpaused.

In the history picker, **Enter** plays the selected response; **Shift+Enter** plays it and subsequent playable assistant messages. **Escape** closes the picker. The footer shows speech status and current speed.

## Keyboard shortcuts

| Shortcut | Action | Description |
| --- | --- | --- |
| `F5` | Assistant history | Choose a recent assistant message to play. |
| `F6` | Play or pause | Toggles playback; when idle, replays the latest response. |
| `F7` | Replay latest | Replays the latest assistant response from the beginning. |
| `F8` | Toggle speech | Enables or disables automatic speech. |
| `Ctrl+F6` | Slow down | Decreases speed by 0.25x. |
| `Ctrl+F7` | Speed up | Increases speed by 0.25x. |
| `Ctrl+F9` | Voice shortcuts | Opens the voice action menu. |
| `Ctrl+O` | Preview voice | Previews the highlighted voice in the voice picker. |
| `Enter` | Select / play | Selects the highlighted voice or plays a selected history entry. |
| `Shift+Enter` | Play forward | In history, plays the selected entry and later entries. |
| `Escape` | Close picker | Closes the active history or voice picker. |

The four function-key bindings can be customized using `shortcuts` below. Speed controls and the voice menu currently use fixed bindings. On some keyboards, function keys may require holding `Fn`. Other OpenCode bindings may conflict; customize the configurable bindings if needed.

## Configuration

Add options to the plugin entry's `options` object. Defaults below are taken from the implementation.

| Option | Default | Accepted values and effect |
| --- | --- | --- |
| `voice` | `"af_heart"` | Kokoro voice ID. |
| `speed` | `1` | Positive number, normalized to 0.25x steps and limited to 0.25–5x. Higher is faster. If omitted, the last adjusted speed is remembered. |
| `device` | `"auto"` | `auto`, `cpu`, `gpu`, `cuda`, `dml`, `wasm`, or `webgpu`; tries alternatives and falls back to CPU/WASM. |
| `dtype` | `"q8"` | `fp32`, `fp16`, `q4`, `q4f16`, or `q8` model precision. |
| `model` | `"onnx-community/Kokoro-82M-v1.0-ONNX"` | Hugging Face model ID or compatible local model path. |
| `cacheDir` | Transformers.js default | Directory for model cache and downloads. |
| `audioPlayer` | `"auto"` | `auto`, `ffplay`, `mpv`, `paplay`, `aplay`, or another player command. Auto tries `ffplay`, `mpv`, `paplay`, then `aplay`. |
| `audioPlayerArgs` | `[]` | Extra player arguments as a string or string array. |
| `speakResponses` | `true` | Speak streamed assistant responses. |
| `speakSubagentResponses` | `false` | Include direct child subagent responses. |
| `speakOnIdle` | `false` | Speak an announcement when a session becomes idle. |
| `speakQuestions` | `true` | Speak question prompts in the active session. |
| `idleAnnouncement` | `"Task completed."` | Text used for the idle announcement. |
| `speechBlocks` | `["message", "idle"]` | Allowed source types: `reason`, `message`, `idle`. Reasoning is opt-in. |
| `maxSpeechChunkChars` | `1000` | Maximum text length sent to TTS per chunk; minimum 32. |
| `streamFlushChars` | `180` | Target streamed-text flush length; minimum 16 and capped at `maxSpeechChunkChars`. |
| `maxSpeechChars` | `2000` | Maximum accepted text length for a spoken chunk; minimum 64. |
| `fileExtensions` | `[]` | Additional alphanumeric file extensions recognized by text sanitization; string or string array. |
| `trimSilenceThreshold` | `0.001` | Non-negative generated-audio silence threshold. |
| `leadingAudioPadMs` | `12` | Non-negative leading audio padding in milliseconds. |
| `normalPauseMs` | `240` | Non-negative pause between ordinary speech chunks in milliseconds. |
| `sentencePauseMs` | `100` | Non-negative pause after sentence-, clause-, or newline-ending chunks in milliseconds. |
| `ttsServiceCommand` | Runtime-resolved Node or Bun | Optional command used to wrap the helper process, for example with OS resource controls. |
| `ttsServiceArgs` | `["{helper}"]` | Helper arguments as a string or array; `{helper}` and `{runtime}` are expanded. |
| `shortcuts.history` | `"f5"` | Key binding for assistant history. |
| `shortcuts.pause` | `"f6"` | Key binding for play/pause. |
| `shortcuts.skipLatest` | `"f7"` | Key binding for replay latest. |
| `shortcuts.toggle` | `"f8"` | Key binding for speech on/off. |

Example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@scotteza/opencode-spoken-replies",
      "options": {
        "voice": "am_adam",
        "speed": 1.25,
        "device": "cpu",
        "audioPlayer": "mpv",
        "speakQuestions": false,
        "shortcuts": {
          "history": "f5",
          "pause": "f6",
          "skipLatest": "f7",
          "toggle": "f8"
        }
      }
    }
  ]
}
```

With no explicit `voice` or `speed` option, voice picker selections and speed adjustments are remembered in OpenCode plugin storage. Explicit valid settings take precedence when the plugin loads.

### Environment variables and privacy

- `OPENCODE_TTS_VOICE_LOG_LEVEL`: `silent`, `error`, `warn` (default), `info`, or `debug`. The older alias `OPENCODE_TTS_LOG_LEVEL` is also accepted. `silent` disables plugin logging.
- `OPENCODE_TTS_VOICE_HELPER_LOG_LEVEL`: set to `warn` or `error` to diagnose helper startup. Helper logging is silent by default.
- `OPENCODE_TTS_VOICE_CONSOLE_LOG`: set to `1` or `true` to also log to the console. The older alias `OPENCODE_TTS_CONSOLE_LOG` is also accepted.

Logs are written beside OpenCode logs under `${XDG_DATA_HOME:-~/.local/share}/opencode/log/` and can include previews of spoken text. Review logs before sharing them. Speech generation uses the local Kokoro runtime; the model is obtained from Hugging Face unless already cached or configured locally.

## Differences from the original

The upstream repository supplied the original Kokoro-based OpenCode voice plugin. This fork has since moved to the OpenCode 2.x plugin API and added or changed user-facing capabilities visible in its source and commit history:

- Added streaming response playback, spoken question prompts, optional idle announcements, and optional direct subagent response speech.
- Added a history picker, voice search and preview, persistent voice and speed selection, adjustable playback speed, and a voice action menu.
- Added a separate TTS helper process, text sanitization and chunking controls, speech-friendly prompt guidance, expanded playback controls, and configurable execution and player settings.
- Added OpenCode 2.x server and TUI package entrypoints.

These changes are maintained independently; the original project remains at [semirhuduti/opencode-tts-voice](https://github.com/semirhuduti/opencode-tts-voice).

## Credits

OpenCode Spoken Replies builds on [opencode-tts-voice](https://github.com/semirhuduti/opencode-tts-voice), created by [Semir Huduti (semirhuduti)](https://github.com/semirhuduti) and released under the MIT licence. The original project provided the foundation; this fork adds substantial changes and is independently developed and maintained by [Scott Edwards](https://github.com/scotteza). The original author does not maintain, endorse, or support this fork.

## Licence

Distributed under the MIT licence. See [LICENSE](LICENSE) for the licence text and copyright notices.

## Support

Report issues and request changes in the [OpenCode Spoken Replies issue tracker](https://github.com/scotteza/opencode-spoken-replies/issues).

OpenCode's [ecosystem page](https://opencode.ai/docs/ecosystem/) is separate from npm distribution. The current page identifies itself as V1 documentation and says additions are made by pull request, so verify the V2 listing process before submitting; npm publication alone does not add the project there.
