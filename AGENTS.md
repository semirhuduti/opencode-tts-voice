# Project instructions

This is an OpenCode text-to-speech plugin. See `AGENT.md` for project background.

## Responses

Use ASD-STE100 Simplified Technical English as guidance when you respond to the user. Write short, clear sentences. Use plain words and keep responses to the point.

## Build and test

- Run `npm run build`, `npm test`, and `npm pack --dry-run` without asking for approval.
- When both checks are needed, use `sh scripts/build-and-test.sh`. It installs dependencies, builds the project, runs unit tests, and runs the audio test with playback enabled.
- Never run `npm publish`, `npm run publish:npm`, or `scripts/publish-npm.sh`; npm publishing is explicitly prohibited.

## Git naming

Do not prefix commit messages or branch names with categories such as `feat`,
`fix`, or `chore`. Use a clear, descriptive name without a prefix.

Whenever you make repository changes, include a suggested commit message as
the final line of your final response.
