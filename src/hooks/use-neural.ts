// M.I.S.T. neural stream hook — ONE socket.io connection per session (spec 4.7).
// The socket is a module-level singleton; the callback registry lets the chat
// component own message state while receiving responses.
'use client'

import { useCallback, useEffect } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useMistStore } from '@/lib/store'
import { NEURAL_SERVICE_PORT } from '@/lib/mist-constants'
import { getGoogleKey, googleTtsAvailable, googleLmGenerate, type GeminiRelayMessage } from '@/lib/google-direct'
import type {
  ConsciousnessChunkMsg,
  ConsciousnessResponseMsg,
  HistoryMessage,
  NeuralServerMessage,
  ProviderId,
  SynapseMsg,
} from '@/lib/types'

let socket: Socket | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null

const responseListeners = new Set<(m: ConsciousnessResponseMsg) => void>()
const synapseListeners = new Set<(m: SynapseMsg) => void>()
// mlv-ux-2 — cancel protocol: the service acks a cancelled thought so the
// UI knows no response is coming (and can drop its ignore-late guard).
const thoughtCancelledListeners = new Set<() => void>()

// w3-activity — the live activity stream: what she is doing RIGHT NOW
// ("thinking", "reading package.json", "searching the web — mist console").
// Emitted by the neural service while a thought is in flight, BEFORE the
// response lands. Consumers keep the label in local state via onActivity;
// the snapshot reader covers mounting mid-turn (e.g. the view switches while
// she is already reading a file). No zustand — the label must never trigger
// global re-renders.
export interface ActivityMsg {
  label: string
  detail?: string
  at: number
}
const activityListeners = new Set<(m: ActivityMsg) => void>()
let latestActivity: ActivityMsg | null = null

// w5 voice-speed — the streaming reply: clean prose deltas of her answer,
// arriving WHILE the model still generates. Consumers accumulate text per
// turn (their own buffer resets on the response / the next thought). No
// zustand — the stream must never trigger global re-renders.
const chunkListeners = new Set<(m: ConsciousnessChunkMsg) => void>()
/** The most recent activity event of the CURRENT turn, if any (null before
 *  the first event or after a fresh turn's first event has not arrived). */
export function getActivitySnapshot(): ActivityMsg | null {
  return latestActivity
}

/**
 * Where the neural service lives:
 *  - On a PC (page served directly by Next.js on :3000, no gateway in front) →
 *    connect straight to the socket.io server on the same host (:3003).
 *  - Behind the sandbox preview gateway → everything flows through
 *    /?XTransformPort=3003 so the gateway can forward it.
 */
function neuralSocketUrl(): string {
  if (typeof window !== 'undefined' && window.location.port === '3000') {
    return `http://${window.location.hostname}:${NEURAL_SERVICE_PORT}`
  }
  return `/?XTransformPort=${NEURAL_SERVICE_PORT}`
}

function ensureSocket(): Socket {
  if (socket) return socket
  socket = io(neuralSocketUrl(), {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1500,
    reconnectionAttempts: Infinity,
    timeout: 10000,
  })

  const apply = (m: NeuralServerMessage) => useMistStore.getState().applyServerMessage(m)

  // w8 — the gemini browser relay: when a free Google key is configured and
  // THIS browser can reach Google (the one-shot TTS probe doubles as the
  // region probe), announce relay capability to the neural service. Her
  // server's Gemini egress may be region-blocked while this browser is not —
  // then this page quietly relays her thinking to Google and back.
  const offerGeminiRelay = () => {
    void (async () => {
      try {
        const key = await getGoogleKey()
        if (!key) return
        if ((await googleTtsAvailable()) !== 'available') return
        socket?.emit('relay_offer', { gemini: true })
      } catch {
        /* relay stays off — the server lane answers on its own */
      }
    })()
  }

  socket.on('connect', () => {
    useMistStore.getState().setConnected(true)
    offerGeminiRelay()
  })
  socket.on('disconnect', () => useMistStore.getState().setConnected(false))
  socket.on('consciousness_state', apply)
  socket.on('neural_state', apply)
  socket.on('provider_set', apply)
  socket.on('consciousness_response', (m: ConsciousnessResponseMsg) => {
    latestActivity = null // the turn is over — a stale label must never leak into the next one
    apply(m as NeuralServerMessage)
    responseListeners.forEach((cb) => cb(m))
  })
  socket.on('consciousness_chunk', (m: ConsciousnessChunkMsg) => {
    if (m && typeof m.text === 'string' && m.text) {
      chunkListeners.forEach((cb) => {
        try {
          cb(m)
        } catch {
          /* a consumer error must never break the stream */
        }
      })
    }
  })
  socket.on('synapse', (m: SynapseMsg) => synapseListeners.forEach((cb) => cb(m)))

  // w8 — the neural service borrowed this browser for one Gemini round trip
  // (her server's egress is region-blocked; this page is not). Answer with
  // the generated text, or the honest error — never leave a request hanging.
  socket.on(
    'relay_gemini_req',
    (m: { id?: string; model?: string; systemPrompt?: string; messages?: GeminiRelayMessage[] }) => {
      const id = typeof m?.id === 'string' ? m.id : ''
      if (!id) return
      googleLmGenerate({
        model: typeof m.model === 'string' && m.model ? m.model : 'gemini-2.0-flash',
        systemPrompt: typeof m.systemPrompt === 'string' ? m.systemPrompt : '',
        messages: Array.isArray(m.messages)
          ? m.messages.filter((x) => x && typeof x.content === 'string' && x.content)
          : [],
      })
        .then((text) => socket?.emit('relay_gemini_res', { id, ok: true, text }))
        .catch((err: unknown) => {
          socket?.emit('relay_gemini_res', {
            id,
            ok: false,
            error: err instanceof Error ? err.message : 'relay generation failed',
          })
        })
    }
  )
  socket.on('activity', (m: ActivityMsg) => {
    latestActivity = m
    activityListeners.forEach((cb) => cb(m))
  })
  socket.on('thought_cancelled', () => thoughtCancelledListeners.forEach((cb) => cb()))
  socket.on('pong', () => {
    /* liveness */
  })

  heartbeat = setInterval(() => {
    socket?.emit('ping')
  }, 25000)

  return socket
}

