// scripts/decrypt-export.ts — open a Phase 1 sealed export keys blob.
//
// The bridge/export route's includeKeys mode packs the source machine's
// .env secret values + db/provider-keys.json as `keys/mist-keys.enc`
// (AES-256-GCM, scrypt KDF, passphrase-supplied). This is the reader:
//
//   bun scripts/decrypt-export.ts keys/mist-keys.enc
//
// It prints the sealed JSON to stdout (redirect or pipe it somewhere safe —
// never paste it into a chat). Blob format:
//   "MISTENC1" || salt(16) || iv(12) || ciphertext || tag(16)

import { createDecipheriv, scryptSync } from 'node:crypto'
import fs from 'node:fs'

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('usage: bun scripts/decrypt-export.ts <keys/mist-keys.enc>')
  process.exit(1)
}

function askPassphrase(): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write('passphrase: ')
    let buf = ''
    const finish = () => {
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false)
      } catch {
        /* pipe */
      }
      process.stdin.removeListener('data', onData)
      process.stdout.write('\n')
      resolve(buf)
    }
    const onData = (ch: Buffer) => {
      const s = ch.toString('utf-8')
      if (s === '\u0003') process.exit(130) // Ctrl+C
      if (s.endsWith('\n') || s.endsWith('\r')) {
        buf += s.replace(/[\r\n]+$/, '')
        finish()
        return
      }
      buf += s
    }
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(true)
    } catch {
      /* piped stdin — line mode is fine */
    }
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}

const blob = fs.readFileSync(file)
const MAGIC = Buffer.from('MISTENC1', 'utf-8')
if (blob.subarray(0, 8).toString('utf-8') !== MAGIC.toString('utf-8')) {
  console.error('not a MISTENC1 blob (wrong file or old export)')
  process.exit(1)
}
const salt = blob.subarray(8, 24)
const iv = blob.subarray(24, 36)
const body = blob.subarray(36, blob.length - 16)
const tag = blob.subarray(blob.length - 16)

const passphrase = await askPassphrase()
try {
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 })
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(body), decipher.final()])
  process.stdout.write(plain.toString('utf-8') + '\n')
} catch {
  console.error('decryption failed — wrong passphrase or corrupted blob')
  process.exit(1)
}
