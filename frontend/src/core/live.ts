// What employees are writing right now, by chat or sub-task id. It is apart from the world because it changes with
// every few characters and is never kept: once written, it arrives as a message.

import { create } from 'zustand'

// outputs are the last lines of a command running now in a chat; each one replaces the one before
export const useLive = create<{ texts: Record<string, string>; outputs: Record<string, string> }>(() => ({ texts: {}, outputs: {} }))

// many pieces can come within a frame, and redrawing a long reply for each is wasted
let waiting: Record<string, string> = {}
let frame = 0
const flush = () => {
  frame = 0
  const texts = { ...useLive.getState().texts }
  for (const [id, text] of Object.entries(waiting)) texts[id] = (texts[id] ?? '') + text
  waiting = {}
  useLive.setState({ texts })
}

export function addLive(id: string, text: string) {
  waiting[id] = (waiting[id] ?? '') + text
  if (!frame) frame = requestAnimationFrame(flush)
}

export function clearLive(id: string) {
  delete waiting[id]
  if (useLive.getState().texts[id] === undefined) return
  const { [id]: _, ...texts } = useLive.getState().texts
  useLive.setState({ texts })
}

export function clearAllLive() {
  waiting = {}
  useLive.setState({ texts: {}, outputs: {} })
}

export function setOutput(id: string, text: string) {
  const { [id]: _, ...outputs } = useLive.getState().outputs
  if (text) outputs[id] = text
  else if (_ === undefined) return
  useLive.setState({ outputs })
}

export const useLiveText = (id: string | undefined) => useLive((s) => (id ? s.texts[id] : undefined) ?? '')
export const useLiveOutput = (id: string | undefined) => useLive((s) => (id ? s.outputs[id] : undefined) ?? '')
