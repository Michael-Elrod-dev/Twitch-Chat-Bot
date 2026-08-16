# Phase 1 — EventSub & Auth Facts

**Date:** 2026-08-15
**Package:** P1-WP1 (research spike, no code)
**Purpose:** lock the Twitch transport, auth, and limits facts before any Phase 1 implementation.

Every load-bearing claim below is cited to current `dev.twitch.tv` documentation. Where
the docs contradict themselves or are silent, this document says so rather than
guessing — those are called out as **[UNVERIFIED]** and carry a recommended way to
settle them at implementation time.

**Read §6 first if you only read one section** — it contains two findings that
invalidate parts of `PHASE1_DESIGN.md` §2.

---

## 1. Transport: webhook vs conduit

### What conduits actually are

A conduit is *not* a fourth transport. It is **a wrapper that separates your
subscriptions from the underlying transport and load balances notifications across
shards** ([Handling Conduit Events](https://dev.twitch.tv/docs/eventsub/handling-conduit-events/)).

- A **shard** is a single webhook or websocket connection. A conduit created with 5
  shards yields shard IDs 0–4.
- Twitch hashes on **channel ID** to decide which shard a given channel's
  notifications land on.
- **Subscriptions are created against the conduit ID, not against a transport.** This
  is the decisive architectural difference.
- Creating a conduit requires an **app access token**.
- Limits: **max 5 enabled conduits per client**, **max 20,000 shards per conduit**.
  Twitch notes "all numbers provided are subject to change."
- Shard lifecycle: shards are attached via `PATCH /helix/eventsub/conduits/shards`.
  Webhook shards get the same verification challenge as plain webhooks. If a shard
  disables, EventSub attempts redelivery on other shards; `conduit.shard.disabled` is
  subscribable. A conduit with all shards disabled is deleted after 72 hours.

### The three transports, as they apply to us

| | Plain webhook | Conduit | WebSocket |
|---|---|---|---|
| Token to create subscription | app access token | app access token | user access token *(or app — see §3)* |
| Subscriptions survive process restart | **yes** | **yes** | **no** — die with the session |
| Needs public HTTPS:443 | yes | only for webhook shards | no |
| Transport swappable without recreating subs | no | **yes** | no |
| Extra machinery | none | conduit + shard lifecycle | connection/session bookkeeping |

### Recommendation: **plain webhook for launch**

For two channels on one box, plain webhook is the correct choice, and the design
doc's direction (§2.2) is confirmed sound.

Reasoning:

- Conduits' value is **horizontal scale** — spreading load across many connections and
  re-pointing transports without touching subscriptions. We have one server process.
  Buying that machinery now is complexity without a matching problem.
- Plain webhook already delivers the property that actually matters versus today's
  websocket: **subscriptions live server-side and survive restarts**. That structurally
  eliminates the entire failure class behind Phase 0's P0-2 (a new session silently
  losing its subscriptions).
- Twitch's own chat-bot guidance points here: "Receiving EventSub events via Webhooks
  is the best option when a chatbot is hosted off of the end-user's system"
  ([Authenticating and Setting up EventSub](https://dev.twitch.tv/docs/chat/authenticating/)).

**Graduate to conduits when** we run more than one server instance, or need
zero-downtime deploys where in-flight notifications must not drop. That mirrors the
§4.1 database tier pattern: cheap now, pre-planned trigger, no wasted work — the
subscription *conditions* are identical either way, so migrating means changing the
`transport` object at creation time, not redesigning ingest.

**One conduit property worth remembering:** because subscriptions bind to the conduit
rather than a URL, a conduit can carry a **websocket shard in dev and a webhook shard
in prod with an identical subscription layer**. If the dual-transport maintenance in
§2.2 turns out to hurt, that is the escape hatch — but see §6.3 for a cheaper answer.

---

## 2. Auth model per event type

This is the section that matters most, because the shared-bot model lives or dies here.

### The "Cloud Chatbot" pattern (Twitch's own name for our architecture)

Twitch documents exactly our shape
([Authenticating and Setting up EventSub](https://dev.twitch.tv/docs/chat/authenticating/)):

- **The bot account authorizes the app once**, granting `user:read:chat`,
  `user:write:chat`, and `user:bot`.
- **Each broadcaster authorizes the app**, granting `channel:bot` (plus whatever their
  own events need).
- The server then uses an **app access token** for both subscription creation and chat
  sends. The bot's own user token is not on the hot path.

The two `*:bot` scopes are the mechanism that makes this work, and they are the piece
most likely to be missing from a pre-2024 mental model:

| Scope | Granted by | Meaning ([Scopes](https://dev.twitch.tv/docs/authentication/scopes/)) |
|---|---|---|
| `user:bot` | the **bot** account | "join a specified chat channel as your user and appear as a bot, and perform chat-related actions as your user" |
| `channel:bot` | the **broadcaster** | "join your channel's chatroom as a bot user, and perform chat-related actions as that user" |

### Per-subscription requirements

Source for all rows: [EventSub Subscription Types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/).

| Subscription | Condition fields | Authorization required |
|---|---|---|
| `channel.chat.message` | `broadcaster_user_id`, `user_id` | `user:read:chat` **from the chatting/reading user** (= our bot). With an app access token, **additionally** `user:bot` from that user, **and either** `channel:bot` from the broadcaster **or** the bot holds moderator status in the channel. |
| `channel.channel_points_custom_reward_redemption.add` | `broadcaster_user_id` | `channel:read:redemptions` from the **broadcaster**. |
| `stream.online` | `broadcaster_user_id` | **none** |
| `stream.offline` | `broadcaster_user_id` | **none** |
| `channel.follow` (v2) | `broadcaster_user_id`, **`moderator_user_id`** | `moderator:read:followers` from the **moderator** named in the condition. |

### How `channel.chat.message` works for one bot across N broadcasters

The condition is a **pair**: `broadcaster_user_id` = the channel to watch,
`user_id` = the account doing the reading. For us, `user_id` is the shared bot on every
subscription; `broadcaster_user_id` varies per tenant.

So per additional channel we create one subscription with the same `user_id` and a new
`broadcaster_user_id`. The bot's grant (`user:read:chat` + `user:bot`) is granted
**once, globally**; the per-channel permission is the broadcaster's `channel:bot`.

**This is very good news for the design.** It means onboarding a channel requires no
new bot-side authorization, and the bot's identity is genuinely shared rather than
N-times-configured.

### Onboarding scope set (what the broadcaster must grant)

Derived from the table above, the broadcaster's authorization-code flow must request:

| Scope | Why |
|---|---|
| `channel:bot` | lets the shared bot read and write in their chat |
| `channel:read:redemptions` | channel-point redemption events |
| `moderator:read:followers` | follow events — see the caveat below |

`stream.online` / `stream.offline` need nothing, so a channel that grants nothing at
all can still have live/offline detection.

⚠️ **`channel.follow` has a wrinkle the design did not account for.** The condition
requires a `moderator_user_id`, and the scope must be held by **that moderator**. Two
workable routes:

1. **`moderator_user_id` = the broadcaster** (a broadcaster is implicitly their own
   moderator) — they grant `moderator:read:followers` during onboarding. Simplest;
   one more scope on the onboarding consent screen.
2. **`moderator_user_id` = the bot**, which requires the broadcaster to actually mod
   the bot *and* the bot to have granted `moderator:read:followers` globally.

**Recommend route 1** — it keeps onboarding self-service and does not depend on the
broadcaster remembering to `/mod` anyone. Route 2 becomes attractive only if we later
want the bot modded anyway (which also satisfies the `channel.chat.message`
alternative and would let us drop `channel:bot`).

---

## 3. Limits, costs, and webhook mechanics

### Cost model

Source: [Managing Subscriptions](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/).

- Every subscription costs **0 or 1**.
- **Cost 1**: subscriptions that name a user *without* that user's authorization
  (e.g. `stream.online`).
- **Cost 0**: subscriptions where the required scope **has been granted**.
- **The exception is the important part:** "If a user has authorized your application
  with the required scope, previously cost-1 subscriptions become cost-free."
- **`max_total_cost` starts at 10,000** for an application, and grows as users
  authorize.

**Practical read for us:** our per-channel subscription set is almost entirely
authorized (the broadcaster grants scopes at onboarding), so most subscriptions cost
**0**. Even counting every subscription as cost 1, 10,000 against a handful of channels
is not a constraint we will approach. **Subscription cost is a non-issue for this
project** and needs no design accommodation.

### WebSocket limits (relevant only to dev-mode transport)

- Max **3 enabled websocket connections** per user token.
- **300 subscriptions per connection**.
- **`max_total_cost` capped at 10** on websocket transport.

That last number is the quiet reason websocket does not scale to a hosted service:
ten cost-units total, versus ten thousand.

### Webhook callback requirements

Source: [Handling Webhook Events](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/).

- **TLS required; must listen on port 443.** No alternate ports. (DuckDNS +
  Let's Encrypt satisfies this — owner decision §8.6 holds.)
- **Verification challenge:** on subscribe, Twitch sends
  `Twitch-Eventsub-Message-Type: webhook_callback_verification`. Echo the `challenge`
  value back as a plain-text 200 body with a correct `Content-Length`. The
  subscription enables only after this succeeds.
- **HMAC-SHA256 signature.** Compute over the concatenation of
  `Twitch-Eventsub-Message-Id` + `Twitch-Eventsub-Message-Timestamp` + **raw request
  body**, keyed by our secret. Compare with a **timing-safe** comparison.
  - Secret must be **10–100 ASCII characters**.
  - **Implementation note:** the raw body is required, so body parsing must preserve it
    — `express.json()` with a `verify` callback capturing the buffer, applied *only* to
    the webhook route.
- **Deduplication:** `Twitch-Eventsub-Message-Id`. Twitch states plainly "you may
  receive a notification twice." Phase 0's bounded-set dedup (WP-6 task 7) ports
  directly; only the header name changes.
- **Response deadline:** respond "within a few seconds." Repeated slowness moves the
  subscription to `notification_failures_exceeded` and **Twitch revokes it**.
  - The docs explicitly recommend "writing the event to temporary storage and
    processing the notification after responding." **This should be a design rule for
    P1-WP5: the webhook handler enqueues and returns 2xx; it never processes inline.**
    Phase 0 already has the Redis queue + consumer shape to do this.
- **Subscription creation rate limit: 100 requests/minute** on
  `POST /helix/eventsub/subscriptions`
  ([Create EventSub Subscription](https://dev.twitch.tv/docs/api/reference#create-eventsub-subscription)).
  At ~4 subscriptions per channel this is irrelevant at our size, but a bulk
  re-subscribe across many channels should be paced.

---

## 4. Chat send path

**Endpoint:** `POST https://api.twitch.tv/helix/chat/messages` with `broadcaster_id`,
`sender_id`, `message`.

For a bot sending into N channels with an **app access token**, the requirement mirrors
the read path exactly:

- **`user:write:chat`** from the sending user (our bot), **plus**
- **`user:bot`** from the sending user, **plus**
- **either `channel:bot` from the broadcaster or moderator status** in that channel.

([Scopes](https://dev.twitch.tv/docs/authentication/scopes/);
[Authenticating and Setting up EventSub](https://dev.twitch.tv/docs/chat/authenticating/))

That symmetry is convenient: **the same broadcaster grant (`channel:bot`) unlocks both
reading and writing**, so onboarding does not need separate consent for the two
directions.

### ⚠️ [UNVERIFIED] `chat:edit` vs `user:write:chat` — a documentation discrepancy

The [API reference](https://dev.twitch.tv/docs/api/reference#send-chat-message) for
Send Chat Message describes authorization in terms of **`chat:edit`**, while the
[Scopes page](https://dev.twitch.tv/docs/authentication/scopes/) defines `chat:edit` as
the **IRC** scope ("send chat messages to a chatroom using an IRC connection") and
`user:write:chat` as the **API** scope ("send chat messages to a chatroom"). The chat
guides consistently use `user:write:chat`.

Most likely `chat:edit` is honored for backward compatibility and the reference page
is stale, but I could not confirm that from the docs alone.

**Recommendation:** request **`user:write:chat`** for the bot (it is what the current
guides specify). Do **not** speculatively request both — Twitch warns that requesting
more scopes than needed can get an application suspended
([Scopes](https://dev.twitch.tv/docs/authentication/scopes/)). Settle it empirically in
P1-WP6 with a single live send; it is a one-line change either way.

*Note for the port:* Phase 0's `messageSender` uses a **bot user token**, which remains
valid — a user access token with `user:write:chat` needs no `user:bot`/`channel:bot` at
all. The app-token route is what enables the shared-bot-across-N-channels model without
per-channel bot tokens.

---

## 5. OAuth for our two flows

### 5.1 Server onboarding — authorization code grant ✅ as designed

Source: [Getting OAuth Access Tokens](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/).

- Authorize: `https://id.twitch.tv/oauth2/authorize` with `client_id`, `redirect_uri`,
  `response_type=code`, `scope`, and `state` (strongly encouraged, CSRF).
- Token: `https://id.twitch.tv/oauth2/token` with `client_id`, **`client_secret`**,
  `code`, `grant_type=authorization_code`, `redirect_uri`.
- **Client secret is mandatory.** This flow is "meant for apps that use a server, can
  securely store a client secret."
- Access tokens expire in ~4 hours; refresh tokens are returned.
- `force_verify=true` forces a fresh consent screen — useful for re-authorization.

This is exactly what `PHASE1_DESIGN.md` §2.4 item 1 specifies. **No change needed.**

### 5.2 Desktop sign-in — ❌ PKCE does not exist at Twitch

**Twitch does not support PKCE.** It is not mentioned on the authentication overview,
the OAuth tokens page, the OIDC page, or the app-registration page, and a
domain-scoped search of `dev.twitch.tv` returns nothing for `code_challenge`/PKCE.

The supported flows are ([Authentication](https://dev.twitch.tv/docs/authentication/)):

| Flow | Intended client |
|---|---|
| Implicit grant | client-side JS / mobile — **returns no refresh token** |
| Authorization code | server apps that can hold a secret |
| **Device code** | "limited input capabilities or lacks a suitable browser; such as set-top boxes, games, or **Electron applications**" |
| Client credentials | app access tokens, no user context |

Two viable replacements for the design's PKCE plan:

**Option A — server-mediated authorization code (recommended).**
The desktop app opens the system browser at the **server's** `/auth/twitch/start`. Twitch
redirects to the **server's** HTTPS redirect URI. The server (the confidential client,
holding the secret) exchanges the code, verifies identity, mints its own JWT + refresh
token, and hands that back to the app via a loopback redirect or custom-scheme deep link.

- Preserves the design's stated goal exactly: "the app never holds broadcaster/bot
  Twitch tokens — only its API session."
- The Twitch client secret never leaves the server.
- No Twitch flow the desktop app has to implement itself.
- Needs **one** client ID.

**Option B — device code grant.**
The app requests a device code from `https://id.twitch.tv/oauth2/device`, shows the user
a code and URL, and polls the token endpoint. Public clients need no secret and can
refresh without one.

- Twitch names Electron apps as a target, so a Tauri app qualifies.
- Costs: clunkier UX (type a code) and **refresh tokens are one-time-use and expire
  after 30 days of inactivity** — a user who does not open the app for a month gets
  signed out.
- Also note: "Public clients are only limited to the usage of device authorization grant
  flow" — declaring the app public forecloses other flows.

**Recommend Option A.** Better UX, keeps the secret server-side, avoids the 30-day
inactivity cliff, and matches the design's existing intent for JWT-based app sessions.

### 5.3 One client ID or two?

Twitch's registration guidance is explicit: **"Do not share client IDs among
applications; each application must have its own client ID"**
([Register Your App](https://dev.twitch.tv/docs/authentication/register-app/)).

But under **Option A the desktop app is not an OAuth client at all** — it never talks to
`id.twitch.tv`; it talks to our server, which is the single Twitch application.

**Recommendation: one client ID**, registered as a confidential server app. If we ever
adopt Option B, the desktop becomes a genuine second OAuth client and must get its own
client ID (public, no secret) — the two would then need separate registrations by
Twitch's rule.

### 5.4 Redirect URI rules — [UNVERIFIED]

The [registration page](https://dev.twitch.tv/docs/authentication/register-app/) says
only to "Set OAuth Redirect URLs to the callback URL that your app uses for
authorizations." It does **not** document whether HTTPS is mandatory, whether
`http://localhost` is permitted, whether matching is exact, or how many URIs an app may
register.

This is not blocking under Option A (our redirect is a server HTTPS URL on the DuckDNS
domain, which satisfies any plausible rule). Worth confirming in the developer console
during P1-WP6 if we ever want a loopback redirect.

**Practical note:** the DuckDNS hostname is baked into the registered redirect URI, so
moving to a real domain later means re-registering redirect URIs in the Twitch console —
already anticipated in owner decision §8.6.

---

## 6. Design corrections — `PHASE1_DESIGN.md` §2

Three corrections. The transport direction itself is confirmed correct.

### 6.1 ❌ §2.4 item 2 — PKCE is not available

> "the desktop app signs in with Twitch OAuth (PKCE, loopback/system-browser redirect)"

**Twitch does not support PKCE** (§5.2). Replace with **server-mediated authorization
code** (Option A): the app opens the system browser to a server endpoint, the server is
the confidential client, and the app receives only our JWT. The design's *goal* —
the app holding no Twitch tokens — is unchanged and in fact better served.

**Impact:** P1-WP6 scope. Affects wording only, not architecture.

### 6.2 ⚠️ §2.4 item 3 — the bot identity model can be simpler than described

> "Bot identity (shared): the `almosthadai` account's token pair, one per deployment,
> managed exactly as Phase 0 left it (expiry-based refresh, atomic persist)"

Under the Cloud Chatbot pattern the hot path uses an **app access token**, not the bot's
user token. The bot's user authorization is a **one-time consent** (`user:read:chat`,
`user:write:chat`, `user:bot`) that grants the *application* standing permission; there
is no 4-hourly bot-token rotation on the critical path.

**Impact:** Phase 0's token machinery is still needed — for **broadcaster** tokens in
`channel_tokens`, and for app-access-token acquisition/refresh via client credentials —
but `bot_identity` may reduce to a record of the consent rather than a live rotating
token pair. **This should be settled in P1-WP3 (schema) rather than assumed**, since it
changes a table. Flagging rather than resolving: it depends on whether we ever need to
act as the bot user outside chat.

### 6.3 ⚠️ §2.2 — the dual-transport dev-mode plan may be unnecessary

> "The WS manager doesn't die: it remains the dev-mode transport (webhooks need a public
> URL; developers get `npm run debug` without a tunnel). The ingest layer gets a
> transport interface with two implementations."

Two implementations is a real, permanent maintenance cost, and the websocket path is
precisely where Phase 0's worst bugs lived. Two cheaper options exist:

1. **A tunnel in dev** (`cloudflared`, `ngrok`) gives a public HTTPS:443 callback, so dev
   and prod run the *same* ingest code.
2. **The Twitch CLI** provides EventSub mocking and event triggering, which would let
   tests and local runs exercise the webhook handler directly with no tunnel at all.
   **[UNVERIFIED]** — I did not confirm the CLI's current capabilities in this spike.

**Recommendation:** treat the transport interface as optional, and decide in P1-WP5 after
evaluating the CLI. If either option works, we ship **one** ingest implementation and
delete the websocket manager entirely — a meaningful simplification, and it retires the
code that produced P0-1 and P0-2.

### 6.4 ✅ Confirmed correct

- §2.2's core direction — webhooks, app-access-token subscriptions, per-broadcaster
  onboarding authorization, HMAC verification, Twitch-side retry, dedup on the message
  id — is **exactly right**.
- §2.4 item 1 (authorization-code onboarding) is correct as written.
- Owner decision §8.5 (single shared bot account) is not merely workable but is
  **Twitch's documented pattern** for this architecture.
- Owner decision §8.6 (DuckDNS + Let's Encrypt) satisfies the HTTPS:443 requirement.

---

## 7. Answers in brief

| # | Question | Answer |
|---|---|---|
| 1 | Webhook or conduit? | **Webhook** at our scale. Conduits are a scale abstraction; graduate when we run >1 instance. |
| 2 | Auth per event type | Bot grants `user:read:chat` + `user:write:chat` + `user:bot` **once**; each broadcaster grants `channel:bot` (+ `channel:read:redemptions`, `moderator:read:followers`). Subscriptions created with an **app access token**. |
| 3 | Limits & costs | `max_total_cost` **10,000**; authorized subscriptions cost **0**. Non-issue. Webhook needs **TLS on 443**, challenge echo, HMAC-SHA256 over id+timestamp+raw body, fast 2xx. Create limit **100/min**. |
| 4 | Chat send | `POST /helix/chat/messages` with an app token: `user:write:chat` + `user:bot` from the bot, `channel:bot` from the broadcaster (or bot is mod). Same grant as reading. |
| 5 | OAuth | Onboarding: authorization code (secret required) ✅. Desktop: **PKCE does not exist** — use server-mediated authorization code. **One client ID.** |
| 6 | Design corrections | PKCE (§6.1), bot identity simplification (§6.2), dual-transport possibly unnecessary (§6.3). |

## 8. Open items for later packages

| Item | Where | Why it is open |
|---|---|---|
| `chat:edit` vs `user:write:chat` | P1-WP6 | Two Twitch pages disagree; one live send settles it |
| Redirect URI rules (localhost, exact match) | P1-WP6 | Undocumented; only matters if we want loopback redirects |
| Twitch CLI EventSub mocking capability | P1-WP5 | Decides whether the dual-transport interface is needed at all |
| `bot_identity` table shape | P1-WP3 | Depends on whether the bot's user token is ever needed off the chat path |

---

## Sources

- [EventSub overview](https://dev.twitch.tv/docs/eventsub/)
- [Handling Conduit Events](https://dev.twitch.tv/docs/eventsub/handling-conduit-events/)
- [Handling Webhook Events](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/)
- [Managing Subscriptions](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/)
- [EventSub Subscription Types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)
- [Authenticating and Setting up EventSub (chat bots)](https://dev.twitch.tv/docs/chat/authenticating/)
- [Twitch Access Token Scopes](https://dev.twitch.tv/docs/authentication/scopes/)
- [Authentication overview](https://dev.twitch.tv/docs/authentication/)
- [Getting OAuth Access Tokens](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
- [Register Your App](https://dev.twitch.tv/docs/authentication/register-app/)
- [API Reference](https://dev.twitch.tv/docs/api/reference)
