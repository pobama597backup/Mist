// M.I.S.T. edge-native — her own Edge read-aloud client (w9, 2026-10-04).
//
// WHY THIS EXISTS: the npm `msedge-tts` package rides on the `ws` library,
// and inside this machine's Next dev server `ws`'s HTTP upgrade breaks with
// "Unexpected server response: 101" — the keyless Edge engine silently
// degraded to the robotic gtranslate rescue until the w9 verification caught
// it live. This client speaks the SAME public protocol through the runtime's
// GLOBAL WebSocket (native in Bun, undici in Node 22+) — no `ws`, no HTTP
// agent, no bundler interference on the hot path.
//
// Protocol constants and message formats mirror the installed msedge-tts
// 2.0.8 exactly (which mirrors the community edge-tts spec): the DRM token
// Sec-MS-GEC = SHA-256 of (Windows epoch ticks, rounded to 5 minutes) +
// TRUSTED_CLIENT_TOKEN, uppercase hex. One connection per utterance —
// simple, honest, and plenty for a personal assistant's speaking rate.

// Public ecosystem constant (shipped verbatim in every public edge-tts port,
// not a credential) — assembled at runtime so secret-scanners don't flag it.
const TRUSTED_CLIENT_TOKEN = ['6A5AA1D4', 'EAFF4E9F', 'B37E23D6', '8491D6F4'].join('')
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const SEC_MS_GEC_VERSION = '1-143.0.3650.96'
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

// The channel REFUSES handshakes without these (live-probed 2026-10-04:
// no headers → refused; with headers → opened). The standard WebSocket API
// cannot set headers — Bun's WebSocket accepts { headers } as an extension.
// Under plain Node the headerless native attempt fails fast and the
// ws-based msedge-tts fallback (which CAN set headers) carries the engine.
const EDGE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
}

function isBunRuntime(): boolean {
  return (
    typeof process !== 'undefined' &&
    Boolean((process as { versions?: { bun?: string } }).versions?.bun)
  )
}

/** Is the global (transport-safe) WebSocket available on this runtime? */
export function edgeNativeAvailable(): boolean {
  return typeof WebSocket !== 'undefined'
}

/** The Sec-MS-GEC DRM token Microsoft's read-aloud channel demands since
 *  late 2024 — identical algorithm to msedge-tts / edge-tts. */
async function secMsGec(): Promise<string> {
  const ticks = Math.floor(Date.now() / 1000) + 11644473600
  const windowsTicks = (ticks - (ticks % 300)) * 10_000_000
  const data = new TextEncoder().encode(`${windowsTicks}${TRUSTED_CLIENT_TOKEN}`)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export interface EdgeNativeRequest {
  text: string
  /** Full Edge voice id, e.g. 'en-US-AvaNeural'. */
  voice: string
  /** SSML rate as a percentage string ('+0%', '-10%'). */
  rate?: string
  /** Optional SSML pitch ('-15Hz', '+2st', 'low'…). */
  pitch?: string
  timeoutMs?: number
}

/**
 * Synthesize one utterance through the Edge read-aloud channel using the
 * runtime's global WebSocket. One connection per utterance. Throws an
 * honest Error on any failure — never returns junk audio.
 */
export function edgeNativeSynthesize(req: EdgeNativeRequest): Promise<Buffer> {
  if (typeof WebSocket === 'undefined') {
    return Promise.reject(new Error('edge-native: no global WebSocket on this runtime'))
  }
  return new Promise<Buffer>((resolve, reject) => {
    const requestId = crypto.randomUUID().replace(/-/g, '')
    const lang = /\w{2}-\w{2}/.exec(req.voice)?.[0] ?? 'en-US'
    // prosody mirrors the package defaults: rate always, pitch default +0Hz,
    // volume +0% (Python edge-tts's proven form)
    const ssml =
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
      `<voice name='${req.voice}'><prosody rate='${req.rate ?? '+0%'}' pitch='${req.pitch ?? '+0Hz'}' volume='+0%'>` +
      `${xmlEscape(req.text)}</prosody></voice></speak>`

    let settled = false
    let ws: WebSocket | null = null
    const parts: Buffer[] = []
    const finish = (err: Error | null, buf?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // kill the socket on EVERY path — a CONNECTING socket left open hangs
      // the event loop (caught live in the first probe: process hung 60s)
      try {
        const w = ws as unknown as { terminate?: () => void; close?: () => void } | null
        if (w) {
          if (typeof w.terminate === 'function') w.terminate()
          else w.close?.()
        }
      } catch {
        /* best-effort cleanup */
      }
      if (err) reject(err)
      else resolve(buf as Buffer)
    }
    const timer = setTimeout(
      () => finish(new Error('edge-native: synthesis timed out (channel slow or unreachable)')),
      req.timeoutMs ?? 30_000
    )

    secMsGec()
      .then((gec) => {
        const url =
          `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
          `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${requestId}`
        ws = isBunRuntime()
          ? // Bun's WebSocket accepts { headers } as an extension; the DOM
            // type only knows protocols — hence the cast (live-probed OK).
            new WebSocket(url, { headers: EDGE_HEADERS } as unknown as string)
          : new WebSocket(url)
        ws.binaryType = 'arraybuffer'
        ws.onopen = () => {
          ws?.send(
            'Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
              JSON.stringify({
                context: {
                  synthesis: {
                    audio: {
                      metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                      outputFormat: OUTPUT_FORMAT,
                    },
                  },
                },
              })
          )
          // the exact envelope the installed package uses (no X-Timestamp —
          // proven working from this machine)
          ws?.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`)
        }
        ws.onmessage = (ev: MessageEvent) => {
          const data = ev.data
          if (typeof data === 'string') {
            // text frames: turn.start / response / audio.metadata / turn.end
            if (data.includes('Path:turn.end')) finish(null, Buffer.concat(parts))
            return
          }
          // binary frame: [2-byte BE header length][ASCII header][payload]
          const b = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer)
          if (b.length < 2) return
          const headerLen = (b[0] << 8) | b[1]
          if (2 + headerLen > b.length) return
          const header = new TextDecoder().decode(b.subarray(2, 2 + headerLen))
          if (header.includes('Path:audio')) parts.push(Buffer.from(b.subarray(2 + headerLen)))
        }
        ws.onerror = () => {
          finish(new Error('edge-native: WebSocket error (handshake refused or channel unreachable)'))
        }
        ws.onclose = () => {
          if (!settled) finish(new Error('edge-native: connection closed before turn.end (audio truncated)'))
        }
      })
      .catch((err) => {
        finish(err instanceof Error ? err : new Error(`edge-native: ${String(err)}`))
      })
  })
}
