'use client'

// M.I.S.T. — chat-header: the conversation surface's control strip.
//
// Phase 4-a · chat-panel split: the header (persona picker, provider picker,
// thinking toggle, voice-session quick-jump, TTS toggle, new-thread button)
// extracted from the god-file one-to-one. Pure presentation — every control
// calls back into the panel's flow.

import { Brain, Mic, Plus, Volume2, VolumeX } from 'lucide-react'
import { useMistStore, type MistPersona } from '@/lib/store'
import { PROVIDER_LABELS } from '@/lib/mist-constants'
import type { ProviderId } from '@/lib/types'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

/** The 6 backend personas (unified LLM modes) surfaced as a picker. */
const PERSONAS: Array<{ id: MistPersona; label: string; hint: string }> = [
  { id: 'consciousness', label: 'Consciousness', hint: 'poetic-aware core' },
  { id: 'chat', label: 'Chat', hint: 'fast + practical' },
  { id: 'studio', label: 'Studio', hint: 'creative mode' },
  { id: 'vision', label: 'Vision', hint: 'visual analysis' },
  { id: 'swarm', label: 'Swarm', hint: 'orchestrator' },
  { id: 'memory_query', label: 'Memory Query', hint: 'recall-focused' },
]

export interface ChatHeaderProps {
  threadTitle?: string
  persona: MistPersona
  onPersona: (p: MistPersona) => void
  provider: ProviderId
  providerOptions: ProviderId[]
  onProvider: (p: ProviderId) => void
  thinkingEnabled: boolean
  onThinking: (b: boolean) => void
  ttsEnabled: boolean
  onTts: (b: boolean) => void
  onNewThread: () => void
}

export function ChatHeader(props: ChatHeaderProps) {
  const {
    threadTitle,
    persona,
    onPersona,
    provider,
    providerOptions,
    onProvider,
    thinkingEnabled,
    onThinking,
    ttsEnabled,
    onTts,
    onNewThread,
  } = props

  // voice-session quick-jump: hands-free at the orb (store-driven, no prop)
  const setView = useMistStore((s) => s.setView)
  const requestVoiceSession = useMistStore((s) => s.requestVoiceSession)

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-white/10 p-4">
      <div className="hidden min-w-0 flex-1 basis-36 sm:block">
        <h2 className="truncate text-sm font-medium text-slate-200">
          {threadTitle || 'New consciousness thread'}
        </h2>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {/* persona picker (v5 — unified mode passthrough) */}
        <Select value={persona} onValueChange={(v) => onPersona(v as MistPersona)}>
          <SelectTrigger
            size="sm"
            aria-label="M.I.S.T. persona"
            className="w-[132px] rounded-lg border-white/10 bg-white/5 font-mono text-xs text-slate-300 focus-visible:ring-fuchsia-400/60"
          >
            <SelectValue placeholder="persona">
              {PERSONAS.find((p) => p.id === persona)?.label ?? 'Consciousness'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="border-white/10 bg-slate-900/95 font-mono text-xs backdrop-blur-xl">
            {PERSONAS.map((p) => (
              <SelectItem
                key={p.id}
                value={p.id}
                className="text-slate-300 focus:bg-fuchsia-400/15 focus:text-fuchsia-100"
              >
                <span className="flex flex-col gap-0.5 py-0.5">
                  <span>{p.label}</span>
                  <span className="text-[10px] normal-case tracking-normal text-slate-500">
                    {p.hint}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={provider} onValueChange={(v) => onProvider(v as ProviderId)}>
          <SelectTrigger
            size="sm"
            aria-label="AI provider"
            className="w-[118px] rounded-lg border-white/10 bg-white/5 font-mono text-xs text-slate-300 focus-visible:ring-purple-400/60 sm:w-[150px]"
          >
            <SelectValue placeholder="provider" />
          </SelectTrigger>
          <SelectContent className="border-white/10 bg-slate-900/95 font-mono text-xs backdrop-blur-xl">
            {providerOptions.map((p) => (
              <SelectItem
                key={p}
                value={p}
                className="text-slate-300 focus:bg-purple-400/15 focus:text-purple-100"
              >
                {PROVIDER_LABELS[p] ?? p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <button
          onClick={() => onThinking(!thinkingEnabled)}
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
            thinkingEnabled
              ? 'bg-white/10 text-white'
              : 'bg-white/5 text-white/60 hover:bg-white/10'
          )}
          title="asks the model to reason (GLM core)"
          aria-pressed={thinkingEnabled}
        >
          <Brain aria-hidden className="h-3.5 w-3.5" />
          <span>thinking</span>
        </button>

        {/* voice session quick-jump (v6) — hands-free at the orb */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Talk with Mist"
          title="Talk with Mist — hands-free voice session"
          onClick={() => {
            setView('consciousness')
            requestVoiceSession()
          }}
          className="h-9 w-9 rounded-lg text-slate-400 hover:bg-white/5 hover:text-teal-200 focus-visible:ring-purple-400/60"
        >
          <Mic aria-hidden className="h-4 w-4" />
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Toggle voice replies"
          aria-pressed={ttsEnabled}
          onClick={() => onTts(!ttsEnabled)}
          className={cn(
            'h-9 w-9 rounded-lg hover:bg-white/5 focus-visible:ring-purple-400/60',
            ttsEnabled ? 'text-teal-300' : 'text-slate-500 hover:text-slate-300'
          )}
        >
          {ttsEnabled ? (
            <Volume2 aria-hidden className="h-4 w-4" />
          ) : (
            <VolumeX aria-hidden className="h-4 w-4" />
          )}
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="New thread"
          onClick={onNewThread}
          className="h-9 w-9 rounded-lg text-slate-400 hover:bg-white/5 hover:text-purple-200 focus-visible:ring-purple-400/60"
        >
          <Plus aria-hidden className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