export interface ThoughtPayload {
  content: string
  provider?: ProviderId
  conversation_id?: string
  history?: HistoryMessage[]
  thinking?: boolean
}

export function useNeural() {
  useEffect(() => {
    ensureSocket()
    return () => {
      // socket intentionally survives unmounts (one connection per session)
    }
  }, [])

  const connected = useMistStore((s) => s.neural.connected)

  const sendThought = useCallback((payload: ThoughtPayload) => {
    const s = ensureSocket()
    const thinking = useMistStore.getState().thinkingEnabled
    latestActivity = null // fresh turn — the snapshot must not show the last turn's label
    s.emit('thought', { ...payload, thinking })
  }, [])

  const setProvider = useCallback((provider: ProviderId) => {
    const s = ensureSocket()
    s.emit('set_provider', { provider })
  }, [])

  /** mlv-ux-2 — cancel the in-flight thought (Mark-LV interrupt, web
   *  edition). The service aborts the backend fetch, settles dormant and
   *  acks with a 'thought_cancelled' event. Safe to call with nothing in
   *  flight (server-side no-op). */
  const cancelThought = useCallback(() => {
    const s = ensureSocket()
    s.emit('cancel_thought', {})
  }, [])

  const sendVoiceEnergy = useCallback((energy: number) => {
    const s = ensureSocket()
    s.emit('voice_chunk', { energy: Math.max(0, Math.min(1, energy)) })
  }, [])

  const ping = useCallback(() => {
    ensureSocket().emit('ping')
  }, [])

  const onResponse = useCallback((cb: (m: ConsciousnessResponseMsg) => void) => {
    responseListeners.add(cb)
    return () => {
      responseListeners.delete(cb)
    }
  }, [])

  const onSynapse = useCallback((cb: (m: SynapseMsg) => void) => {
    synapseListeners.add(cb)
    return () => {
      synapseListeners.delete(cb)
    }
  }, [])

  const onThoughtCancelled = useCallback((cb: () => void) => {
    thoughtCancelledListeners.add(cb)
    return () => {
      thoughtCancelledListeners.delete(cb)
    }
  }, [])

  /** w3-activity — subscribe to the live activity stream (one event per
   *  thing she does while a thought is in flight). Returns an unsub. */
  const onActivity = useCallback((cb: (m: ActivityMsg) => void) => {
    activityListeners.add(cb)
    return () => {
      activityListeners.delete(cb)
    }
  }, [])

  /** w5 voice-speed — subscribe to the streaming reply (clean prose deltas
   *  while she generates). The turn ends with the regular onResponse. */
  const onChunk = useCallback((cb: (m: ConsciousnessChunkMsg) => void) => {
    chunkListeners.add(cb)
    return () => {
      chunkListeners.delete(cb)
    }
  }, [])

  return {
    connected,
    sendThought,
    setProvider,
    cancelThought,
    sendVoiceEnergy,
    ping,
    onResponse,
    onSynapse,
    onThoughtCancelled,
    onActivity,
    onChunk,
  }
}
