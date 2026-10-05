// M.I.S.T. channel architecture — honest port of OpenJarvis's 31-channel
// registry (src/openjarvis/channels/: 30 @ChannelRegistry.register adapters
// plus the macOS imessage_daemon).
//
// Reality in this sandbox: exactly ONE channel is live — webchat, which is
// this application itself (chat tab + consciousness/voice tab + synapse
// websocket). Every other adapter is an honest not-connected stub: it reports
// what it WOULD need to connect (credentials/daemons that don't exist here)
// and the webhook URL shape it would use for inbound wiring. Nothing fakes a
// connection; sendMessage on an unconfigured channel returns an honest error.
//
// Channel send contract is ported from OpenJarvis's BaseChannel canonical
// shape: destination id + optional reply/thread reference — here surfaced as
// the `to` and `replyTo` fields of SendRequest.

export interface ChannelInfo {
  /** Registry id (mirrors the OpenJarvis adapter id). */
  id: string
  name: string
  /** Credentials/daemon present and connected. Only webchat is true today. */
  connected: boolean
  /** The adapter's surface is actually serving traffic in this app. */
  live: boolean
  note: string
  /** Inbound webhook URL shape this channel WOULD use once wired (relative). */
  webhookShape?: string
}

export interface SendRequest {
  /** Destination identifier per the canonical send contract (chat id, channel id, email address…). */
  to: string
  /** Native id of the message being replied to, when replying. */
  replyTo?: string
  /** Extra per-channel metadata (thread ts, attachments…). */
  metadata?: Record<string, unknown>
}

export interface SendResult {
  ok: boolean
  channel?: string
  error?: string
  note?: string
}

function webhook(id: string): string {
  return `/api/mist/channels/${id}/webhook`
}

/**
 * The 31-channel registry. Order mirrors OpenJarvis's channel set; the eight
 * first-party adapters (telegram, slack, discord, whatsapp, imessage, sendblue,
 * email, twitter) carry full setup notes, the rest concise honest ones.
 */
