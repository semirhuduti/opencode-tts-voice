import { mkdir } from "node:fs/promises"
import path from "node:path"
import solidPlugin from "@opentui/solid/bun-plugin"

const root = import.meta.dir ? path.resolve(import.meta.dir, "..") : process.cwd()
const outdir = path.join(root, "dist")

await mkdir(outdir, { recursive: true })

const build = await Bun.build({
  entrypoints: [
    path.join(root, "src", "server-plugin.ts"),
    path.join(root, "src", "tui-plugin.tsx"),
    path.join(root, "src", "voice-helper-process.ts"),
  ],
  outdir,
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solidPlugin],
})

if (!build.success) {
  for (const log of build.logs) {
    console.error(log)
  }
  process.exitCode = 1
}

for (const artifact of build.outputs) {
  const target = path.join(outdir, path.basename(artifact.path))
  await Bun.write(target, await artifact.text())
}
