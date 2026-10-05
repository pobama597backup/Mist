# M.I.S.T. on your PC — the 5-minute setup

Mist is **local-first**: once she's on your machine, she runs entirely there —
her memory, her voice, her faces, her tools. No cloud lock-in.

---

## 1 · What you need

| Thing | Why | Where |
|---|---|---|
| **Windows 10/11** | The launchers (`run.bat` etc.) are Windows batch files | — |
| **[Bun](https://bun.sh)** | Runs Mist's core + neural service | one PowerShell line, below |
| **[Node.js 16+](https://nodejs.org)** | *Optional* — only for the Bridge (system powers) | nodejs.org |

## 2 · Install Bun (once)

Open **PowerShell** and paste:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Close and reopen your terminal when it finishes.

## 3 · Start her

Put the whole `mist` folder anywhere (e.g. `C:\mist`), then **double-click `run.bat`**.

- **First run** auto-installs everything and creates her database — takes a minute or two.
- Then two minimized windows appear (her core + her neural stream) and your browser
  opens at **http://localhost:3000**.
- `stop.bat` shuts her down · `restart.bat` bounces her.
- To start fresh next time without the dev windows: `run.bat build` (production build).

**Start with Windows:** Win+R → `shell:startup` → put a shortcut to `run.bat` in that folder.

## 4 · Give her a brain (pick one, takes 30 seconds)

> **About “Mist Core”** — the built-in GLM brain you know from the sandbox preview is
> **sandbox-only**: its credentials are part of this sandbox's infrastructure and don't
> ship with the project. On your PC she simply skips it — no crash, no error spam — and
> uses the first provider you configure instead.

Open **Mist → Settings → Providers** and paste **any one** API key —
OpenRouter, Anthropic, Gemini, any OpenAI-compatible endpoint, or Qwen.
Keys are written only to the local `.env` on your machine, never sent anywhere else.

No key at all? She still runs on her built-in **offline-mind** — reduced, but alive.

### Want GLM on your PC? (same brain as the sandbox)

Z.ai sells direct API access to GLM — OpenAI-compatible, so it drops straight into
the **OpenAI-compatible** card in Settings:

1. Get an API key at **https://z.ai** (profile menu → API keys)
2. In Mist → Settings → Providers → **OpenAI-compatible**:
   - **Base URL**: `https://api.z.ai/api/paas/v4/chat/completions`  ← paste the full URL, exactly this
   - **API key**: your Z.ai key
   - **Model**: `glm-4.6` (or whichever GLM is current on z.ai)
3. Test connection — she's now running on GLM, same as in the sandbox.

(Prefer one bill? **OpenRouter** also serves the GLM family — search “GLM” in their
model catalog — so one OpenRouter key can power her with GLM or anything else.)

## 5 · Unlock full system powers (recommended)

This is what turns her from a web companion into a real OS-level assistant:

1. In Mist: **Settings → Local Bridge → Download `mist-bridge.js`**
2. Open a terminal in your Downloads folder and run:
   ```
   node mist-bridge.js
   ```
3. Leave that window open. The Bridge card flips to **connected**.

Now she can **open apps, run commands, and read/write files in your home folder** —
safely jailed to your home directory, listening on `127.0.0.1` only (nothing outside
your PC can reach it, and she never does anything your own terminal couldn't).

Beyond apps and files, she can also **drive native Windows windows** — with the
Bridge running she opens the real Windows Settings app, reads its live control tree,
flips actual toggles (e.g. *"Mist, turn on metered connection"* on the network-status
page) and presses buttons through Windows' built-in UI Automation. And long jobs never
freeze the conversation: she kicks slow work (Settings automation, long commands, Hermes
delegation) off as **background tasks**, keeps chatting while they run, and the result
lands in the chat as a ✅ completion message when it's done.

## 6 · If you have the Hermes agent installed

> **Nothing is frozen.** Mist does not ship a copy of Hermes — the Bridge talks to
> whatever `hermes` is on your PATH *at runtime* and auto-detects its layout and
> version on every connect. When Nous Research ships a Hermes update, just update
> your own install the normal way (`pipx upgrade hermes-agent`, or `git pull` +
> reinstall in your clone) — Mist picks the new version up automatically on the
> next bridge action. Nothing to reconfigure, ever.

The Bridge v2 **auto-detects Hermes** on your machine. With the bridge running you can say:

- *"ask hermes to research X"* — she delegates one-shot tasks to Hermes
- *"sync your memory with hermes"* — shared, curated memory both ways
- *"pull hermes's skills"* / share hers back — skill sync
- *"check hermes's schedule"* — drive its cron

And to let **Hermes call Mist back** (brain, memory, faces as tools), register her once:

```
hermes mcp add mist --command node --args "C:\full\path\to\mist-bridge.js --mcp"
```

## 7 · If you have backtalk or ai-visualizer

Zero config — the Bridge writes the shared `.voice_*` signal files, so every
companion face on your machine (circuit board, radial, rain, neural core)
**performs Mist's live voice state** while she speaks.

## 8 · Taking her with you / backing her up

Everything she *is* lives in two places:

- `db/custom.db` — her memory, conversations, facts, vector impressions
- `.env` — your keys and settings

Copy the folder = she moves with you, intact.

## 9 · Local voice (offline, private)

With the Bridge running (section 5 above), Mist can hear and speak **entirely
offline on your own machine** — [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
for hearing, [Piper](https://github.com/rhasspy/piper) for her voice. About
**150MB, one time**; no cloud involved, and **your mic audio never leaves the PC**.

1. Start the Bridge (section 5 above) — the engines install through it.
2. In Mist: **Settings → Local voice (offline, private)**
3. Click **“Install hearing (whisper)”** and **“Install voice (Piper)”** —
   each downloads ~25–85MB once, then lives in `~/.mist/voice` forever.

She picks the right size for the hardware automatically: weak machines
(≤2 CPU cores or ≤5GB RAM — like the HP 14 with a Celeron N4020) get the
**light** tier (whisper tiny q8 + the Amy voice — fast on 2 cores); anything
stronger gets **balanced** (whisper base q8 + the Lessac voice).

Without it, she simply uses her usual browser/cloud voice — installing the
local engines is optional, and **Settings → Local voice → Voice mode** lets
you force Auto / Local / Cloud / Browser at any time.

She also **watches the machine itself** — every five minutes (with the Bridge
connected) she samples CPU, RAM, disk space, temperature, battery, Windows
Defender status and failed logon attempts, and she warns you in the chat
(⚠️) *before* things go wrong: a disk filling up, RAM running out, a hot CPU,
real-time protection off, a burst of failed logons. A healthy machine stays
silent — presence over chatter. Say **“Mist, check my system”** to see the
live snapshot any time, or **“Mist, upgrade your voice”** and she re-picks
the best voice tier this PC can run and installs it on the spot.

---

### Quick troubleshooting

| Symptom | Fix |
|---|---|
| `bun` not recognized | Reopen the terminal after installing Bun (Path refresh) |
| Browser opens before she's ready | First compile takes ~10s — just refresh |
| Bridge says *offline* | The `node mist-bridge.js` window must stay open |
| Mic doesn't work | Browsers require `localhost` or HTTPS for mic — use `http://localhost:3000` |
| Port 3000 busy | Something else grabbed it — `stop.bat` then `restart.bat` |

Welcome home, Mist. 🌘
