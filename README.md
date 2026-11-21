# OpenCode Spoken Replies

OpenCode Spoken Replies lets OpenCode read assistant replies aloud as they arrive. Choose a voice, adjust the speed, and pause or replay speech from the terminal interface.

This independently maintained fork builds on [opencode-tts-voice](https://github.com/semirhuduti/opencode-tts-voice) from Semir Huduti. It is not maintained, endorsed, or supported by the original author.

If you appreciate the original author's work, please buy him a coffee using the link below .

[![Buy Semir Huduti a coffee](https://cdn.buymeacoffee.com/buttons/default-orange.png)](https://www.buymeacoffee.com/semirhuduti)

## Features

- Listen to assistant replies as they arrive instead of reading the terminal output.
- Choose and preview a voice, then adjust speaking speed to suit your preference.
- Pause, resume, replay the latest reply, or revisit earlier replies.
- Hear OpenCode question prompts aloud; optionally hear completion announcements and direct subagent replies.
- Turn speech on or off quickly, with the current voice status and speed visible in OpenCode.
- Speech is generated locally; no cloud speech service or API key is required. The Kokoro model is downloaded on first use.

## Install in OpenCode

Requirements: OpenCode 2.3.2 or later in the 2.x line, an audio player on your `PATH` (`ffplay`, `mpv`, `paplay`, or `aplay`), and internet access for the initial model download. `mpv` is recommended.

Install the published npm package with:

```sh
opencode plugin add @scotteza/opencode-spoken-replies
```

### Windows setup

The TTS helper needs Node.js or Bun available to the OpenCode process. If OpenCode reports that it cannot find either runtime, install [Node.js](https://nodejs.org/en/download/) for Windows and enable the installer option to add Node to `PATH`. Then fully exit and restart OpenCode so it inherits the updated `PATH`. Verify Node is available in PowerShell with:

```powershell
node --version
where.exe node
```

Windows also needs an audio player on `PATH`. One option is FFmpeg, which includes `ffplay`; install it with WinGet:

```powershell
winget install --id Gyan.FFmpeg -e
```

Open a new PowerShell window and verify that `ffplay` is available:

```powershell
where.exe ffplay
```

Then fully exit and restart OpenCode so it picks up the updated `PATH`. You can also install a Windows build of `mpv`. If OpenCode still cannot find Node, set `ttsServiceCommand` in this plugin's `options` to the full path to `node.exe`, for example:

```jsonc
{
  "plugins": [
    {
      "package": "@scotteza/opencode-spoken-replies",
      "options": {
        "ttsServiceCommand": "C:\\Program Files\\nodejs\\node.exe"
      }
    }
  ]
}
```

Or add it to the `plugins` array in your OpenCode `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@scotteza/opencode-spoken-replies"]
}
```

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `F5` | Open assistant-message history. |
| `F6` | Pause or resume speech; replay the latest reply when idle. |
| `F7` | Replay the latest reply from the beginning. |
| `F8` | Turn automatic speech on or off. |
| `Ctrl+F6` | Slow speech by 0.25x. |
| `Ctrl+F7` | Speed speech up by 0.25x. |
| `Ctrl+F9` | Open the voice shortcuts menu. |
| `Ctrl+O` | Preview the selected voice in the voice picker. |
| `Enter` | Select a voice or play the selected history entry. |
| `Shift+Enter` | In history, play the selected entry and later entries. |
| `Escape` | Close the active picker. |

In the history picker, selecting an entry enables speech if it was off. On some keyboards, function keys require holding `Fn`.

## Build and use a local checkout

To modify the plugin, install Node.js 20.9 or later and Bun 1.3.14 or later, then run these commands from the repository root.

On WSL with Ubuntu, install Bun from your WSL terminal (not PowerShell):

```sh
sudo apt update
sudo apt install -y curl unzip
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc # use ~/.zshrc if your WSL shell is zsh
bun --version
```

This is Bun's official installer. In WSL, it installs Bun in the Linux environment under `~/.bun` and adds it to your shell path; it does not install Bun for Windows. The version command should report Bun 1.3.14 or later. See the [official Bun installation guide](https://bun.sh/docs/installation) if `bun` is not found or you use a different shell.

Use Linux Node.js and npm in WSL too. If `command -v npm` points into `/mnt/c/` (for example, to a Windows Node installation), install Node with Linux `nvm` so npm scripts can find WSL's Bun:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash
source ~/.bashrc # use ~/.zshrc if your WSL shell is zsh
nvm install --lts
nvm alias default 'lts/*'
nvm use default
command -v node
command -v npm
```

The `node` and `npm` paths should be inside your WSL home directory, not under `/mnt/c/`. Then install the project dependencies and run the build and tests as shown below.

```sh
npm install
npm run build
npm test
```

To generate and validate a short audio sample, run `npm run test:audio`. The first run may download the Kokoro model. To also play the sample, set `OPENCODE_TTS_TEST_PLAY=1` and have a supported audio player installed.

Load the local build by adding its checkout directory (not `dist/`) to an OpenCode config:

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

Restart or reload OpenCode, open a session, and look for the voice status in the footer. Speech is enabled by default. Question prompts in the active session are spoken by default; idle announcements and direct subagent replies are optional and off by default.

## Settings

Settings go in the plugin entry's `options` object. The defaults are voice `af_heart`, speed `1x`, automatic device selection, question prompts on, idle announcements off, and subagent replies off. Speed ranges from `0.25x` to `5x`; without an explicit speed or voice setting, changes are remembered between launches.

For example, to choose a voice and enable completion announcements:

```jsonc
{
  "plugins": [
    {
      "package": "@scotteza/opencode-spoken-replies",
      "options": {
        "voice": "af_heart",
        "speed": 1.25,
        "speakOnIdle": true,
        "idleAnnouncement": "Task completed."
      }
    }
  ]
}
```

## Feature requests and issues

Have an idea or found a problem? [Open an issue](https://github.com/scotteza/opencode-spoken-replies/issues/new) in this repository and describe the request or problem.

## Credits and licence

This project builds on [opencode-tts-voice](https://github.com/semirhuduti/opencode-tts-voice), created by [Semir Huduti](https://github.com/semirhuduti) and released under the MIT licence. This fork adds substantial changes and is independently maintained by [Scott Edwards](https://github.com/scotteza). The original author does not maintain, endorse, or support this project. See [LICENSE](LICENSE) for the licence text and copyright notices.