const CHANNELS: ChannelInfo[] = [
  {
    id: 'webchat',
    name: 'Web Chat (M.I.S.T. console)',
    connected: true,
    live: true,
    note: 'LIVE — this is the application you are using: the chat tab, the consciousness/voice tab and the synapse websocket all ride this surface. Port of OpenJarvis WebChatChannel, where in this app the "adapter" is the console itself.',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    connected: false,
    live: false,
    note: 'Bot API. Setup: create a bot with @BotFather → export its token (MIST_TELEGRAM_BOT_TOKEN) → point Telegram at the webhook below (or run long-polling). Inbound updates would fan into her conversation flow with per-session identity.',
    webhookShape: webhook('telegram'),
  },
  {
    id: 'slack',
    name: 'Slack',
    connected: false,
    live: false,
    note: 'Slack app. Setup: create an app → Bot User OAuth token + signing secret (MIST_SLACK_BOT_TOKEN) → subscribe to message events via the Events API webhook (Socket Mode would avoid the public URL).',
    webhookShape: webhook('slack'),
  },
  {
    id: 'discord',
    name: 'Discord',
    connected: false,
    live: false,
    note: 'Bot via the Discord gateway (persistent websocket, MESSAGE_CONTENT intent) — inbound is push, not webhook. Setup: create a Developer Application → bot token (MIST_DISCORD_BOT_TOKEN). Outbound webhooks exist but carry no inbound messages.',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp (Cloud API)',
    connected: false,
    live: false,
    note: 'Meta WhatsApp Business Cloud API. Setup: Meta business account → phone-number id + system-user access token (MIST_WHATSAPP_TOKEN) → subscribe the phone number to the messages webhook. OpenJarvis also ships a self-hosted baileys bridge (see whatsapp_baileys).',
    webhookShape: webhook('whatsapp'),
  },
  {
    id: 'imessage',
    name: 'iMessage (chat.db daemon)',
    connected: false,
    live: false,
    note: 'Port of OpenJarvis imessage_daemon: polls the macOS chat.db and sends via AppleScript. Needs a Mac signed into Messages — N/A on this Linux sandbox. No webhook; the daemon polls locally.',
  },
  {
    id: 'sendblue',
    name: 'SendBlue (iMessage over HTTP)',
    connected: false,
    live: false,
    note: 'SendBlue API for iMessage without a Mac. Setup: SendBlue account → API key (MIST_SENDBLUE_API_KEY) → inbound messages arrive on the webhook below, outbound via their send endpoint.',
    webhookShape: webhook('sendblue'),
  },
  {
    id: 'email',
    name: 'Email (SMTP + IMAP)',
    connected: false,
    live: false,
    note: 'SMTP send + IMAP/POP3 receive. Setup: SMTP credentials (MIST_EMAIL_SMTP_URL) + IMAP polling interval; replies thread via In-Reply-To. No webhook — the adapter polls the mailbox. (Gmail variant exists as the gmail adapter.)',
  },
  {
    id: 'twitter',
    name: 'Twitter / X',
    connected: false,
    live: false,
    note: 'X API v2. Setup: bearer token (MIST_TWITTER_BEARER_TOKEN) → mentions via the filtered stream (or Account Activity webhooks on enterprise tiers); replies post through the tweet endpoint. Strict per-endpoint rate limits.',
  },
  // ---- remaining registry entries: honest not-connected stubs ----
  {
    id: 'gmail',
    name: 'Gmail',
    connected: false,
    live: false,
    note: 'OAuth2 Gmail connector (also usable as the email channel). Needs Google OAuth client credentials + consent; none configured in this sandbox.',
    webhookShape: webhook('gmail'),
  },
  {
    id: 'signal',
    name: 'Signal',
    connected: false,
    live: false,
    note: 'signal-cli JSON-RPC daemon with a registered number. Needs a persistent local daemon + trust pairing; N/A here.',
  },
  {
    id: 'twilio',
    name: 'Twilio SMS',
    connected: false,
    live: false,
    note: 'Twilio phone number + auth credentials (MIST_TWILIO_*). Inbound SMS arrives on the webhook; outbound via the REST API.',
    webhookShape: webhook('twilio'),
  },
  {
    id: 'bluebubbles',
    name: 'BlueBubbles',
    connected: false,
    live: false,
    note: 'BlueBubbles server (mac) + API key — iMessage relay. Inbound posts to the webhook; needs the Mac-side server.',
    webhookShape: webhook('bluebubbles'),
  },
  {
    id: 'whatsapp_baileys',
    name: 'WhatsApp (baileys bridge)',
    connected: false,
    live: false,
    note: 'Self-hosted bridge via the baileys TS runtime (OpenJarvis ships it as a bundled bridge). QR pairing on a real account; N/A in the sandbox.',
  },
  {
    id: 'google_chat',
    name: 'Google Chat',
    connected: false,
    live: false,
    note: 'Google Chat app (service account + event subscription). Needs Google Workspace credentials.',
    webhookShape: webhook('google_chat'),
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    connected: false,
    live: false,
    note: 'Teams bot via the Bot Framework (Azure registration). Needs an Azure bot registration + credentials.',
    webhookShape: webhook('teams'),
  },
  {
    id: 'matrix',
    name: 'Matrix',
    connected: false,
    live: false,
    note: 'Matrix client SDK against a homeserver. Needs a homeserver account (user + access token).',
  },
  {
    id: 'mattermost',
    name: 'Mattermost',
    connected: false,
    live: false,
    note: 'Bot account + websocket/REST against a Mattermost server. Needs a Mattermost instance + token.',
  },
  {
    id: 'rocketchat',
    name: 'Rocket.Chat',
    connected: false,
    live: false,
    note: 'Bot account + realtime API against a Rocket.Chat server. Needs a server + token.',
  },
  {
    id: 'zulip',
    name: 'Zulip',
    connected: false,
    live: false,
    note: 'Zulip bot email + API key. Needs a Zulip organization.',
  },
  {
    id: 'feishu',
    name: 'Feishu / Lark',
    connected: false,
    live: false,
    note: 'Feishu open-platform app. Inbound events post to the webhook; needs app credentials.',
    webhookShape: webhook('feishu'),
  },
  {
    id: 'line',
    name: 'LINE',
    connected: false,
    live: false,
    note: 'LINE Messaging API. Inbound messages post to the webhook; needs a channel access token.',
    webhookShape: webhook('line'),
  },
  {
    id: 'viber',
    name: 'Viber',
    connected: false,
    live: false,
    note: 'Viber bot account. Inbound posts to the webhook; needs an auth token.',
    webhookShape: webhook('viber'),
  },
  {
    id: 'messenger',
    name: 'Facebook Messenger',
    connected: false,
    live: false,
    note: 'Messenger platform app. Inbound posts to the webhook; needs page access token + verify token.',
    webhookShape: webhook('messenger'),
  },
  {
    id: 'reddit',
    name: 'Reddit',
    connected: false,
    live: false,
    note: 'Reddit bot account (OAuth app script type). Needs client id/secret; inbox polling for mentions.',
  },
  {
    id: 'mastodon',
    name: 'Mastodon',
    connected: false,
    live: false,
    note: 'Access token on an instance; streaming REST for mentions. Needs an account token.',
  },
  {
    id: 'nostr',
    name: 'Nostr',
    connected: false,
    live: false,
    note: 'npub key + relay list. Needs a signing key; relays are outbound websockets.',
  },
  {
    id: 'twitch',
    name: 'Twitch',
    connected: false,
    live: false,
    note: 'Twitch IRC chat with an OAuth token. Needs a chat auth token per account.',
  },
  {
    id: 'irc',
    name: 'IRC',
    connected: false,
    live: false,
    note: 'Plain IRC client (nick + server). No credentials exist for a sandbox IRC identity.',
  },
  {
    id: 'xmpp',
    name: 'XMPP',
    connected: false,
    live: false,
    note: 'XMPP client (JID + password). Needs an account on an XMPP server.',
  },
  {
    id: 'webhook',
    name: 'Generic Webhook',
    connected: false,
    live: false,
    note: 'OpenJarvis generic inbound webhook channel — accepts signed JSON payloads at the route below. No signing secret configured.',
    webhookShape: webhook('webhook'),
  },
]

