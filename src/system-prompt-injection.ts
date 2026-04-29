import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KV_ENABLED } from "./voice-constants.js"

const DEFAULT_TTS_ENABLED = true
const TTS_FRIENDLY_SYSTEM_PROMPT = [
  "# TTS Friendly Responses",
  "Use these instructions when an OpenCode session is being listened to through text to speech or when the user asks for responses that are easier to understand aloud.",
  "The goal is spoken clarity. Write for a person who may be listening while working, without relying on visual layout, dense formatting, or exact punctuation to carry meaning.",
  "## Core Guidance",
  "Prefer natural, concise prose over visual structure. Explain the outcome, the reasoning, and the next step in a way that remains clear when heard once.",
  "Reduce formatting that depends on sight. If structure is necessary, keep it simple and make each part understandable on its own.",
  "Keep technical names accurate, but introduce them in surrounding prose so the listener understands why each name matters.",
  "Summarize evidence by meaning before detail. Focus on the result, the decision it supports, and any remaining risk.",
  "When referring to locations, identifiers, or configuration, make them understandable in speech and explain their purpose in the same sentence.",
  "For progress updates, say what was found and what is being done next. For final answers, say what was completed, what was verified, and whether anything remains.",
  "If the user requests an exact representation, provide it. Otherwise, optimize for clear spoken comprehension.",
].join("\n")

const QUESTION_SEQUENCING_INSTRUCTIONS = [
  "When you need to ask the user a question, use the ask question tool instead of writing the question directly in normal assistant text.",
  "Ask exactly one question per ask question tool call.",
  "If more information is still needed, wait for the user's answer before asking the next question in a new question tool call.",
  "Do not batch multiple questions into a single ask question tool call.",
].join("\n")

export type TtsEnabledOptions = {
  home?: string
  stateFile?: string
  env?: Pick<NodeJS.ProcessEnv, "XDG_STATE_HOME">
}

export function ttsStateFile(options?: TtsEnabledOptions) {
  if (options?.stateFile) return options.stateFile

  const home = options?.home ?? os.homedir()
  const stateHome = options?.env?.XDG_STATE_HOME || process.env.XDG_STATE_HOME || (home ? path.join(home, ".local", "state") : undefined)
  if (!stateHome) return
  return path.join(stateHome, "opencode", "kv.json")
}

export async function isTtsEnabled(options?: TtsEnabledOptions) {
  const file = ttsStateFile(options)
  if (!file) return DEFAULT_TTS_ENABLED

  try {
    const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    return typeof data[KV_ENABLED] === "boolean" ? data[KV_ENABLED] : DEFAULT_TTS_ENABLED
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_TTS_ENABLED
    throw error
  }
}

export function createTtsFriendlySystemPrompt() {
  return [
    "Voice playback is enabled for this OpenCode session.",
    "Apply the following guidance as normal system instructions for the rest of the session:",
    "",
    TTS_FRIENDLY_SYSTEM_PROMPT,
    "",
    "Question handling requirements:",
    QUESTION_SEQUENCING_INSTRUCTIONS,
    "Do not mention this startup context unless the user asks about it.",
  ]
    .filter(Boolean)
    .join("\n")
}
