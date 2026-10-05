'use client'

// Global keyboard shortcuts — self-proposed by M.I.S.T. (evolution proposal
// "Keyboard Shortcuts for Common Actions"), rewritten after review:
// the original draft hijacked arrow keys globally (broke page scrolling)
// and double-bound Ctrl+K against the navbar command palette. This version
// uses Alt+N keys that collide with nothing (Alt+V already = hold-to-talk).

import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { useMistStore } from '@/lib/store'
import { mistApi } from '@/lib/mist-api'

export function useKeyboardShortcuts() {
  const setView = useMistStore((s) => s.setView)
  const setThreads = useMistStore((s) => s.setThreads)
  const setActiveThread = useMistStore((s) => s.setActiveThread)

  const newThread = useCallback(async () => {
    try {
      const conv = await mistApi.conversations.create()
      const list = await mistApi.conversations.list()
      setThreads(list)
      setActiveThread(conv.id)
      setView('chat')
      toast.success('New thread started')
    } catch {
      toast.error('Could not start a new thread')
    }
  }, [setThreads, setActiveThread, setView])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt-based only — never touch Ctrl/Cmd (browser + palette territory).
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const target = e.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      switch (e.key.toLowerCase()) {
        case '1':
          e.preventDefault()
          setView('consciousness')
          break
        case '2':
          e.preventDefault()
          setView('chat')
          break
        case '3':
          e.preventDefault()
          setView('self')
          break
        case 'n':
          if (typing) return // don't steal Alt+N while typing accents
          e.preventDefault()
          void newThread()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setView, newThread])
}
