'use client'

// M.I.S.T. browser window — the in-app browser MIST opens for you.
// Tabs: video (YouTube embed w/ key-moment seek) · article (reader mode) ·
// cockpit (MIST's live controlled browser — click the screenshot to act).
// Task 9-c · frontend v2

import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  FileText,
  Globe,
  List,
  Loader2,
  Minus,
  MousePointerClick,
  Play,
  Plus,
  RotateCw,
  Send,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useMistStore, type BrowserTab } from '@/lib/store'
import { mistApi } from '@/lib/mist-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const VIEWPORT_W = 1280
const VIEWPORT_H = 800

function youtubeId(url: string): string | null {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v')
      const m = u.pathname.match(/\/(embed|shorts|live)\/([A-Za-z0-9_-]+)/)
      if (m) return m[2]
    }
  } catch {
    /* not a URL */
  }
  return null
}

function fmtSeek(seconds?: number): string {
  if (!seconds || seconds <= 0) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ---------------------------------------------------------------- video tab

function VideoTab({ tab }: { tab: BrowserTab }) {
  const [seekOverride, setSeekOverride] = useState<number | undefined>(tab.seekTo)
  const id = youtubeId(tab.url)
  if (!id) {
    return <ArticleTab tab={tab} />
  }
  const start = seekOverride && seekOverride > 0 ? seekOverride : undefined
  const embed = `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1${
    start ? `&start=${start}&autoplay=1` : ''
  }`
  return (
    <div className="flex h-full min-h-0 flex-col">
      {tab.note ? (
        <div className="border-b border-purple-300/15 bg-purple-300/5 px-3 py-2 text-[11px] leading-snug text-purple-200/90">
          M.I.S.T. queued this for you — {tab.note}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 p-3">
        <div className="relative h-full w-full overflow-hidden rounded-xl border border-white/10 bg-black">
          <iframe
            key={`${id}-${start ?? 0}`}
            src={embed}
            title={tab.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            className="absolute inset-0 h-full w-full"
          />
        </div>
      </div>
      {tab.seekTo && tab.seekTo > 0 ? (
        <div className="border-t border-white/10 px-3 py-2">
          <button
            type="button"
            onClick={() => setSeekOverride(tab.seekTo)}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-300/30 bg-rose-300/10 px-2.5 py-1 font-mono text-[10px] text-rose-200 transition-colors hover:bg-rose-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
          >
            <Play aria-hidden className="h-3 w-3" />
            jump to the key moment · {fmtSeek(tab.seekTo)}
          </button>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------- article tab

interface ReaderState {
  loading: boolean
  title: string
  text: string
  error: string | null
}

function ArticleTab({ tab }: { tab: BrowserTab }) {
  const [state, setState] = useState<ReaderState>({ loading: true, title: tab.title, text: '', error: null })

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ loading: true, title: tab.title, text: '', error: null })
        return mistApi.browser.command<{ ok: boolean; title?: string; text?: string; error?: string }>('read', {
          url: tab.url,
        })
      })
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.text) {
          setState({ loading: false, title: res.title ?? tab.title, text: res.text, error: null })
        } else {
          setState({ loading: false, title: tab.title, text: '', error: res.error ?? 'could not read this page' })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ loading: false, title: tab.title, text: '', error: 'reader service unreachable' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [tab.url, tab.title])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {tab.note ? (
        <div className="border-b border-teal-300/15 bg-teal-300/5 px-3 py-2 text-[11px] leading-snug text-teal-200/90">
          M.I.S.T. thinks this is worth your time — {tab.note}
        </div>
      ) : null}
      {state.loading ? (
        <div className="space-y-3 p-5" aria-hidden>
          <Skeleton className="h-6 w-2/3 rounded-md bg-white/5" />
          <Skeleton className="h-3.5 w-full rounded bg-white/5" />
          <Skeleton className="h-3.5 w-11/12 rounded bg-white/5" />
          <Skeleton className="h-3.5 w-4/5 rounded bg-white/5" />
          <Skeleton className="h-3.5 w-full rounded bg-white/5" />
        </div>
      ) : state.error ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-slate-400">{state.error}</p>
          <a
            href={tab.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 transition-colors hover:bg-white/10"
          >
            <ExternalLink aria-hidden className="h-3.5 w-3.5" />
            open the original page
          </a>
        </div>
      ) : (
        <article className="mist-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-7">
          <h3 className="text-base font-semibold text-slate-100">{state.title}</h3>
          <p className="mt-0.5 font-mono text-[10px] text-slate-500">{tab.url}</p>
          <div className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-300">
            {state.text}
          </div>
        </article>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- cockpit tab

interface CockpitShot {
  image: string
  url: string
  title: string
}

interface CockpitElement {
  ref: number
  tag: string
  text: string
  x: number
  y: number
}

function CockpitTab() {
  const [shot, setShot] = useState<CockpitShot | null>(null)
  const [busy, setBusy] = useState(false)
  const [pilotDown, setPilotDown] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [typeInput, setTypeInput] = useState('')
  const [elements, setElements] = useState<CockpitElement[] | null>(null)
  const imgWrapRef = useRef<HTMLDivElement>(null)

  const refreshShot = useCallback(async () => {
    setBusy(true)
    try {
      const r = await mistApi.browser.command<{
        ok: boolean
        image?: string
        url?: string
        title?: string
        error?: string
      }>('screenshot')
      if (r.ok && r.image) {
        setShot({ image: r.image, url: r.url ?? '', title: r.title ?? '' })
        setPilotDown(false)
      } else {
        setPilotDown(true)
      }
    } catch {
      setPilotDown(true)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refreshShot()
  }, [refreshShot])

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await fn()
      } catch {
        /* handled by refresh */
      }
      await refreshShot()
    },
    [refreshShot]
  )

  const onScreenshotClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = imgWrapRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return
    const x = Math.round(((e.clientX - rect.left) / rect.width) * VIEWPORT_W)
    const y = Math.round(((e.clientY - rect.top) / rect.height) * VIEWPORT_H)
    void act(() => mistApi.browser.command('click', { x, y }))
  }

  const onNavigate = (e: FormEvent) => {
    e.preventDefault()
    const url = urlInput.trim()
    if (!url) return
    let target = url
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`
    void act(() => mistApi.browser.command('navigate', { url: target }))
  }

  const onTypeSubmit = (e: FormEvent) => {
    e.preventDefault()
    const text = typeInput.trim()
    if (!text) return
    setTypeInput('')
    void act(async () => {
      // smart default target: prefer a real search/text input over toggles
      try {
        const els = await mistApi.browser.command<{
          ok: boolean
          elements?: Array<{ ref: number; tag: string; role: string; text: string }>
        }>('elements')
        const list = els.ok && Array.isArray(els.elements) ? els.elements : []
        const isTextInput = (el: { tag: string; role: string; text: string }) =>
          el.tag === 'input' || el.tag === 'textarea'
        const target =
          list.find(
            (el) =>
              isTextInput(el) &&
              (el.role === 'textbox' || el.role === 'searchbox' || /search|query/i.test(el.text))
          ) ?? list.find((el) => isTextInput(el))
        if (target) {
          await mistApi.browser.command('type', { text, ref: target.ref, submit: true })
          return
        }
      } catch {
        /* fall through to plain typing */
      }
      await mistApi.browser.command('type', { text, submit: true })
    })
  }

  const toggleElements = async () => {
    if (elements) {
      setElements(null)
      return
    }
    setBusy(true)
    try {
      const r = await mistApi.browser.command<{ ok: boolean; elements?: CockpitElement[] }>('elements')
      setElements(r.ok && r.elements ? r.elements.slice(0, 40) : [])
    } catch {
      setElements([])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* toolbar */}
      <form onSubmit={onNavigate} className="flex items-center gap-1.5 border-b border-white/10 p-2">
        <Globe aria-hidden className="ml-1 h-3.5 w-3.5 shrink-0 text-slate-500" />
        <Input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder={shot?.url || 'enter a url and press enter'}
          aria-label="Navigate to URL"
          className="h-8 border-white/10 bg-white/5 font-mono text-[11px] text-slate-200 focus-visible:ring-purple-400/60"
        />
        <Button
          type="submit"
          size="sm"
          className="h-8 rounded-lg border border-purple-400/40 bg-purple-400/20 px-3 font-mono text-[10px] text-purple-100 hover:bg-purple-400/30"
        >
          go
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh screenshot"
          onClick={() => void refreshShot()}
          className="h-8 w-8 rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <RotateCw aria-hidden className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        </Button>
      </form>

      {/* viewport */}
      <div className="relative min-h-0 flex-1 overflow-auto bg-slate-950/60 p-2">
        {pilotDown ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-slate-400">
              Browser Pilot is offline.
            </p>
            <p className="font-mono text-[10px] text-slate-500">
              start it: mini-services/browser-pilot → bun run dev
            </p>
          </div>
        ) : shot ? (
          <div
            ref={imgWrapRef}
            onClick={onScreenshotClick}
            className="group relative mx-auto w-fit max-w-full cursor-crosshair"
            role="button"
            tabIndex={0}
            aria-label="MIST's live browser — click to interact"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void refreshShot()
            }}
          >
            <img
              src={`data:image/jpeg;base64,${shot.image}`}
              alt={`MIST's live browser view: ${shot.title || shot.url}`}
              className="block max-w-full rounded-lg border border-white/10"
              draggable={false}
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center rounded-t-lg bg-gradient-to-b from-black/70 to-transparent px-2 py-1.5 font-mono text-[10px] text-slate-300 opacity-0 transition-opacity group-hover:opacity-100">
              <MousePointerClick aria-hidden className="mr-1 h-3 w-3" />
              click anywhere on the page — MIST clicks it for real
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center" aria-hidden>
            <Loader2 className="h-5 w-5 animate-spin text-purple-300" />
          </div>
        )}

        {/* elements panel */}
        {elements ? (
          <div className="mist-glass absolute bottom-2 right-2 z-10 w-64 rounded-xl p-2">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                clickable elements
              </span>
              <button
                type="button"
                aria-label="Close elements list"
                onClick={() => setElements(null)}
                className="rounded p-0.5 text-slate-500 hover:text-slate-300"
              >
                <X aria-hidden className="h-3 w-3" />
              </button>
            </div>
            <div className="mist-scroll max-h-48 space-y-0.5 overflow-y-auto">
              {elements.length === 0 ? (
                <p className="px-1 py-2 font-mono text-[10px] text-slate-500">no elements found</p>
              ) : (
                elements.map((el) => (
                  <button
                    key={el.ref}
                    type="button"
                    onClick={() => {
                      setElements(null)
                      void act(() => mistApi.browser.command('click', { ref: el.ref }))
                    }}
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left font-mono text-[10px] text-slate-300 transition-colors hover:bg-purple-400/15 hover:text-purple-100"
                  >
                    <span className="shrink-0 rounded border border-white/10 bg-white/5 px-1 text-slate-500">
                      {el.ref}
                    </span>
                    <span className="truncate">
                      {el.tag} · {el.text || '(no text)'}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>

      {/* action bar */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-white/10 p-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Scroll up"
          onClick={() => void act(() => mistApi.browser.command('scroll', { direction: 'up' }))}
          className="h-8 w-8 rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <ArrowUp aria-hidden className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Scroll down"
          onClick={() => void act(() => mistApi.browser.command('scroll', { direction: 'down' }))}
          className="h-8 w-8 rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <ArrowDown aria-hidden className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="List clickable elements"
          onClick={() => void toggleElements()}
          className="h-8 gap-1.5 rounded-lg px-2.5 font-mono text-[10px] text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <List aria-hidden className="h-3.5 w-3.5" />
          elements
        </Button>
        <form onSubmit={onTypeSubmit} className="ml-auto flex items-center gap-1.5">
          <Input
            value={typeInput}
            onChange={(e) => setTypeInput(e.target.value)}
            placeholder="type into the page…"
            aria-label="Type text into the browser page"
            className="h-8 w-40 border-white/10 bg-white/5 font-mono text-[11px] text-slate-200 focus-visible:ring-purple-400/60 sm:w-52"
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Type and press Enter"
            className="h-8 w-8 rounded-lg border border-purple-400/40 bg-purple-400/20 text-purple-100 hover:bg-purple-400/30"
          >
            <Send aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the window

export function BrowserWindow() {
  const tabs = useMistStore((s) => s.browser.tabs)
  const activeTabId = useMistStore((s) => s.browser.activeTabId)
  const open = useMistStore((s) => s.browser.open)
  const activateBrowserTab = useMistStore((s) => s.activateBrowserTab)
  const closeBrowserTab = useMistStore((s) => s.closeBrowserTab)
  const setBrowserOpen = useMistStore((s) => s.setBrowserOpen)

  // The user's explicit M.I.S.T. preference wins over the OS signal.
  const reduced = useMistStore((s) => s.reducedMotion)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[tabs.length - 1] ?? null
  const visible = open && tabs.length > 0 && activeTab !== null

  // Escape minimizes the window (tabs stay alive — like a real browser)
  useEffect(() => {
    if (!visible) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setBrowserOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, setBrowserOpen])

  const askMist = (tab: BrowserTab) => {
    if (tab.kind === 'cockpit') {
      window.dispatchEvent(
        new CustomEvent('mist:compose', { detail: 'What do you see in your browser right now? Analyze the page.' })
      )
    } else {
      window.dispatchEvent(
        new CustomEvent('mist:compose', { detail: `Tell me about "${tab.title}" (${tab.url})` })
      )
    }
    setBrowserOpen(false)
  }

  return (
    <AnimatePresence>
      {visible && activeTab ? (
        <motion.div
          key="mist-browser-window"
          role="dialog"
          aria-label="M.I.S.T. browser window"
          initial={reduced ? false : { opacity: 0, scale: 0.94, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 16 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          className="mist-glass fixed bottom-16 right-3 z-40 flex h-[min(600px,68vh)] w-[min(880px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/60 sm:bottom-20 sm:right-5"
        >
          {/* tab strip */}
          <div className="flex items-center gap-1 border-b border-white/10 bg-black/20 px-2 pt-2">
            <div className="mist-scroll flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pb-0.5">
              {tabs.map((t) => {
                const isActive = t.id === activeTab.id
                return (
                  <div
                    key={t.id}
                    className={cn(
                      'group flex max-w-44 shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 px-2.5 py-1.5 transition-colors',
                      isActive
                        ? 'border-white/15 bg-white/10 text-slate-100'
                        : 'border-transparent text-slate-500 hover:bg-white/5 hover:text-slate-300'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => activateBrowserTab(t.id)}
                      className="flex min-w-0 items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                      aria-current={isActive ? 'true' : undefined}
                    >
                      {t.kind === 'video' ? (
                        <Play aria-hidden className="h-3 w-3 shrink-0 text-rose-300" />
                      ) : t.kind === 'cockpit' ? (
                        <MousePointerClick aria-hidden className="h-3 w-3 shrink-0 text-purple-300" />
                      ) : (
                        <FileText aria-hidden className="h-3 w-3 shrink-0 text-teal-300" />
                      )}
                      <span className="truncate text-[11px]">{t.title}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Close tab ${t.title}`}
                      onClick={() => closeBrowserTab(t.id)}
                      className="rounded p-0.5 text-slate-500 opacity-0 transition-opacity hover:bg-white/10 hover:text-slate-200 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60 group-hover:opacity-100"
                    >
                      <X aria-hidden className="h-3 w-3" />
                    </button>
                  </div>
                )
              })}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Open a Browser Cockpit tab"
              onClick={() =>
                useMistStore.getState().openBrowserTab({
                  url: 'about:blank',
                  title: 'Browser Cockpit',
                  kind: 'cockpit',
                })
              }
              className="mb-1 h-7 w-7 rounded-lg text-slate-400 hover:bg-white/5 hover:text-purple-200"
            >
              <Plus aria-hidden className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Minimize browser (tabs stay open)"
              onClick={() => setBrowserOpen(false)}
              className="mb-1 h-7 w-7 rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-200"
            >
              <Minus aria-hidden className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* body */}
          <div className="min-h-0 flex-1">
            {activeTab.kind === 'video' ? (
              <VideoTab key={activeTab.id} tab={activeTab} />
            ) : activeTab.kind === 'cockpit' ? (
              <CockpitTab key={activeTab.id} />
            ) : (
              <ArticleTab key={activeTab.id} tab={activeTab} />
            )}
          </div>

          {/* footer */}
          <div className="flex items-center gap-2 border-t border-white/10 bg-black/20 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-500">
              {activeTab.kind === 'cockpit' ? 'cockpit · MIST\u2019s live browser' : activeTab.url}
            </span>
            <button
              type="button"
              onClick={() => askMist(activeTab)}
              className="shrink-0 rounded-md border border-purple-300/30 bg-purple-300/10 px-2 py-1 font-mono text-[10px] text-purple-200 transition-colors hover:bg-purple-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
            >
              ask M.I.S.T. about this
            </button>
            {activeTab.kind !== 'cockpit' ? (
              <a
                href={activeTab.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-300 transition-colors hover:bg-white/10"
              >
                <ExternalLink aria-hidden className="h-3 w-3" />
                open ↗
              </a>
            ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
