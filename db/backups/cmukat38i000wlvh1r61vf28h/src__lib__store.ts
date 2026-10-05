// M.I.S.T. global client state (zustand). Message state intentionally lives
// inside the chat component (spec 4.7) — this store holds UI/shell state only.
'use client'

import { create } from 'zustand'
import type {
  ConsciousnessState,
  ConsciousnessFace,
  Conversation,
  ProviderId,
  NeuralServerMessage,
  ConsciousnessResponseMsg,
} from './types'

export type MistView = 'consciousness' | 'chat' | 'self' | 'settings'
export type DrawerTab =
  | 'system'
  | 'tools'
  | 'memory'
  | 'voice'
  | 'skills'
  | 'agents'
  | 'evolve'
  | 'automations'
  | 'vault'

/** Voice pipeline preference: where hearing (STT) + speaking (TTS) run. */
export type VoiceMode = 'auto' | 'local' | 'cloud' | 'browser'

/** Compact mirror of the bridge's local voice status (see voice-local.ts). */
export interface LocalVoiceState {
  available: boolean
  checkedAt: number
  tier?: string
  sttReady?: boolean
  ttsReady?: boolean
}

/** Backend persona / unified LLM mode surfaced in the chat header (v5). */
export type MistPersona =
  | 'consciousness'
  | 'chat'
  | 'studio'
  | 'vision'
  | 'swarm'
  | 'memory_query'

/** Deep-research depth — 2 reads more pages and searches wider (v5). */
export type ResearchDepth = 1 | 2

export interface BrowserTab {
  id: string
  url: string
  title: string
  kind: 'video' | 'article' | 'cockpit'
  seekTo?: number
  note?: string
  openedAt: number
}

interface NeuralStateSlice {
  state: ConsciousnessState
  load: number
  provider: ProviderId
  model: string
  fallback: boolean
  connected: boolean
  memoryActive: boolean
  voiceReady: boolean
  audioEnergy: number
  emotion: string
}

