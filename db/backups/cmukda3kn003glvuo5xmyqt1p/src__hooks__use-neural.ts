// M.I.S.T. neural stream hook — ONE socket.io connection per session (spec 4.7).
// The socket is a module-level singleton; the callback registry lets the chat
// component own message state while receiving responses.
'use client'

import { useCallback, useEffect } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useMistStore } from '@/lib/store'
import { NEURAL_SERVICE_PORT } from '@/lib/mist-constants'
import type {
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

  socket.on('connect', () => useMistStore.getState().setConnected(true))
  socket.on('disconnect', () => useMistStore.getState().setConnected(false))
  socket.on('consciousness_state', apply)
  socket.on('neural_state', apply)
  socket.on('provider_set', apply)
  socket.on('consciousness_response', (m: ConsciousnessResponseMsg) => {
    apply(m as NeuralServerMessage)
    responseListeners.forEach((cb) => cb(m))
  })
  socket.on('synapse', (m: SynapseMsg) => synapseListeners.forEach((cb) => cb(m)))
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
    s.emit('thought', payload)
  }, [])

  const setProvider = useCallback((provider: ProviderId) => {
    const s = ensureSocket()
    s.emit('set_provider', { provider })
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

  return { connected, sendThought, setProvider, sendVoiceEnergy, ping, onResponse, onSynapse }
}
