'use client'

import { useEffect, useRef } from 'react'

/**
 * A custom hook for setting up intervals that clean up automatically.
 * @param callback The function to call on each interval
 * @param delay The delay in milliseconds
 */
export function useInterval(callback: () => void, delay: number | null) {
  const savedCallback = useRef(callback)
  
  // Remember the latest callback
  useEffect(() => {
    savedCallback.current = callback
  }, [callback])
  
  // Set up the interval
  useEffect(() => {
    if (delay === null) return
    
    const id = setInterval(() => {
      savedCallback.current()
    }, delay)
    
    return () => clearInterval(id)
  }, [delay])
}