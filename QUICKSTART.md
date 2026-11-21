# Quick start: Voice plugin on macOS

## Install the tools

With [Homebrew](https://brew.sh/) installed, run:

```sh
brew install node bun mpv
```

This installs Node.js and npm, Bun, and the `mpv` audio player. The project
requires Node.js 20.9 or newer. You also need OpenCode installed.

### WSL (Ubuntu)

In WSL, install the Linux tools with Ubuntu's package manager and the
official Bun installer. Ubuntu's `nodejs` package may be older than the
required Node.js 20.9, so install Node.js with `nvm`:

This assumes you are using Bash as your shell. If you are using zsh, source `~/.zshrc` instead of `~/.bashrc` after installing `nvm`.

```sh
sudo apt update
sudo apt install -y curl mpv
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash
source ~/.bashrc
nvm install node
curl -fsSL https://bun.com/install | bash
```

If you use a shell other than Bash, source the appropriate shell startup file
after installing `nvm`. You also need OpenCode installed in the WSL
environment. Run the build and tests below from your WSL checkout.

## Build and test

From the root of this checkout:

```sh
npm install
npm run build
npm test
OPENCODE_TTS_TEST_PLAY=1 npm run test:audio
```

The last command generates a short speech clip on the CPU, checks the WAV
audio, and plays it through your current macOS sound output. Select MacBook
speakers in **System Settings → Sound → Output** if you want to hear it there.
The first audio test may download the Kokoro model and take a while. To check
audio generation without playback, use `npm run test:audio` instead.

You can also run all four steps from the project root with:

```sh
sh build-and-test.sh
```

The script runs `npm install`, which can update the lockfile and run dependency
install scripts. It does not stop automatically if an earlier step fails, so
check each step's output. Run `npm run build` again after changing the source:
OpenCode and the audio test use the built files in `dist/`.

## Load the local build in OpenCode

In the project where you want speech, create or edit `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/opencode-spoken-replies"
  ]
}
```

Replace the path with the absolute path to **this checkout**, not `dist/`.
Replace the path with the absolute path to your checkout. If the file already
has settings or plugins, keep them and add this path to the existing `plugins`
array rather than replacing the file.

OpenCode loads the built plugin from that checkout. Open the project in
OpenCode and start a session; with voice enabled, assistant responses are
spoken as they arrive. Configuration changes normally reload automatically;
use `/reload` in OpenCode to force a reload if needed.

To use the plugin in every project instead, add the same entry to your global
`~/.config/opencode/opencode.jsonc`, preserving any existing settings.

### Choose CPU or GPU per machine

The plugin's `device` option controls where Kokoro runs. It defaults to `auto`,
which lets the runtime choose an available backend. Set `"device": "cpu"` on a
machine where CUDA is unavailable, such as a WSL setup without the ONNX Runtime
CUDA provider. Leave the option unset on a machine where automatic GPU
selection works, such as a Mac setup that already runs Kokoro on the GPU.

To keep this choice out of the repository, set it in that machine's global
OpenCode config, `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-spoken-replies",
      "options": {
        "device": "cpu"
      }
    }
  ]
}
```

Use the absolute path to the checkout as seen by that machine. On macOS, omit
the `device` option to keep the default automatic selection. Do not add the CPU
override to a tracked project config if the same project should use the GPU on
another machine. Plugin entries from global and project configs are combined,
so avoid registering the same checkout twice.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| **F5** | Open the assistant-message history picker. |
| **F6** | Pause or resume speech. When idle, replay the latest assistant response. |
| **F7** | Replay the latest completed assistant response from the beginning. |
| **F8** | Enable or disable speech. |
| **Ctrl+F6** | Slow speech down by 0.25x. |
| **Ctrl+F7** | Speed speech up by 0.25x. |
| **Ctrl+F9** | Open the voice shortcut menu. |

On a MacBook, hold **Fn** (or the globe key) if the function keys control
hardware features instead.

In the history picker, select a message and press **Enter** to play it, or
**Shift+Enter** to play it and the later messages. Press **Escape** to close
the picker. Selecting a message enables speech if it was off.

The **Ctrl+F9** menu shows the voice actions and their shortcuts. Use the
up and down arrows to select an action and **Enter** to run it, or **Escape**
to close the menu without running anything. On a MacBook, you may need
**Ctrl+Fn+F9**.

## Voice status and commands

Look in the OpenCode home or session footer for:

- `[sound on - 1x - Ctrl+F9]` — speech is enabled at 1x speed.
- `[sound off - 1x - Ctrl+F9]` — speech is disabled; press **F8** to enable it.
- `[sound initializing - 1x - Ctrl+F9]` — the speech engine is loading.
- `[! sound error - 1x - Ctrl+F9]` — speech encountered an error.

This checkout displays that status automatically; it does not display the
shortcut chips shown in the older screenshot in `README.md`, and there is no
setting to switch between the two displays.

To see the available voice commands, press **Ctrl+P** to open OpenCode's
command palette and look for the **Voice** group. The palette contains the
same history, play/pause, replay, toggle, and speed actions as the shortcuts above.

Choose **Choose voice** from the **Ctrl+F9** menu or command palette to open
the voice picker. Type to search by name, accent, gender, or voice ID; use
**Ctrl+O** to preview the highlighted voice and **Enter** to select it.
Previews wait behind current speech and require speech to be enabled and
unpaused. The selected voice applies to newly generated audio; audio already
generated may still use the previous voice.

If no `voice` option is configured, the plugin remembers your selection across
launches. A configured `voice` takes precedence when the plugin loads; picker
changes are temporary and do not replace the previously remembered selection.

## Change the voice or speed

Use the object form of the plugin entry to set options. For example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-spoken-replies",
      "options": {
        "voice": "af_heart"
      }
    }
  ]
}
```

Replace the existing string entry with this object; don't add a second entry
for the same checkout. Speed defaults to `1`; values below `1` are slower and
values above `1` are faster. **Ctrl+F6** and **Ctrl+F7** adjust it by 0.25x,
within the range 0.25x–5x. Configured and previously saved positive speeds are
rounded to the nearest 0.25x step (halfway values round up) and limited to
that range. The change applies to newly generated audio; audio
already generated may finish at the previous speed. Pauses between chunks also
shorten or lengthen with the speed.

Without a `speed` option, the plugin remembers your last adjustment in OpenCode's
durable plugin storage and restores it on the next launch. If you set a valid
`"speed": 1.25` in the plugin's options, that value takes precedence whenever the
plugin loads. Adjustments still work while OpenCode is open, but are temporary
and return to the configured value on reload or restart. Removing the option
restores the previously remembered speed, if any.

## If you can't hear speech

- Check that the footer says `sound on`; press **F8** if it says off.
- Check macOS sound output and volume, and confirm a supported player such as
  `mpv` is installed. The plugin doesn't automatically select macOS `afplay`.
- Run the audible audio test above. It tests generation and playback, but
  doesn't test the plugin inside OpenCode.
- If the voice status is missing, check the plugin path and the build output,
  then use `/reload` in OpenCode.