interface MistStore {
  // shell
  view: MistView
  setView: (v: MistView) => void
  drawerOpen: boolean
  drawerTab: DrawerTab
  openDrawer: (tab?: DrawerTab) => void
  closeDrawer: () => void
  // panels
  threadsCollapsed: boolean
  toggleThreads: () => void
  synapseOpen: boolean
  setSynapseOpen: (open: boolean) => void
  // preferences (persisted)
  provider: ProviderId
  setProvider: (p: ProviderId) => void
  animationIntensity: number // 0..100
  setAnimationIntensity: (n: number) => void
  /** Effective reduced-motion flag — what every component reads. */
  reducedMotion: boolean
  /** Explicit user choice. 'calm'/'full' persist; null = follow the OS (session-only). */
  motionChoice: 'calm' | 'full' | null
  /** Explicit toggle — persists and overrides the OS preference. */
  setReducedMotion: (b: boolean) => void
  /** Session-only adoption of the OS preference (never persisted — avoids the
   *  trap where a one-off OS setting silently froze the app forever). */
  adoptOsReducedMotion: (osReduced: boolean) => void
  ttsEnabled: boolean
  setTtsEnabled: (b: boolean) => void
  voice: string
  setVoice: (v: string) => void
  /** Voice pipeline preference (persisted): auto = local offline engines when
   *  the bridge reports both ready, else cloud; local/cloud/browser force one. */
  voiceMode: VoiceMode
  setVoiceMode: (m: VoiceMode) => void
  /** Live mirror of the local offline voice engines (bridge probe, 30s cache
   *  in voice-local.ts) — session-only, never persisted. */
  localVoice: LocalVoiceState | null
  setLocalVoice: (v: LocalVoiceState | null) => void
  hydrateUI: () => void
  // neural mirror (driven by socket events)
  neural: NeuralStateSlice
  setNeuralState: (s: ConsciousnessState) => void
  setAudioEnergy: (e: number) => void
  setConnected: (b: boolean) => void
  applyServerMessage: (m: NeuralServerMessage) => void
  // backend health
  backend: { online: boolean; latency: number | null }
  setBackend: (b: { online: boolean; latency: number | null }) => void
  // mic focus (Alt+V)
  micFocus: number
  incrementMicFocus: () => void
  // threads
  threads: { list: Conversation[]; activeId: string | null; loading: boolean }
  setThreads: (list: Conversation[]) => void
  setActiveThread: (id: string | null) => void
  threadsLoading: (b: boolean) => void
  threadsRefreshSeq: number
  bumpThreadsRefresh: () => void
  // in-app browser (v2 — MIST opens tabs)
  browser: { tabs: BrowserTab[]; activeTabId: string | null; open: boolean }
  openBrowserTab: (tab: { url: string; title: string; kind: BrowserTab['kind']; seekTo?: number; note?: string }) => void
  closeBrowserTab: (id: string) => void
  activateBrowserTab: (id: string) => void
  setBrowserOpen: (open: boolean) => void
  closeBrowserCockpit: () => void
  autoOpenMedia: boolean
  setAutoOpenMedia: (b: boolean) => void
  // deep research mode (v5)
  /** Session toggle — ON routes sends into the research engine instead of the neural socket. */
  researchMode: boolean
  setResearchMode: (b: boolean) => void
  /** Persisted depth preference (1 = fast · 2 pages, 2 = deep · 4 pages). */
  researchDepth: ResearchDepth
  setResearchDepth: (d: ResearchDepth) => void
  /** True while a research job is live — holds the orb in 'processing' against ambient pulses. */
  researchActive: boolean
  setResearchActive: (b: boolean) => void
  // persona (v5 — persisted 'mist:persona')
  persona: MistPersona
  setPersona: (p: MistPersona) => void
  // consciousness face (v7 — persisted 'mist:face'): the visual identity of
  // the consciousness stage — Mist's own orb, or one of the four adapted
  // ai-visualizer canvas faces fed live by her voice state.
  consciousnessFace: ConsciousnessFace
  setConsciousnessFace: (f: ConsciousnessFace) => void
  // voice-first sprint (v6)
  /** "Hey Mist" background wake word — persisted, off by default (mic trust). */
  wakeWordEnabled: boolean
  setWakeWordEnabled: (b: boolean) => void
  /** Glass effect opacity (0-100). */
  glassOpacity: number
  setGlassOpacity: (n: number) => void
  /** Glass effect blur (px). */
  glassBlur: number
  setGlassBlur: (n: number) => void
  /** Accent color for glass effect. */
  accentColor: string
  setAccentColor: (c: string) => void
  /** Bumped whenever something asks the consciousness stage to start a hands-free
   *  voice session (orb click, wake word, mini-orb). The stage subscribes. */
  voiceArmedSeq: number
  requestVoiceSession: () => void
}

