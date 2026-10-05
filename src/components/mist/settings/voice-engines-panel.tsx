'use client';
import React, { useState, useEffect } from 'react';
import { Search, Download, Check, Mic, AudioLines } from 'lucide-react';

/**
 * Voice Engines panel — written by MIST (mission cmulfhhcz, 2026-09-28),
 * data layer aligned to the real bridge v3.6 contract by the lead after the
 * browser E2E caught the shape drift:
 *   discover → { ok, fasterWhisper:[{python,version,via}], piper:[paths],
 *                voiceDirs:[{dir,origin,voices}], foreignVoices:[paths],
 *                mistVoiceInstalled:{whisperCpp,piper},
 *                adopted:{sttEngine,fwPython,piperBin,extraVoicesDir} }
 *   adopt    → flat fields { fwPython, sttEngine } / { piperBin, extraVoicesDir }
 *   voices   → { ok, selected, count, voices:[{id,language,accent?,name,quality}] }
 *   select   → flat field { ttsVoice }
 */

interface FwEngine { python: string; version?: string; via?: string }
interface VoiceEntry { id: string; dir?: string; language?: string; accent?: string; name?: string; quality?: string }
interface DiscoverResult {
  ok?: boolean
  fasterWhisper?: FwEngine[]
  piper?: string[]
  voiceDirs?: Array<{ dir: string; origin?: string; voices?: number }>
  foreignVoices?: string[]
  mistVoiceInstalled?: { whisperCpp?: boolean; piper?: boolean }
  adopted?: { sttEngine?: string; fwPython?: string; piperBin?: string; extraVoicesDir?: string }
  bridgeConnected?: boolean
}

