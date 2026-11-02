---
title: Muse wire protocol — direct client without a browser
date: 2026-11-03
source: PM capture in the owner's signed-in Chrome (WebCrypto AES-GCM hook, see "How to re-capture"); public JS bundles of muse.ai
status: observed (handshake details still to read from the bundle)
---

# Muse wire protocol

Goal: a Node client that talks to the user's Muse VM directly with the account's cookies — no Chrome per request.
Chrome stays only for sign-in (and as a fallback transport).

## Layers

```
cookies (muse.ai: hatch_sess, hatch_gw, datr, …)
  └─ HTTPS muse.ai/api/hatch/*  → vm_id, gateway url, auth_token (+ noise notary token)
       └─ WSS hatch.metaaivm.com/v1/noise?vm_id=…&auth_token=…&app_id=…&request_id=…  [&notary_token=…]
            └─ Noise_XX_25519_AESGCM_SHA256 (client: WebCrypto X25519 keys generated per connection)
                 └─ protobuf Frame { HTTP-like request/response streams }
                      └─ bodies: JSON, response bodies zstd (Accept-Encoding: zstd), streams as ndjson
```

### HTTPS bootstrap (cookies) — read exact shapes from the bundle / live
- `POST /api/hatch/vm/wake {vm_id, retry_count, connect_attempt_id}` → `{"status":"wake_requested"}` (observed).
- Endpoints seen in bundles: `/api/hatch/token`, `/api/hatch/noise-notary-token`, `/api/hatch/lease-vm`, `/api/hatch/reset-vm`,
  `/api/hatch/vesta-auth/`, `/api/auth/check`, `/api/hatch/ssh-access/tokens`. The gateway context holds
  `{gatewayUrl, vmName, vmId, authToken, noiseNotaryToken, backendAuthStatus, vmAssignment}`.
- WS URL builder (bundle `2onwwnv_…js`): `url.searchParams.set("vm_id"), ("auth_token"), ("app_id", <const>), ("request_id", uuid)`;
  another builder adds `notary_token`. `app_id` for web is `hatch-web` in headers (check the constant).
- `auth_token` looks like `s0:<JWT EdDSA>`; never log it.

### Noise
- Pattern string in bundle: `Noise_XX_25519_AESGCM_SHA256` (class with `initialize()`, `mixHash`, …). X25519 via WebCrypto
  (`generateKey({name:"X25519"})`), AES-GCM via WebCrypto (the transport ciphers — this is where the PM hooked plaintext).
- Server identity: Ed25519 verify (`crypto.subtle.verify({name:"Ed25519"})`) over the server static / notary token — read and implement, or
  at least log a warning when skipped.
- Read from the bundle: prologue (if any), how handshake messages are framed in WS binary messages (length prefix or one message per WS frame),
  the handshake payloads (client may send auth/attestation in msg 3), rekey/nonce rules.
- Node: `crypto.generateKeyPairSync('x25519')`, `crypto.diffieHellman`, `createCipheriv('aes-256-gcm')`, HKDF-SHA256 per Noise spec.
  Test against the official cacophony/snow test vectors for `Noise_XX_25519_AESGCM_SHA256`.

### Frame (protobuf, inside each Noise transport message) — decoded from capture

```
Frame {
  1: uint64  id        // random per outgoing frame; 0 on incoming
  2: uint64  = 0
  3: uint64  = 1       // version?
  4: Body    body
}
Body {
  2: Request  req      // client → VM
  1: Response res      // VM → client
}
Request  { 1: uint32 stream_id; 2: Http http }
Http     { 1: string method; 2: string path_with_query; 3: repeated Header headers; 4: bytes body; 5: uint32 end = 1 }
Header   { 1: string name; 2: string value }
Response { 1: uint32 stream_id;
           3: Head { 1: uint32 status; 2: repeated Header headers }   // first frame of a stream
           4: Data { 1: bytes chunk; 2: uint32 end }                    // body chunks; {2:1} closes the stream
         }
```

