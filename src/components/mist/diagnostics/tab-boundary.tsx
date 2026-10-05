'use client'

// Lightweight class ErrorBoundary for the diagnostics drawer tabs. When a
// panel throws during render, React would otherwise unmount the whole tree —
// the "blank diagnosis tab" symptom. Instead the boundary renders a glass
// "snag" card with the error message and a Retry button that remounts the
// child (keyed by a retry counter), so one bad panel never takes the drawer
// down with it.
//
// Task 12-d1 · drawer hardening

import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

interface TabBoundaryProps {
  /** panel id — used in the console trace (e.g. "system") */
  label: string
  children: ReactNode
}

interface TabBoundaryState {
  error: Error | null
  /** bumped by Retry — the keyed Fragment remounts the child */
  retry: number
}

export class TabBoundary extends Component<TabBoundaryProps, TabBoundaryState> {
  state: TabBoundaryState = { error: null, retry: 0 }

  static getDerivedStateFromError(error: Error): Partial<TabBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // keep a trace in the console for diagnosis without blanking the drawer
    console.error(`[mist:diagnostics] "${this.props.label}" panel failed`, error, info.componentStack)
  }

  private onRetry = () => {
    this.setState((s) => ({ error: null, retry: s.retry + 1 }))
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="mist-glass rounded-xl p-4">
          <div className="flex items-center gap-2">
            <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-amber-300" />
            <p className="text-sm text-slate-200">This panel hit a snag</p>
          </div>
          <p className="mt-2 truncate rounded-lg bg-slate-950/60 px-2.5 py-1.5 font-mono text-[10px] text-rose-300/90">
            {this.state.error.message || String(this.state.error)}
          </p>
          <button
            type="button"
            onClick={this.onRetry}
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 font-mono text-[10px] uppercase tracking-widest text-slate-300 transition-colors hover:border-purple-400/40 hover:text-purple-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
          >
            <RotateCw aria-hidden className="h-3 w-3" />
            Retry
          </button>
        </div>
      )
    }
    // key bump → the child remounts fresh on Retry
    return <Fragment key={this.state.retry}>{this.props.children}</Fragment>
  }
}
