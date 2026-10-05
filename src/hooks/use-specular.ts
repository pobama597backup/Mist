// Specular glass hover — tracks the pointer and exposes --mx/--my to the
// .mist-specular CSS class (a soft radial highlight that follows the cursor).
'use client'

import { useCallback, useRef, type PointerEvent, type RefObject } from 'react'

export function useSpecular<T extends HTMLElement>(): {
  ref: RefObject<T | null>
  onPointerMove: (e: PointerEvent<T>) => void
} {
  const ref = useRef<T>(null)
  const onPointerMove = useCallback((e: PointerEvent<T>) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${e.clientX - r.left}px`)
    el.style.setProperty('--my', `${e.clientY - r.top}px`)
  }, [])
  return { ref, onPointerMove }
}