/** List every channel with its honest connection state. */
export function listChannels(): ChannelInfo[] {
  return CHANNELS.map((c) => ({ ...c }))
}

/** Fetch one channel by id. */
export function getChannel(id: string): ChannelInfo | null {
  const found = CHANNELS.find((c) => c.id === id)
  return found ? { ...found } : null
}

/**
 * Channel send surface — port of BaseChannel.send as an honest stub.
 * The live webchat surface is served by the console itself, so every other
 * adapter either (a) honestly reports not-connected, or (b) for unknown ids,
 * reports unknown. Nothing pretends to deliver.
 */
export function sendMessage(channelId: string, content: string, req?: SendRequest): SendResult {
  if (typeof content !== 'string' || content.length === 0) {
    return { ok: false, error: 'refusing to send: empty message' }
  }
  const channel = CHANNELS.find((c) => c.id === channelId)
  if (!channel) {
    return { ok: false, error: `unknown channel '${channelId}' — call listChannels() for the registry` }
  }
  if (channel.live && channel.connected) {
    return {
      ok: true,
      channel: channel.id,
      note: 'webchat is live and served by the M.I.S.T. console itself — messages flow through the app conversation APIs, no adapter hop',
      ...(req?.to !== undefined ? { deliveredTo: req.to } : {}),
    }
  }
  return {
    ok: false,
    channel: channel.id,
    error: `channel '${channel.id}' is not connected — no credentials/daemon configured in this sandbox`,
    note: channel.note,
  }
}
