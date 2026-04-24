export function trimSilence(
  input: Float32Array,
  sampleRate: number,
  threshold: number,
  leadingPadMs: number,
) {
  if (!input.length || threshold <= 0) return input

  let start = 0
  while (start < input.length && Math.abs(input[start] ?? 0) <= threshold) start += 1
  if (start >= input.length) return input

  let end = input.length - 1
  while (end > start && Math.abs(input[end] ?? 0) <= threshold) end -= 1

  const pad = Math.max(0, Math.round((sampleRate * leadingPadMs) / 1000))
  const clippedStart = Math.max(0, start - pad)
  return input.slice(clippedStart, end + 1)
}

export function wavFromFloat32(audio: Float32Array, sampleRate: number) {
  const pcm = new Int16Array(audio.length)
  for (let index = 0; index < audio.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, audio[index] ?? 0))
    pcm[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
  }

  const dataSize = pcm.length * 2
  const buffer = Buffer.allocUnsafe(44 + dataSize)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  buffer.write("RIFF", 0, "ascii")
  view.setUint32(4, 36 + dataSize, true)
  buffer.write("WAVE", 8, "ascii")
  buffer.write("fmt ", 12, "ascii")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  buffer.write("data", 36, "ascii")
  view.setUint32(40, dataSize, true)

  for (let index = 0; index < pcm.length; index += 1) {
    view.setInt16(44 + index * 2, pcm[index] ?? 0, true)
  }

  return buffer
}
