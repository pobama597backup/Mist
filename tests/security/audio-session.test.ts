// Phase 3-b · AUDIO-SESSION MACHINE tests (pure — no DOM, no React render).
//
// Pins the mandate's single audio-session state machine:
//   TABLE   every valid edge is accepted + lands; every invalid edge is
//           rejected, leaves the phase untouched and records lastRejected;
//           same-state publishes are accepted no-ops
//   CYCLE   the mandate's canonical loop walks clean:
//           idle→listening→thinking→speaking→barge-in→listening→idle
//   CANCEL  any state → idle (cancel/stop)
//   LEAK    the 20× mount/unmount invariant harness: subscribe/unsubscribe
//           pairs over the zustand store return subscriber counts to
//           baseline — stale unsubscribers never fire again (the
//           strict-mode double-invocation concern, simulated without React)
//
// Run: bun test tests/security/audio-session.test.ts
import { test, expect, describe, beforeEach } from 'bun:test'
import {
  useAudioSession,
  resetAudioSession,
  audioSessionPhase,
  type AudioSessionState,
} from '../../src/lib/audio-session'

const STATES: AudioSessionState[] = ['idle', 'listening', 'thinking', 'speaking', 'barge-in']

/** The exact table: the mandate's cycle + the documented real-pipeline
 *  additions (see the module header — each addition is a load-bearing path:
 *  chat send, chat/app TTS, reply-end re-arm, empty-capture re-arm,
 *  new-turn-while-tail-plays). */
const VALID: Record<AudioSessionState, AudioSessionState[]> = {
  idle: ['listening', 'thinking', 'speaking'],
  listening: ['thinking', 'idle'],
  thinking: ['speaking', 'listening', 'idle'],
  speaking: ['barge-in', 'listening', 'thinking', 'idle'],
  'barge-in': ['listening', 'idle'],
}

beforeEach(() => {
  resetAudioSession()
})

describe('audio-session transition table', () => {
  for (const from of STATES) {
    for (const to of STATES) {
      const valid = VALID[from].includes(to) || from === to // same-state = accepted no-op
      test(`${from} → ${to} is ${valid ? 'accepted' : 'rejected'}`, () => {
        // walk to the `from` state through idle (reset) + the known-good path
        useAudioSession.setState({ phase: from, lastRejected: null })
        const ok = useAudioSession.getState().transition(to)
        expect(ok).toBe(valid)
        if (valid) {
          expect(useAudioSession.getState().phase).toBe(to)
          expect(useAudioSession.getState().lastRejected).toBeNull()
        } else {
          expect(useAudioSession.getState().phase).toBe(from)
          expect(useAudioSession.getState().lastRejected).toEqual({ from, to })
        }
      })
    }
  }

  test('same-state publish is an accepted no-op', () => {
    useAudioSession.setState({ phase: 'listening' })
    expect(useAudioSession.getState().transition('listening')).toBe(true)
    expect(useAudioSession.getState().phase).toBe('listening')
    expect(useAudioSession.getState().lastRejected).toBeNull()
  })

  test('any state → idle (cancel from everywhere)', () => {
    for (const s of STATES) {
      useAudioSession.setState({ phase: s })
      expect(useAudioSession.getState().transition('idle')).toBe(true)
      expect(audioSessionPhase()).toBe('idle')
    }
  })

  test("the mandate's canonical loop walks clean", () => {
    const t = useAudioSession.getState().transition
    expect(t('listening')).toBe(true) // mic armed
    expect(t('thinking')).toBe(true) // transcript final
    expect(t('speaking')).toBe(true) // TTS starts
    expect(t('barge-in')).toBe(true) // speech detected while speaking (w4)
    expect(t('listening')).toBe(true) // re-arm
    expect(t('thinking')).toBe(true)
    expect(t('speaking')).toBe(true)
    expect(t('idle')).toBe(true) // natural end / cancel
  })

  test('a teleport is rejected and recorded, not applied', () => {
    useAudioSession.setState({ phase: 'idle' })
    expect(useAudioSession.getState().transition('barge-in')).toBe(false) // idle never barges
    expect(useAudioSession.getState().transition('listening')).toBe(true)
    expect(useAudioSession.getState().transition('barge-in')).toBe(false) // mic first, speech after
    expect(audioSessionPhase()).toBe('listening')
  })
})

describe('listener-count invariant — 20 mount/unmount cycles', () => {
  test('subscribe/unsubscribe pairs return to baseline; stale listeners never fire', () => {
    // a probe listener that stays subscribed across all cycles
    let probeFires = 0
    const unsubProbe = useAudioSession.subscribe(() => {
      probeFires++
    })

    // 20 generations of a "component": subscribe, hear one transition,
    // unsubscribe (the exact subscribe/cleanup pair a React boundary runs
    // under strict mode — twice per mount, so 20 cycles = 40 pairs)
    for (let cycle = 0; cycle < 20; cycle++) {
      let mine = 0
      const unsubs = [
        useAudioSession.subscribe(() => {
          mine++
        }),
        useAudioSession.subscribe(() => {
          mine++
        }), // strict mode double-invocation simulation
      ]
      useAudioSession.getState().transition('listening') // fires 3 (probe + 2 mine)
      expect(mine).toBe(2)
      unsubs.forEach((u) => u())
      useAudioSession.getState().transition('idle') // fires ONLY the probe
      expect(mine).toBe(2) // stale listeners stayed silent — no leak
    }

    expect(probeFires).toBe(40) // 2 transitions × 20 cycles, nothing extra
    unsubProbe()
    // after the LAST unsubscribe: no listener remains — a transition is
    // observed by the store state alone and cannot resurrect anyone
    useAudioSession.getState().transition('listening')
    expect(useAudioSession.getState().phase).toBe('listening')
    expect(probeFires).toBe(40)
  })

  test('state is consistent for a late subscribe-then-transition sequence', () => {
    const seen: AudioSessionState[] = []
    const unsub = useAudioSession.subscribe(() => {
      seen.push(useAudioSession.getState().phase)
    })
    useAudioSession.getState().transition('listening')
    useAudioSession.getState().transition('thinking')
    useAudioSession.getState().transition('idle')
    unsub()
    expect(seen).toEqual(['listening', 'thinking', 'idle'])
  })
})