// ---------- persistence helpers ----------
const LS_PREFIX = 'mist:'
function loadLS<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
function saveLS(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

let hydrated = false

export const useMistStore = create<MistStore>((set, get) => ({
  // shell
  view: 'consciousness',
  setView: (v) => {
    set({ view: v })
    saveLS('view', v)
  },
  drawerOpen: false,
  drawerTab: 'system',
  openDrawer: (tab) => set((s) => ({ drawerOpen: true, drawerTab: tab ?? s.drawerTab })),
  closeDrawer: () => set({ drawerOpen: false }),

  // panels
  threadsCollapsed: false,
  toggleThreads: () => {
    const next = !get().threadsCollapsed
    set({ threadsCollapsed: next })
    saveLS('threadsCollapsed', next)
  },
  synapseOpen: false,
  setSynapseOpen: (open) => set({ synapseOpen: open }),

  // preferences
  provider: 'auto',
  setProvider: (p) => {
    set({ provider: p })
    saveLS('provider', p)
  },
  animationIntensity: 80,
  setAnimationIntensity: (n) => {
    set({ animationIntensity: Math.max(0, Math.min(100, n)) })
    saveLS('animationIntensity', get().animationIntensity)
  },
  reducedMotion: false,
  motionChoice: null,
  setReducedMotion: (b) => {
    // explicit user choice — persists under its own key and wins over the OS
    set({ reducedMotion: b, motionChoice: b ? 'calm' : 'full' })
    saveLS('motionChoice', b ? 'calm' : 'full')
  },
  adoptOsReducedMotion: (osReduced) => {
    // No explicit choice → mirror the OS for this session only.
    if (get().motionChoice !== null) return
    set({ reducedMotion: osReduced })
  },
  ttsEnabled: true,
  setTtsEnabled: (b) => {
    set({ ttsEnabled: b })
    saveLS('ttsEnabled', b)
  },
  consciousnessFace: 'orb',
  setConsciousnessFace: (f) => {
    set({ consciousnessFace: f })
    saveLS('face', f)
  },
  voice: 'tongtong',
  setVoice: (v) => {
    set({ voice: v })
    saveLS('voice', v)
  },
  voiceMode: 'auto',
  setVoiceMode: (m) => {
    set({ voiceMode: m })
    saveLS('voiceMode', m)
  },
  localVoice: null,
  setLocalVoice: (v) => set({ localVoice: v }),
  hydrateUI: () => {
    // restore persisted prefs exactly once on mount (avoids SSR hydration mismatch)
    if (hydrated) return
    hydrated = true
    set({
      provider: loadLS<ProviderId>('provider', 'auto'),
      animationIntensity: loadLS('animationIntensity', 80),
      // motionChoice v2: only an EXPLICIT settings toggle persists. The legacy
      // 'reducedMotion' key (which once stored an auto-adopted OS value) is
      // ignored on purpose so nobody stays trapped in calm mode.
      motionChoice: loadLS<'calm' | 'full' | null>('motionChoice', null),
      reducedMotion: loadLS<'calm' | 'full' | null>('motionChoice', null) === 'calm',
      ttsEnabled: loadLS('ttsEnabled', true),
      voice: loadLS('voice', 'tongtong'),
      voiceMode: loadLS<VoiceMode>('voiceMode', 'auto'),
      threadsCollapsed: loadLS('threadsCollapsed', false),
      autoOpenMedia: loadLS('autoOpenMedia', true),
      persona: loadLS<MistPersona>('persona', 'consciousness'),
      researchDepth: loadLS<ResearchDepth>('researchDepth', 1),
      wakeWordEnabled: loadLS<boolean>('wakeWord', false),
      glassOpacity: loadLS('glassOpacity', 30),
      glassBlur: loadLS('glassBlur', 16),
      accentColor: loadLS('accentColor', '#a855f7'),
      consciousnessFace: loadLS<ConsciousnessFace>('face', 'orb'),
    })
  },

  // neural mirror
  neural: {
    state: 'dormant',
    load: 0.12,
    provider: 'auto',
    model: '',
    fallback: false,
    connected: false,
    memoryActive: true,
    voiceReady: true,
    audioEnergy: 0,
    emotion: 'calm',
  },
  setNeuralState: (s) =>
    set((st) => ({ neural: { ...st.neural, state: s } })),
  setAudioEnergy: (e) =>
    set((st) => ({ neural: { ...st.neural, audioEnergy: Math.max(0, Math.min(1, e)) } })),
  setConnected: (b) =>
    set((st) => ({ neural: { ...st.neural, connected: b } })),
  applyServerMessage: (m) => {
    const st = get()
    switch (m.type) {
      case 'consciousness_state':
        set({
          neural: {
            ...st.neural,
            state: m.state,
            load: m.neural_load,
            provider: m.provider,
            model: m.model,
            memoryActive: m.memory_active,
            voiceReady: m.voice_ready,
          },
        })
        break
      case 'neural_state': {
        // Client-side TTS playback owns the 'speaking' state — periodic
        // service pulses must not downgrade it back to dormant while the
        // voice is actually playing (the service can't hear our speakers).
        // Exit paths: audio onended/error (setNeuralState('dormant')) or a
        // genuinely different state (processing/listening) always wins.
        if (st.neural.state === 'speaking' && m.state === 'dormant') {
          set({ neural: { ...st.neural, load: m.neural_load } })
          break
        }
        // Deep research holds the same privilege for 'processing': research
        // jobs never flow through the socket, so the service considers
        // itself idle and pulses 'dormant' every ~950ms. While a job is live
        // the orb must keep dancing — only the load metric updates.
        // Exit path: setResearchActive(false) on done/error always wins.
        if (st.researchActive && m.state === 'dormant') {
          set({ neural: { ...st.neural, load: m.neural_load } })
          break
        }
        // Dreaming is a CLIENT-owned state (the service has no dream concept,
        // so its idle pulses would stomp it within a second). Ambient dormant
        // pulses only refresh the load. Exit paths: a genuinely different
        // service state (processing/listening/speaking/awakening) always wins,
        // and the dream toggle / a new voice session clears it.
        if (st.neural.state === 'dreaming' && m.state === 'dormant') {
          set({ neural: { ...st.neural, load: m.neural_load } })
          break
        }
        set({
          neural: {
            ...st.neural,
            state: m.state,
            load: m.neural_load,
            ...(m.provider ? { provider: m.provider } : {}),
            ...(m.model ? { model: m.model } : {}),
          },
        })
        break
      }
      case 'provider_set':
        set({ neural: { ...st.neural, provider: m.provider, ...(m.model ? { model: m.model } : {}) } })
        break
      case 'consciousness_response': {
        const r = m as ConsciousnessResponseMsg
        set({
          neural: {
            ...st.neural,
            state: st.neural.state === 'processing' ? 'dormant' : st.neural.state,
            load: r.neural_load,
            provider: r.provider,
            model: r.model,
            fallback: r.fallback,
            emotion: r.emotion,
          },
        })
        break
      }
      default:
        break
    }
  },

  // backend health
  backend: { online: false, latency: null },
  setBackend: (b) => set({ backend: b }),

  // mic focus
  micFocus: 0,
  incrementMicFocus: () => set((s) => ({ micFocus: s.micFocus + 1 })),

  // threads
  threads: { list: [], activeId: null, loading: false },
  setThreads: (list) => set((s) => ({ threads: { ...s.threads, list } })),
  setActiveThread: (id) => set((s) => ({ threads: { ...s.threads, activeId: id } })),
  threadsLoading: (b) => set((s) => ({ threads: { ...s.threads, loading: b } })),
  threadsRefreshSeq: 0,
  bumpThreadsRefresh: () => set((s) => ({ threadsRefreshSeq: s.threadsRefreshSeq + 1 })),

  // in-app browser (v2)
  browser: { tabs: [], activeTabId: null, open: false },
  openBrowserTab: (tab) =>
    set((s) => {
      const id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const full: BrowserTab = { id, openedAt: Date.now(), ...tab }
      // cap at 6 tabs like a tidy browser — drop the oldest
      const tabs = s.browser.tabs.length >= 6 ? s.browser.tabs.slice(1) : s.browser.tabs
      return { browser: { tabs: [...tabs, full], activeTabId: id, open: true } }
    }),
  closeBrowserTab: (id) =>
    set((s) => {
      const tabs = s.browser.tabs.filter((t) => t.id !== id)
      const activeTabId = s.browser.activeTabId === id ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null) : s.browser.activeTabId
      return { browser: { tabs, activeTabId, open: tabs.length > 0 ? s.browser.open : false } }
    }),
  activateBrowserTab: (id) => set((s) => ({ browser: { ...s.browser, activeTabId: id, open: true } })),
  setBrowserOpen: (open) => set((s) => ({ browser: { ...s.browser, open } })),
  closeBrowserCockpit: () => set((s) => ({ browser: { ...s.browser, open: false } })),
  autoOpenMedia: true,
  setAutoOpenMedia: (b) => {
    set({ autoOpenMedia: b })
    saveLS('autoOpenMedia', b)
  },

  // deep research mode (v5)
  researchMode: false,
  setResearchMode: (b) => set({ researchMode: b }), // session-only by design — never silently re-arms after reload
  researchDepth: 1,
  setResearchDepth: (d) => {
    set({ researchDepth: d })
    saveLS('researchDepth', d)
  },
  researchActive: false,
  setResearchActive: (b) => set({ researchActive: b }),

  // persona (v5)
  persona: 'consciousness',
  setPersona: (p) => {
    set({ persona: p })
    saveLS('persona', p)
  },

  // voice-first sprint (v6)
  wakeWordEnabled: false,
  setWakeWordEnabled: (b) => {
    set({ wakeWordEnabled: b })
    saveLS('wakeWord', b)
  },
  glassOpacity: 30,
  setGlassOpacity: (n) => {
    set({ glassOpacity: Math.max(10, Math.min(100, n)) })
    saveLS('glassOpacity', get().glassOpacity)
  },
  glassBlur: 16,
  setGlassBlur: (n) => {
    set({ glassBlur: Math.max(0, Math.min(40, n)) })
    saveLS('glassBlur', get().glassBlur)
  },
  accentColor: '#a855f7',
  setAccentColor: (c) => {
    set({ accentColor: c })
    saveLS('accentColor', c)
  },
  voiceArmedSeq: 0,
  requestVoiceSession: () => set((s) => ({ voiceArmedSeq: s.voiceArmedSeq + 1 })),
}))
