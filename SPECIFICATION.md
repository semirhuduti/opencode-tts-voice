# Local OpenCode integration and safety validation

## Goal

Validate this fork as a local text-to-speech plugin for the user's existing
OpenCode instance. Do not enable it globally until the user agrees and the
isolated integration checks below have passed. This document is a handoff and
checklist, not a claim that the plugin is safe or compatible.

## Instructions for the next agent

- Read `AGENTS.md`, `AGENT.md`, and the testing and installation sections of
  `README.md` before proceeding.
- **Do not run command-line commands**, including Git, directly or indirectly.
  Explain each command and ask the user to run it and share the result.
- Preserve existing configuration and uncommitted changes. Ask before changing
  the user's OpenCode configuration or enabling the plugin globally.
- Record results and remaining issues in this file as work progresses. Don't
  mark a check complete without evidence from the user or direct inspection.
- OpenCode-specific guidance must follow the applicable OpenCode skill and V2
  documentation. The fork targets the OpenCode 2.3.2 plugin API; the user's
  installed version and compatibility are not yet established.

## Current status

- The fork has been ported to the OpenCode V2 plugin API, but actual OpenCode
  integration has not been validated.
- The user reported that the real CPU audio test, including audible playback
  through `mpv` on macOS, worked. The test launches the built helper with Node;
  it does not test OpenCode's plugin loading, event handling, or runtime choice.
- Earlier automated tests were reported passing. The user ran build and test
  commands again after shutdown changes, but their individual output was not
  captured; confirm their current results before relying on them.
- An earlier `npm audit` after dependency changes reported zero vulnerabilities.
  Audit results and dependencies can change, so run it again before rollout.
- `package.json` overrides `sharp`, `glob`, and `minimatch` with patched versions.
  Some overrides cross upstream dependency ranges; passing tests do not establish
  universal compatibility. Root overrides can be ignored if the fork is installed
  as another project's dependency, resulting in a different dependency tree.
- Dependencies were installed using `npm install --ignore-scripts`; this skipped
  lifecycle scripts. The audio test worked on the user's macOS arm64 machine, but
  other native dependency paths and platforms remain unverified.
- The user installed `mpv` for playback. Automatic player selection does not
  currently include macOS's built-in `afplay`.
- The V2 port's speech toggle uses plugin-scoped storage and does not import the
  V1 toggle; speech is enabled by default on first use.
- Migration changes were previously committed. Dependency, diagnostic, cleanup,
  and documentation changes have since been made; inspect the actual working
  state without discarding anything before making further changes.

## Acceptance checklist

### 1. Confirm versions and local build

- [ ] Ask the user for their installed OpenCode, Node, and Bun versions; compare
  OpenCode with the 2.3.2 API target and investigate any compatibility concerns.
  Suggested commands:

  ```sh
  opencode --version
  node --version
  bun --version
  ```

- [ ] Inspect `package.json` and `package-lock.json` to confirm the intended
  overrides are recorded and the local dependency tree is the one being tested.
  Ask the user to run `npm audit` from the checkout and report the result.
- [ ] Ask the user to run the current build and automated tests from the
  checkout, and capture success or failure:

  ```sh
  npm run build
  npm test
  ```

- [ ] If dependencies or source have changed since the last audio check, ask
  the user to rerun the built helper and audible playback checks:

  ```sh
  npm run test:audio
  OPENCODE_TTS_TEST_PLAY=1 npm run test:audio
  ```

  The test may download the default Kokoro model from Hugging Face, taking time
  and disk space. See `README.md` for prerequisites and installation commands.

### 2. Test in a disposable OpenCode project

- [ ] Choose a disposable project with the user. Configure the **local checkout
  directory**, not the original npm package, using the V2 `plugins` example in
  `README.md`. Preserve existing configuration and do not modify global
  configuration at this stage.
- [ ] Account for inherited global, system, and ancestor configuration: a test
  project alone does not isolate all existing settings or plugins. Consider
  `opencode --standalone` for a private server, while recognizing that it does
  not by itself guarantee clean configuration or separate persistent data.
  Avoid touching the user's existing sessions or settings unnecessarily.
- [ ] Verify both server and TUI parts load without errors on the user's actual
  OpenCode version. Confirm which runtime launches the TTS helper: OpenCode
  may select Bun or a different Node executable from the audio test.
- [ ] Verify speech starts and streams for an assistant response, and that
  playback finishes without errors.
- [ ] Verify pause/resume and interruption while speech is active.
- [ ] Verify replay of the latest response and the history picker, including
  playing a selected entry and playing forward.
- [ ] Verify question/form prompts are spoken as intended in the active session.
- [ ] Verify the speech toggle, including prompt guidance behavior and
  persistence across reloads.
- [ ] Verify disabling or reloading the plugin and exiting the test instance
  stop playback and clean up helper processes and temporary audio files.
- [ ] Check errors, logs, CPU use, responsiveness, and shortcut conflicts.
  Plugin logs may contain spoken-text previews; redact sensitive data before
  sharing diagnostics.

### 3. Review risk and decide on rollout

- [ ] Review any failures from the real OpenCode test, dependency audit, or
  runtime selection. Fix and retest before suggesting wider use.
- [ ] Explain the remaining trust boundaries: the plugin runs code with the
  user's permissions, downloads model files when needed, uses native
  dependencies, and may log previews of spoken content. The existing review,
  clean audit, and passing tests do not guarantee security or compatibility.
- [ ] Confirm that local-directory loading uses the intended built files and
  dependency tree. Do not infer that the repository's overrides protect an
  independently installed or published package.
- [ ] Agree on a rollback before changing global settings: preserve the current
  configuration, remove only the added local-plugin entry if needed, and verify
  the plugin unloads. Respect OpenCode's configuration reload behavior; do not
  restart its background service merely to apply configuration.
- [ ] Only with the user's approval, add the local plugin to their intended
  OpenCode configuration, preserving unrelated entries. Validate in the real
  setup and record the outcome.

## Results and follow-up

Add dated results, command output summaries, known issues, and decisions here as
the checklist progresses. Do not include secrets or unredacted sensitive logs.
