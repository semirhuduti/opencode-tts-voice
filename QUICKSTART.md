# Quick start: Voice plugin on macOS

## Install the tools

With [Homebrew](https://brew.sh/) installed, run:

```sh
brew install node bun mpv
```

This installs Node.js and npm, Bun, and the `mpv` audio player. The project
requires Node.js 20.9 or newer. You also need OpenCode installed.

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
    "/absolute/path/to/opencode-tts-voice"
  ]
}
```

Replace the path with the absolute path to **this checkout**, not `dist/`.
For example, the local test project uses
`/Users/scott/development/forks/opencode-tts-voice`. If the file already has
settings or plugins, keep them and add this path to the existing `plugins`
array rather than replacing the file.

OpenCode loads the built plugin from that checkout. Open the project in
OpenCode and start a session; with voice enabled, assistant responses are
spoken as they arrive. Configuration changes normally reload automatically;
use `/reload` in OpenCode to force a reload if needed.

To use the plugin in every project instead, add the same entry to your global
`~/.config/opencode/opencode.jsonc`, preserving any existing settings.

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

The **Ctrl+F9** menu shows the shortcuts for the six voice actions. Use the
up and down arrows to select an action and **Enter** to run it, or **Escape**
to close the menu without running anything. On a MacBook, you may need
**Ctrl+Fn+F9**.

## Voice status and commands

Look in the OpenCode home or session footer for:

- `[sound on - 1x - Ctrl+F9]` — speech is enabled at 1x speed.
- `[sound off - 1x - Ctrl+F9]` — speech is disabled; press **F8** to enable it.
- `[! sound error - 1x - Ctrl+F9]` — speech encountered an error.

This checkout displays that status automatically; it does not display the
shortcut chips shown in the older screenshot in `README.md`, and there is no
setting to switch between the two displays.

To see the available voice commands, press **Ctrl+P** to open OpenCode's
command palette and look for the **Voice** group. The palette contains the
same history, play/pause, replay, toggle, and speed actions as the shortcuts above.

## Change the voice or speed

Use the object form of the plugin entry to set options. For example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-tts-voice",
      "options": {
        "voice": "af_heart",
        "speed": 1.1
      }
    }
  ]
}
```

Replace the existing string entry with this object; don't add a second entry
for the same checkout. Speed defaults to `1`; values below `1` are slower and
values above `1` are faster. **Ctrl+F6** and **Ctrl+F7** adjust it by 0.25x,
down to a minimum of 0.1x. The change applies to newly generated audio; audio
already generated may finish at the previous speed. Pauses between chunks also
shorten or lengthen with the speed. On plugin reload, the configured speed is
restored.

## If you can't hear speech

- Check that the footer says `sound on`; press **F8** if it says off.
- Check macOS sound output and volume, and confirm a supported player such as
  `mpv` is installed. The plugin doesn't automatically select macOS `afplay`.
- Run the audible audio test above. It tests generation and playback, but
  doesn't test the plugin inside OpenCode.
- If the voice status is missing, check the plugin path and the build output,
  then use `/reload` in OpenCode.