const post = async (body: Record<string, unknown>) => {
  const res = await fetch('/api/mist/voice/local/engines', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  return data
}

const VoiceEnginesPanel = () => {
  const [discovered, setDiscovered] = useState<DiscoverResult | null>(null)
  const [voices, setVoices] = useState<VoiceEntry[]>([])
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null)
  const [busy, setBusy] = useState<'discover' | 'voices' | 'adopt' | 'select' | null>(null)
  const [bridgeOnline, setBridgeOnline] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adoptedNote, setAdoptedNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    post({ action: 'discover' })
      .then((d: DiscoverResult) => { if (alive) { setDiscovered(d); setBridgeOnline(true) } })
      .catch(() => { if (alive) setBridgeOnline(false) })
    return () => { alive = false }
  }, [])

  const handleDiscover = async () => {
    setBusy('discover'); setError(null)
    try {
      const d = (await post({ action: 'discover' })) as DiscoverResult
      setDiscovered(d)
      setBridgeOnline(Boolean(d.bridgeConnected))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'discover failed')
      setBridgeOnline(false)
    } finally { setBusy(null) }
  }

  const handleAdoptFw = async (fw: FwEngine) => {
    setBusy('adopt'); setError(null); setAdoptedNote(null)
    try {
      await post({ action: 'adopt', sttEngine: 'faster-whisper', fwPython: fw.python })
      setAdoptedNote(`faster-whisper adopted (${fw.python})`)
      await handleDiscover()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'adopt failed')
    } finally { setBusy(null) }
  }

  const handleAdoptPiper = async (bin: string, voicesDir?: string) => {
    setBusy('adopt'); setError(null); setAdoptedNote(null)
    try {
      const body: Record<string, unknown> = { action: 'adopt', piperBin: bin }
      if (voicesDir) body.extraVoicesDir = voicesDir
      await post(body)
      setAdoptedNote(`piper adopted (${bin})`)
      await handleDiscover()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'adopt failed')
    } finally { setBusy(null) }
  }

  const handleGetVoices = async () => {
    setBusy('voices'); setError(null)
    try {
      const d = (await post({ action: 'voices' })) as { voices?: VoiceEntry[]; selected?: string | null }
      setVoices(d.voices ?? [])
      setSelectedVoice(d.selected ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not list voices')
    } finally { setBusy(null) }
  }

  const handleSelectVoice = async (voice: VoiceEntry) => {
    setBusy('select'); setError(null)
    try {
      await post({ action: 'select', ttsVoice: voice.id })
      setSelectedVoice(voice.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'select failed')
    } finally { setBusy(null) }
  }

  const fwList = discovered?.fasterWhisper ?? []
  const piperList = discovered?.piper ?? []
  const adopted = discovered?.adopted
  const nothingFound = fwList.length === 0 && piperList.length === 0 && voices.length === 0

  if (bridgeOnline === false) {
    return (
      <div className="mb-3 rounded-xl border border-white/5 bg-white/[0.02] p-4 font-mono text-[10px] text-slate-400">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-400" />
          <span className="uppercase tracking-widest text-slate-400">voice engines — bridge offline</span>
        </div>
        <p className="mt-1.5 leading-relaxed text-slate-500">
          engine adoption runs through the bridge — download <span className="text-purple-300">mist-bridge.js</span> (bridge
          section above), run <span className="text-purple-300">node mist-bridge.js</span> and keep the window open, then
          come back and Discover.
        </p>
      </div>
    )
  }

  return (
    <div className="mb-3 rounded-xl border border-white/5 bg-white/[0.02] p-4 font-mono text-[10px] text-slate-400">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AudioLines className="h-3 w-3 text-emerald-300" aria-hidden="true" />
          <h2 className="uppercase tracking-widest text-emerald-300">voice engines (adopt yours)</h2>
        </div>
        <button
          onClick={handleDiscover}
          disabled={busy !== null}
          className="flex items-center gap-1 border border-white/15 bg-white/5 px-2 py-1 text-emerald-300 hover:border-white/30 disabled:opacity-50"
        >
          <Search className={'h-3 w-3 ' + (busy === 'discover' ? 'animate-pulse' : '')} aria-hidden="true" />
          Discover
        </button>
      </div>

      <p className="mb-3 leading-relaxed text-slate-500">
        find faster-whisper (wherever it lives — global or inside a Hermes environment) and reuse the piper + voices Hermes
        already downloaded — no second download. adopting keeps cloud voice until a local engine answers.
      </p>

      {error ? <p className="mb-2 text-rose-300">error: {error}</p> : null}
      {adoptedNote ? <p className="mb-2 text-emerald-300">{adoptedNote}</p> : null}

      {adopted && (adopted.fwPython || adopted.piperBin) ? (
        <div className="mb-3 rounded border border-emerald-400/20 bg-emerald-400/5 p-2 leading-relaxed">
          <p className="text-emerald-300">adopted:</p>
          <p className="text-slate-500">stt engine: {adopted.sttEngine ?? '—'}</p>
          {adopted.fwPython ? <p className="break-all text-slate-500">faster-whisper python: {adopted.fwPython}</p> : null}
          {adopted.piperBin ? <p className="break-all text-slate-500">piper: {adopted.piperBin}</p> : null}
          {adopted.extraVoicesDir ? <p className="break-all text-slate-500">voices dir: {adopted.extraVoicesDir}</p> : null}
        </div>
      ) : null}

      {fwList.length > 0 ? (
        <div className="mb-3">
          <h3 className="mb-1.5 text-slate-300">faster-whisper found ({fwList.length})</h3>
          {fwList.map((fw) => {
            const isAdopted = adopted?.fwPython === fw.python
            return (
              <div key={fw.python} className="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded border border-white/5 p-2">
                <div className="min-w-0">
                  <p className="break-all text-emerald-300">{fw.python}</p>
                  <p className="text-slate-500">v{fw.version ?? '?'} · {fw.via ?? 'python'}</p>
                </div>
                {isAdopted ? (
                  <span className="flex items-center gap-1 text-emerald-300"><Check className="h-3 w-3" aria-hidden="true" /> adopted</span>
                ) : (
                  <button
                    onClick={() => handleAdoptFw(fw)}
                    disabled={busy !== null}
                    className="flex items-center gap-1 border border-white/15 bg-white/5 px-2 py-1 text-emerald-300 hover:border-white/30 disabled:opacity-50"
                  >
                    <Mic className="h-3 w-3" aria-hidden="true" /> Adopt
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ) : null}

      {piperList.length > 0 ? (
        <div className="mb-3">
          <h3 className="mb-1.5 text-slate-300">piper binaries found ({piperList.length})</h3>
          {piperList.map((bin) => {
            const isAdopted = adopted?.piperBin === bin
            const voicesDir = discovered?.voiceDirs?.[0]?.dir
            return (
              <div key={bin} className="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded border border-white/5 p-2">
                <p className="min-w-0 break-all text-emerald-300">{bin}</p>
                {isAdopted ? (
                  <span className="flex items-center gap-1 text-emerald-300"><Check className="h-3 w-3" aria-hidden="true" /> adopted</span>
                ) : (
                  <button
                    onClick={() => handleAdoptPiper(bin, voicesDir)}
                    disabled={busy !== null}
                    className="flex items-center gap-1 border border-white/15 bg-white/5 px-2 py-1 text-emerald-300 hover:border-white/30 disabled:opacity-50"
                  >
                    <AudioLines className="h-3 w-3" aria-hidden="true" /> Adopt
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ) : null}

      <div className="mb-2">
        <button
          onClick={handleGetVoices}
          disabled={busy !== null}
          className="flex items-center gap-1 border border-white/15 bg-white/5 px-2 py-1 text-emerald-300 hover:border-white/30 disabled:opacity-50"
        >
          <Download className={'h-3 w-3 ' + (busy === 'voices' ? 'animate-pulse' : '')} aria-hidden="true" />
          Get Voices ({discovered?.voiceDirs?.reduce((n, d) => n + (d.voices ?? 0), 0) ?? voices.length} known)
        </button>
      </div>

      {voices.length > 0 ? (
        <div>
          <h3 className="mb-1.5 text-slate-300">voices ({voices.length}) — language / accent / name (quality)</h3>
          <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
            {voices.map((voice) => (
              <button
                key={voice.id}
                onClick={() => handleSelectVoice(voice)}
                disabled={busy !== null || selectedVoice === voice.id}
                className={
                  'rounded border px-1.5 py-0.5 text-[8px] ' +
                  (selectedVoice === voice.id
                    ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                    : 'border-white/15 bg-white/5 text-slate-400 hover:border-white/30')
                }
              >
                {voice.language ?? voice.id.split('-')[0]}/{voice.accent ?? '—'}/{voice.name ?? voice.id} ({voice.quality ?? '?'})
                {selectedVoice === voice.id ? ' ✓' : ''}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {nothingFound && busy === null ? (
        <p className="py-2 text-center leading-relaxed text-slate-500">
          no engines or voices found yet — click Discover (the bridge probes pythons, piper binaries and voice dirs), or
          install her own offline engines below.
        </p>
      ) : null}
    </div>
  )
}

export default VoiceEnginesPanel;
