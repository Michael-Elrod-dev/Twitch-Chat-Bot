# Twitch platform facts: EventSub, auth and limits

The Twitch transport, auth and limits facts this server is built on. Every load-bearing claim is cited to `dev.twitch.tv` documentation, and section 6 records the ones that were settled by measurement rather than by reading. Where the docs contradict themselves or are silent, this document says so rather than guessing.

Server comments cite this document by section number, so the numbering is stable.

---

## 1. Transport: webhook against conduit

### What conduits are

A conduit is not a fourth transport. It is a wrapper that separates subscriptions from the underlying transport and load balances notifications across shards ([Handling Conduit Events](https://dev.twitch.tv/docs/eventsub/handling-conduit-events/)).

- A shard is a single webhook or websocket connection. A conduit created with 5 shards yields shard ids 0 to 4.
- Twitch hashes on channel id to decide which shard a given channel's notifications land on.
- Subscriptions are created against the conduit id, not against a transport. This is the decisive architectural difference.
- Creating a conduit requires an app access token.
- The limits are 5 enabled conduits per client and 20,000 shards per conduit. Twitch notes that all numbers provided are subject to change.
- Shards are attached with `PATCH /helix/eventsub/conduits/shards`. Webhook shards get the same verification challenge as plain webhooks. If a shard disables, EventSub attempts redelivery on other shards, and `conduit.shard.disabled` is subscribable. A conduit with all shards disabled is deleted after 72 hours.

### The three transports

| | Plain webhook | Conduit | WebSocket |
|---|---|---|---|
| Token to create subscription | app access token | app access token | user access token, or an app token (section 3) |
| Subscriptions survive process restart | **yes** | **yes** | **no**, they die with the session |
| Needs public HTTPS on port 443 | yes | only for webhook shards | no |
| Transport swappable without recreating subs | no | **yes** | no |
| Extra machinery | none | conduit and shard lifecycle | connection and session bookkeeping |

### What this server uses, and when that changes

Plain webhook. At this scale it is the correct choice.

- A conduit's value is horizontal scale, meaning spreading load across many connections and re-pointing transports without touching subscriptions. This is one server process, so that machinery would be complexity without a matching problem.
- Plain webhook already delivers the property that matters against websocket transport, which is that subscriptions live server-side and survive restarts. That structurally removes the failure class where a new session silently loses its subscriptions.
- Twitch's own chat-bot guidance points the same way: "Receiving EventSub events via Webhooks is the best option when a chatbot is hosted off of the end-user's system" ([Authenticating and Setting up EventSub](https://dev.twitch.tv/docs/chat/authenticating/)).

Graduate to conduits when more than one server instance runs, or when zero-downtime deploys must not drop in-flight notifications. The subscription conditions are identical either way, so migrating means changing the `transport` object at creation time rather than redesigning ingest.

One conduit property is worth remembering. Because subscriptions bind to the conduit rather than to a URL, a conduit can carry a websocket shard in development and a webhook shard in production behind an identical subscription layer.

---

## 2. Auth model per event type

This is the section the shared-bot model lives or dies on.

### The Cloud Chatbot pattern

Twitch documents exactly this shape and gives it that name ([Authenticating and Setting up EventSub](https://dev.twitch.tv/docs/chat/authenticating/)).

- The bot account authorizes the application once, granting `user:read:chat`, `user:write:chat` and `user:bot`.
- Each broadcaster authorizes the application, granting `channel:bot` plus whatever their own events need.
- The server then uses an app access token for both subscription creation and chat sends. The bot's own user token is not on the hot path.

The two bot scopes are the mechanism that makes this work, and they are the piece most likely to be missing from a pre-2024 mental model.

| Scope | Granted by | Meaning ([Scopes](https://dev.twitch.tv/docs/authentication/scopes/)) |
|---|---|---|
| `user:bot` | the **bot** account | "join a specified chat channel as your user and appear as a bot, and perform chat-related actions as your user" |
| `channel:bot` | the **broadcaster** | "join your channel's chatroom as a bot user, and perform chat-related actions as that user" |

### Per-subscription requirements

The source for every row is [EventSub Subscription Types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/).

| Subscription | Condition fields | Authorization required |
|---|---|---|
| `channel.chat.message` | `broadcaster_user_id`, `user_id` | `user:read:chat` from the chatting and reading user, which is the bot. With an app access token, additionally `user:bot` from that user, and either `channel:bot` from the broadcaster or moderator status for the bot in the channel. |
| `channel.channel_points_custom_reward_redemption.add` | `broadcaster_user_id` | `channel:read:redemptions` from the broadcaster. |
| `stream.online` | `broadcaster_user_id` | none |
| `stream.offline` | `broadcaster_user_id` | none |
| `channel.follow` (v2) | `broadcaster_user_id`, `moderator_user_id` | `moderator:read:followers` from the moderator named in the condition. |

### How `channel.chat.message` works for one bot across N broadcasters

The condition is a pair. `broadcaster_user_id` is the channel to watch and `user_id` is the account doing the reading. Here `user_id` is the shared bot on every subscription, and `broadcaster_user_id` varies per tenant.

So each additional channel is one more subscription with the same `user_id` and a new `broadcaster_user_id`. The bot's grant of `user:read:chat` plus `user:bot` happens once, globally, and the per-channel permission is the broadcaster's `channel:bot`.

That is what makes onboarding a channel require no new bot-side authorization, and what makes the bot's identity genuinely shared rather than configured N times.

### The onboarding scope set

The broadcaster's authorization-code flow requests:

| Scope | Why |
|---|---|
| `channel:bot` | lets the shared bot read and write in their chat |
| `channel:read:redemptions` | channel-point redemption events |
| `channel:manage:redemptions` | updating redemption status, which is the refund path |
| `moderator:read:followers` | follow events, per the note below |
| `moderator:read:chatters` | the viewer-presence poll |

`stream.online` and `stream.offline` need nothing, so a channel that grants nothing at all can still have live and offline detection.

`channel.follow` has a wrinkle. Its condition requires a `moderator_user_id`, and the scope must be held by that moderator. Two routes work:

1. `moderator_user_id` is the broadcaster, who is implicitly their own moderator, and who grants `moderator:read:followers` during onboarding. This is the route the scope set above takes, because it keeps onboarding self-service and does not depend on the broadcaster remembering to mod anyone.
2. `moderator_user_id` is the bot, which requires the broadcaster to actually mod the bot and the bot to have granted `moderator:read:followers` globally. This becomes attractive only if the bot is to be modded anyway, which also satisfies the `channel.chat.message` alternative and would allow dropping `channel:bot`.

---

## 3. Limits, costs, and webhook mechanics

### Cost model

The source is [Managing Subscriptions](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/).

- Every subscription costs 0 or 1.
- Cost 1 covers subscriptions that name a user without that user's authorization, such as `stream.online`.
- Cost 0 covers subscriptions where the required scope has been granted.
- The exception is the important part: "If a user has authorized your application with the required scope, previously cost-1 subscriptions become cost-free."
- `max_total_cost` starts at 10,000 for an application and grows as users authorize.

In practice the per-channel subscription set here is almost entirely authorized, because the broadcaster grants scopes at onboarding, so most subscriptions cost 0. Even counting every subscription as cost 1, 10,000 against a handful of channels is nowhere near a constraint. Subscription cost needs no design accommodation.

### WebSocket limits

Relevant only to a websocket transport, which this server does not use.

- Maximum 3 enabled websocket connections per user token.
- 300 subscriptions per connection.
- `max_total_cost` capped at 10 on websocket transport.

That last number is the quiet reason websocket transport does not scale to a hosted service. Ten cost units in total, against ten thousand.

### Webhook callback requirements

The source is [Handling Webhook Events](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/).

- TLS is required and the endpoint must listen on port 443. There are no alternate ports. DuckDNS plus Let's Encrypt satisfies this.
- The verification challenge arrives on subscribe as `Twitch-Eventsub-Message-Type: webhook_callback_verification`. Echo the `challenge` value back as a plain-text 200 body with a correct `Content-Length`. The subscription enables only after this succeeds.
- The HMAC-SHA256 signature is computed over the concatenation of `Twitch-Eventsub-Message-Id`, `Twitch-Eventsub-Message-Timestamp` and the raw request body, keyed by the configured secret, and compared with a timing-safe comparison.
  - The secret must be 10 to 100 ASCII characters.
  - The raw body is required, so body parsing must preserve it. `express.json()` with a `verify` callback capturing the buffer, applied only to the webhook route, is how this server does it.
- Deduplication is on `Twitch-Eventsub-Message-Id`. Twitch states plainly that "you may receive a notification twice", so a bounded-set dedup on that header is required.
- The response deadline is "within a few seconds". Repeated slowness moves the subscription to `notification_failures_exceeded` and Twitch revokes it.
  - The docs explicitly recommend "writing the event to temporary storage and processing the notification after responding". That is a hard rule here. The webhook handler enqueues and returns 2xx, and never processes inline.
- The subscription creation rate limit is 100 requests per minute on `POST /helix/eventsub/subscriptions` ([Create EventSub Subscription](https://dev.twitch.tv/docs/api/reference#create-eventsub-subscription)). At roughly four subscriptions per channel this is irrelevant at this size, but a bulk re-subscribe across many channels is paced.

---

## 4. Chat send path

The endpoint is `POST https://api.twitch.tv/helix/chat/messages` with `broadcaster_id`, `sender_id` and `message`.

For a bot sending into N channels with an app access token, the requirement mirrors the read path exactly:

- `user:write:chat` from the sending user, which is the bot, plus
- `user:bot` from the sending user, plus
- either `channel:bot` from the broadcaster, or moderator status in that channel.

Sources: [Scopes](https://dev.twitch.tv/docs/authentication/scopes/) and [Authenticating and Setting up EventSub](https://dev.twitch.tv/docs/chat/authenticating/).

That symmetry is convenient, because the same broadcaster grant of `channel:bot` unlocks both reading and writing, so onboarding needs no separate consent for the two directions.

### `chat:edit` against `user:write:chat`

The [API reference](https://dev.twitch.tv/docs/api/reference#send-chat-message) for Send Chat Message describes authorization in terms of `chat:edit`, while the [Scopes page](https://dev.twitch.tv/docs/authentication/scopes/) defines `chat:edit` as the IRC scope ("send chat messages to a chatroom using an IRC connection") and `user:write:chat` as the API scope ("send chat messages to a chatroom"). The chat guides consistently use `user:write:chat`.

A live send settled it, and section 6.2 records the result. `user:write:chat` is sufficient and `chat:edit` is not required, so the reference page is stale. Requesting both speculatively would be wrong regardless, because Twitch warns that requesting more scopes than needed can get an application suspended.

A user access token with `user:write:chat` needs no `user:bot` or `channel:bot` at all. The app-token route is what enables the shared-bot-across-N-channels model without per-channel bot tokens.

---

## 5. OAuth

### 5.1 Server onboarding, the authorization code grant

The source is [Getting OAuth Access Tokens](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/).

- Authorize at `https://id.twitch.tv/oauth2/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `scope`, and `state` for CSRF.
- Exchange at `https://id.twitch.tv/oauth2/token` with `client_id`, `client_secret`, `code`, `grant_type=authorization_code` and `redirect_uri`.
- The client secret is mandatory. This flow is "meant for apps that use a server, can securely store a client secret."
- Access tokens expire in about 4 hours, and refresh tokens are returned.
- `force_verify=true` forces a fresh consent screen, which is useful for re-authorization.

### 5.2 Desktop sign-in, and the absence of PKCE

Twitch does not support PKCE. It is not mentioned on the authentication overview, the OAuth tokens page, the OIDC page, or the app-registration page, and a domain-scoped search of `dev.twitch.tv` returns nothing for `code_challenge` or PKCE.

The supported flows are ([Authentication](https://dev.twitch.tv/docs/authentication/)):

| Flow | Intended client |
|---|---|
| Implicit grant | client-side JS or mobile. Returns no refresh token. |
| Authorization code | server apps that can hold a secret |
| Device code | "limited input capabilities or lacks a suitable browser; such as set-top boxes, games, or Electron applications" |
| Client credentials | app access tokens, no user context |

This server uses a server-mediated authorization code flow. The desktop app opens the system browser at the server's sign-in endpoint, Twitch redirects to the server's HTTPS redirect URI, and the server, which is the confidential client holding the secret, exchanges the code, verifies identity, mints its own JWT and refresh token, and hands those back to the app through a custom-scheme deep link.

- The app never holds broadcaster or bot Twitch tokens, only its own API session.
- The Twitch client secret never leaves the server.
- The desktop app implements no Twitch flow itself.
- One client id is enough.

The device code grant was the alternative. Twitch names Electron apps as a target, so a Tauri app would qualify, and public clients need no secret and can refresh without one. It was not taken because the UX is clunkier, refresh tokens are one-time-use and expire after 30 days of inactivity, so a user who does not open the app for a month is signed out, and because "public clients are only limited to the usage of device authorization grant flow", meaning declaring the app public forecloses other flows.

### 5.3 One client id

Twitch's registration guidance is explicit: "Do not share client IDs among applications; each application must have its own client ID" ([Register Your App](https://dev.twitch.tv/docs/authentication/register-app/)).

Under the server-mediated flow the desktop app is not an OAuth client at all. It never talks to `id.twitch.tv`, only to this server, which is the single Twitch application. So one client id, registered as a confidential server app. Adopting the device code grant later would make the desktop a genuine second OAuth client needing its own public client id and a separate registration.

### 5.4 Redirect URI rules

The [registration page](https://dev.twitch.tv/docs/authentication/register-app/) says only to "Set OAuth Redirect URLs to the callback URL that your app uses for authorizations". It does not document whether HTTPS is mandatory, whether `http://localhost` is permitted, whether matching is exact, or how many URIs an app may register. Section 6.3 records what measurement showed.

The DuckDNS hostname is baked into the registered redirect URI, so moving to a real domain later means re-registering redirect URIs in the Twitch console.

---

## 6. Measured results

Answers obtained by doing rather than by reading.

### 6.1 The Twitch CLI cannot trigger `channel.chat.message`

Verified against two independent sources, the [CLI event command docs](https://dev.twitch.tv/docs/cli/event-command) and the [CLI repository's `docs/event.md`](https://github.com/twitchdev/twitch-cli/blob/main/docs/event.md). Neither lists any chat-message event among the triggerable types.

What it does cover is `streamup` for `stream.online`, `streamdown` for `stream.offline`, redemptions, `-r revoked` for revocation deliveries, and `verify-subscription` for the challenge check. Signing is `-s`, under the same 10 to 100 ASCII secret rule the webhook enforces.

The consequence is load-bearing. The CLI is a complement rather than the development loop, and `npm run dev:event -w server` signs with the same function the handler verifies with. Either way there is one ingest implementation. No websocket transport was ever built for this server, and none will be.

### 6.2 `user:write:chat` is sufficient and `chat:edit` is not required

Settled by a live send. The bot account granted exactly:

```
["user:bot", "user:read:chat", "user:write:chat"]
```

`chat:edit` was neither requested nor granted. A `POST /helix/chat/messages` on an app access token, with the broadcaster having granted `channel:bot`, returned `is_sent: true` and the message appeared in chat.

So the [API reference](https://dev.twitch.tv/docs/api/reference#send-chat-message) page's mention of `chat:edit` is stale, and the scopes page and the chat guides are correct. The scope list in `server/src/twitch/oauth.ts` needs no change.

### 6.3 Redirect URIs and webhook callbacks follow different rules

Two separate rules, and conflating them wastes a lot of time.

The OAuth redirect URI accepts plaintext loopback. All three flows completed against `http://localhost:3000/auth/twitch/callback` registered in the console, with no HTTPS requirement and no port restriction.

The EventSub webhook callback requires HTTPS on port 443, enforced at creation:

| Callback offered | Twitch's answer |
|---|---|
| `http://localhost:3000/eventsub/webhook` | **400**, "callback must provide valid https callback with standard port in creation request" |
| `https://localhost/eventsub/webhook` | **202** accepted, `webhook_callback_verification_pending` |

The second is the more interesting result. Twitch validates the scheme and port only at creation time and does not resolve the host, so the subscription is accepted and then dies at the challenge, because nothing reachable answers.

The consequence is that live EventSub cannot be activated from a development machine. It needs a publicly reachable HTTPS endpoint on port 443, which is the VPS with DuckDNS and Caddy, or a tunnel. Everything outbound (app token, chat send, rewards) works from localhost, so only the inbound half is blocked.

Also confirmed: one registered redirect URI serves all three flows, because the flow travels in the server-issued `state`.

### 6.4 Existing production rewards are app-manageable

`HelixApi.listCustomRewards` with `only_manageable_rewards=true`, against the owner's real channel, returned the five rewards in production use:

```
Skip song queue (200), Pick the game (50000), MS paint (5000, disabled),
Song Request (100), Add a quote (1000)
```

`only_manageable_rewards=true` returns exactly the rewards created by the requesting client id. That these appear means they were created through the API under this same client id, so their redemption status is already updatable and the refund path works on them as they stand.

A full create, list and delete cycle was also exercised on a throwaway reward and behaved correctly.

The design consequence is that "rewards are created by the app at onboarding" is not required for this channel's existing rewards. It remains the right rule for new rewards and for any channel whose rewards were made in the dashboard, since those genuinely cannot be managed. Reward-id capture at onboarding still replaces title-string routing.

Not yet proven: an actual `PATCH .../redemptions` status update, which needs a real redemption to exist. The ownership precondition, which was the part in doubt, is settled.

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
