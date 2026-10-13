'use client'

// M.I.S.T. — research-flow: the deep-research job lifecycle for the chat.
//
// Phase 4-a · chat-panel split: the research flow (start → live console ticks
// → done/error handling with persistence + TTS) extracted from the god-file
// one-to-one. The flow still runs against the PANEL's state through the
// injected handles — identical setters in identical order, zero data-flow
// redesign — it just stops bloating the shell.
//
// Owner of: the live research job state (+ its ref mirror) and the
// citations mapping.

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMistStore, type ResearchDepth } from '@/lib/store'
import { mistApi } from '@/lib/mist-api'
import type { Citation, ResearchJob } from '@/lib/types'
import type { ResearchPipelineMeta } from '@/components/mist/chat/research-timeline'
import type { LocalMessage } from './chat-panel'
import type { TtsOrchestrator } from './tts-orchestrator'

/** Job citations → panel Citation[] (credibility inherited from matched sources). */
function mapResearchCitations(job: ResearchJob): Citation[] {
  return (job.citations ?? []).map((c, i) => {
    let domain = c.url
    try {
      domain = new URL(c.url).hostname.replace(/^www\./, '')
    } catch {
      /* keep url */
    }
    const src = (job.sources ?? []).find((s) => s.url === c.url)
    return {
      n: i + 1,
      url: c.url,
      title: c.title,
      domain,
      quality: src?.credibility ?? 'medium',
      verified: c.verified,
    }
  })
}

export interface ResearchFlowHandles {
  /** The panel's awaiting toggle (composer lock + orb state). */
  setAwaitingBoth: (b: boolean) => void
  /** The panel's scroll bookkeeping (research ticks pin to the bottom). */
  scrollRef: { current: HTMLDivElement | null }
  atBottomRef: { current: boolean }
  /** Which thread the exchange belongs to (persistence target fallback). */
  sendThreadIdRef: { current: string | null }
  /** Voice-replies orchestration (reports are spoken). */
  tts: TtsOrchestrator
  /** Message append (the report becomes a message row). */
  appendMessage: (m: LocalMessage) => void
}

export interface ResearchFlow {
  /** Live deep-research job rendered as the research console (v5). */
  research: { jobId: string; query: string; depth: ResearchDepth } | null
  setResearch: (r: { jobId: string; query: string; depth: ResearchDepth } | null) => void
  /** Ref mirror for interrupt callbacks (researchRef in the panel). */
  researchRef: { current: { jobId: string; query: string; depth: ResearchDepth } | null }
  startResearch: (query: string, depth: ResearchDepth) => Promise<void>
  handleResearchDone: (job: ResearchJob) => void
  handleResearchError: (message: string) => void
  handleResearchTick: () => void
}

export function useResearchFlow(handles: ResearchFlowHandles): ResearchFlow {
  // Handles are captured through a ref so every callback below keeps a
  // STABLE identity (the panel re-renders often; the flow callbacks feed
  // register-once effects and memoized children exactly as before). Written
  // in an effect (never during render) per react-hooks refs-during-render.
  const h = useRef(handles)
  useEffect(() => {
    h.current = handles
  })

  const [research, setResearch] = useState<ResearchFlow['research']>(null)
  /** mlv-ux-2 — mirrors the live research job so interrupt callbacks (which
   *  must stay referentially stable) always read the current value. */
  const researchRef = useRef(research)
  useEffect(() => {
    researchRef.current = research
  }, [research])

  /** Kick off an async research job — the console polls it live. */
  const startResearch = useCallback(async (query: string, depth: ResearchDepth) => {
    h.current.setAwaitingBoth(true)
    h.current.atBottomRef.current = true
    const store = useMistStore.getState()
    try {
      const res = await mistApi.research.start(query, depth)
      if (!res?.jobId) throw new Error('the research engine returned no job id')
      setResearch({ jobId: res.jobId, query, depth })
      store.setResearchActive(true)
      store.setNeuralState('processing')
    } catch (err) {
      toast.error('Deep research could not start', {
        description:
          err instanceof Error && err.message
            ? err.message
            : 'The research engine is unreachable — try again in a moment.',
      })
      h.current.setAwaitingBoth(false)
      store.setResearchActive(false)
    }
  }, [])

  const handleResearchDone = useCallback(
    (job: ResearchJob) => {
      const store = useMistStore.getState()
      const report = (job.report ?? '').trim()
      const citations = mapResearchCitations(job)
      const suggestions = Array.isArray(job.suggestions) ? job.suggestions.slice(0, 6) : []
      // oj-face-5: persist the research PIPELINE snapshot (phases, queries,
      // sources with credibility, pages read) so the ResearchTimeline can
      // replay the run on this message — real job data, never synthesized.
      const researchMeta: ResearchPipelineMeta = {
        status: job.status,
        depth: job.depth,
        phases: Array.isArray(job.phases) ? job.phases : [],
        queries: Array.isArray(job.queries) ? job.queries : [],
        sources: Array.isArray(job.sources) ? job.sources : [],
        pagesRead: job.pagesRead ?? 0,
        elapsedMs: job.elapsedMs ?? 0,
      }
      const assistantMsg: LocalMessage = {
        id: uid(),
        role: 'assistant',
        content: report || 'Research completed, but the engine returned an empty report.',
        provider: 'research',
        model: 'deep-research',
        citations,
        suggestions,
        savedTo: job.savedTo,
        research: researchMeta,
        ts: new Date(),
      }
      // Only render into the view that owns this exchange (mirrors handleResponse).
      const currentId = store.threads.activeId
      const belongsHere =
        !h.current.sendThreadIdRef.current || h.current.sendThreadIdRef.current === currentId || currentId === null
      if (belongsHere) h.current.appendMessage(assistantMsg)
      h.current.setAwaitingBoth(false)
      setResearch(null)
      store.setResearchActive(false)
      store.setNeuralState('dormant')

      const persistTo = h.current.sendThreadIdRef.current ?? currentId
      if (persistTo && report) {
        mistApi.conversations
          .appendMessage(persistTo, 'assistant', report, {
            provider: 'research',
            model: 'deep-research',
            meta: { citations, suggestions, savedTo: job.savedTo, research: researchMeta },
          })
          .catch(() => {})
      }
      store.bumpThreadsRefresh()
      // v6: all speech flows through the shared mistSpeech singleton — it
      // strips markdown + code itself and always interrupts the previous
      // utterance, so only the newest report is ever heard.
      if (store.ttsEnabled && report) {
        h.current.tts.speakReply(assistantMsg.id, report)
      }
    },
    []
  )

  const handleResearchError = useCallback((_message: string) => {
    // The console stays mounted in its error state (retry lives there).
    h.current.setAwaitingBoth(false)
    const store = useMistStore.getState()
    store.setResearchActive(false)
    store.setNeuralState('dormant')
  }, [])

  const handleResearchTick = useCallback(() => {
    // Re-assert the processing orb against ambient socket pulses + keep the
    // stream pinned to the live console while the user is at the bottom.
    const store = useMistStore.getState()
    if (store.researchActive) store.setNeuralState('processing')
    const el = h.current.scrollRef.current
    if (el && h.current.atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [])

  return {
    research,
    setResearch,
    researchRef,
    startResearch,
    handleResearchDone,
    handleResearchError,
    handleResearchTick,
  }
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