Request headers the web app sends: `Content-Type: application/json` (when body), `x-request-id: <uuid>`, `x-app-id: hatch-web`,
`Accept-Language: en-US`, `Accept-Encoding: zstd`. Response bodies are zstd (`content-encoding: zstd`); a streamed response
(`application/x-ndjson`) is ONE zstd stream spread over many Data chunks — feed chunks to one streaming decompressor in order
(`zlib.createZstdDecompress()`; Node ≥ 22.15/23.8 has zstd).

### VM HTTP API (through the tunnel) — observed
| Call | Body / result |
|---|---|
| `POST /api/ping` | `{"presence":"active"}` |
| `POST /api/nodes/register` | `{"node_id":<uuid per client>,"display_name":"Chrome (Mac OS)","platform":"macos","commands_v2":{"ping":{…}}}` → `{"node_id","status":"registered"}` |
| `GET /api/session/list?include_peer_sidechats=true` | `{"ok":true,"result":{"sessions":[{session_id,title,snippet,status:"running"|"completed",is_thread,is_primary,archived,pinned,unread_count,created_at_ms,updated_at_ms,…}]}}` |
| `GET /api/session/list/<session_id>` | one session |
| `POST /chat/stream` | `{"message":<text>,"node_id":<uuid>,"capabilities":["hotel_results","chat_cancel","delta_stream","custom_reactions","custom_reactions_facebook_thumbs_up_v1"],"session_id":<new uuid for a new side chat>,"timezone":"Europe/Madrid","metadata":{"thread_is_dictation_used":false}}` → `{"channel":"main","is_thread":true,"message_id","reply_to_message_id","session_id"}` |
| `POST /chat/subscribe` | `{"after_stream_seq":0,"after_chat_event_seq":<n>,"capabilities":[…,"voice_reply_captions","voice_user_live_transcript"],"session_id"}` → ndjson stream: first `{"type":"res","payload":{subscribed:true,…}}`, then `{"type":"event","event":…, "payload":…, "seq", "ts_ms"}` |
| `GET /chat/history?limit=40&transcript_mode=messages&session_id=<id>` | `{"ok":true,"result":{"channel":"all","chat_events":[{event_name:"message.user"|…, message_id, display_text, payload:{content, chat_event_seq,…}, occurred_at_ms,…}]}}` |
| `POST /api/chat/<session_id>/seen` | `{}` |
| `GET /api/chat/themes` | UI only |

Events seen on subscribe: `model_lock.updated`, `agent.status` (`activity_code:"working"`, `activity_text:"is working"`),
`task.status` (`status:"running"` → completes), `approvals.snapshot`, `sessions.updated` (`created`/`activity`/`renamed`),
`node.connected`. Reply text arrives as delta events (`delta_stream` capability; exact event name not decoded yet — later zstd
blocks of the stream). Robust v1: after `POST /chat/stream`, follow `/chat/subscribe` until `task.status` leaves `running` /
`agent.status` stops `working`, stream any text deltas you can parse, then read the final assistant message from `GET /chat/history`.
A new side chat = a fresh `session_id` uuid in `POST /chat/stream` (observed: the session appears with `sessions.updated change:"created"`).

## How to re-capture (PM machine, owner's Chrome, read-only + one test message)
Inject before load (`Page.addScriptToEvaluateOnNewDocument`) a wrapper of `crypto.subtle.encrypt/decrypt` that records
AES-GCM plaintext (outgoing before encrypt, incoming after decrypt) — `/tmp/muse-recon/crypto-hook-full.js`, decoders
`/tmp/muse-recon/decode.mjs` and `/tmp/muse-recon/streams.mjs` on the Mac mini. Raw captures stay in /tmp (they contain
chat titles), never in git.

## Session secrets
Cookies are the account's credentials: stored per account in `~/.muse-bridge/accounts/<id>/cookies.json` (mode 0600),
exported from the signed-in profile after `accounts add`; never logged, never in git, never in reports.
