// M.I.S.T. client audio utilities — mic capture with live energy + WAV encoding.
// Recording flow: MediaRecorder(webm/opus) -> decodeAudioData -> 16-bit PCM WAV
// (the ASR backend accepts wav reliably; webm is not guaranteed).
'use client'

/** Encode an AudioBuffer to a 16-bit PCM mono WAV Blob. */
export function encodeWav(audioBuffer: AudioBuffer): Blob {
  const targetRate = 16000
  const channels = 1
  // Downmix to mono
  const src = audioBuffer.getChannelData(0)
  if (audioBuffer.numberOfChannels > 1) {
    const second = audioBuffer.getChannelData(1)
    for (let i = 0; i < src.length; i++) src[i] = (src[i] + second[i]) / 2
  }
  // Linear resample to 16k
  const ratio = audioBuffer.sampleRate / targetRate
  const outLength = Math.max(1, Math.floor(src.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, src.length - 1)
    const frac = pos - i0
    out[i] = src[i0] * (1 - frac) + src[i1] * frac
  }

  const bytesPerSample = 2
  const dataSize = out.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, targetRate, true)
  view.setUint32(28, targetRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < out.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, out[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

export interface MicRecorder {
  start: () => Promise<void>
  /** Stop and resolve with a WAV blob (null when cancelled or empty). */
  stop: () => Promise<Blob | null>
  /** Discard the current recording. */
  cancel: () => void
  /** Current RMS energy 0..1 (updated during recording). */
  getEnergy: () => number
  isRecording: () => boolean
}

export function createMicRecorder(): MicRecorder {
  let mediaRecorder: MediaRecorder | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let stream: MediaStream | null = null
  let chunks: BlobPart[] = []
  let energy = 0
  let recording = false
  let cancelled = false

  const teardown = () => {
    recording = false
    try {
      stream?.getTracks().forEach((t) => t.stop())
    } catch {
      /* ignore */
    }
    try {
      audioContext?.close()
    } catch {
      /* ignore */
    }
    stream = null
    audioContext = null
    analyser = null
    mediaRecorder = null
  }

  return {
    start: async () => {
      cancelled = false
      chunks = []
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioContext = new Ctx()
      const source = audioContext.createMediaStreamSource(stream)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''
      mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      mediaRecorder.start(200)
      recording = true
    },

    stop: () =>
      new Promise<Blob | null>((resolve) => {
        if (!mediaRecorder || !recording) {
          teardown()
          resolve(null)
          return
        }
        const mr = mediaRecorder
        const ctx = audioContext
        mr.onstop = async () => {
          try {
            if (cancelled || chunks.length === 0 || !ctx) {
              teardown()
              resolve(null)
              return
            }
            const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' })
            const arrayBuffer = await blob.arrayBuffer()
            const decoded = await ctx.decodeAudioData(arrayBuffer)
            const wav = encodeWav(decoded)
            teardown()
            resolve(wav.size > 44 ? wav : null)
          } catch {
            teardown()
            resolve(null)
          }
        }
        try {
          mr.stop()
        } catch {
          teardown()
          resolve(null)
        }
      }),

    cancel: () => {
      cancelled = true
      try {
        mediaRecorder?.stop()
      } catch {
        /* ignore */
      }
      teardown()
    },

    getEnergy: () => {
      if (!analyser) return 0
      const arr = new Uint8Array(analyser.fftSize)
      analyser.getByteTimeDomainData(arr)
      let sum = 0
      for (let i = 0; i < arr.length; i++) {
        const v = (arr[i] - 128) / 128
        sum += v * v
      }
      energy = Math.sqrt(sum / arr.length)
      return Math.min(1, energy * 3.2)
    },

    isRecording: () => recording,
  }
}
