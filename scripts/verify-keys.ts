import fs from 'fs'

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  })
)

async function test(name: string, url: string, key: string, model: string) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 10 }),
      signal: AbortSignal.timeout(30000),
    })
    const body = await res.text()
    let out = body.slice(0, 300)
    try { const j = JSON.parse(body); out = j.choices?.[0]?.message?.content ?? j.error?.message ?? out } catch {}
    console.log(`${name}: HTTP ${res.status} → ${out}`)
  } catch (e: any) { console.log(`${name}: FAILED → ${e.message}`) }
}

console.log('OPENROUTER_MODEL =', env.OPENROUTER_MODEL)
console.log('NVIDIA_MODEL     =', env.NVIDIA_MODEL)
console.log('---')
await test('OpenRouter', 'https://openrouter.ai/api/v1/chat/completions', env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL!)
await test('NVIDIA', 'https://integrate.api.nvidia.com/v1/chat/completions', env.NVIDIA_API_KEY, env.NVIDIA_MODEL!)
