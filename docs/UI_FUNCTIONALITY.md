# Desktop app functionality inventory

The complete catalog of functionality the desktop app surfaces, grounded in the running API. It is the *what*, not the *how*. The section grouping is by domain, not by page, and nothing here prescribes a screen count or a component.

`docs/APP_COVERAGE_LEDGER.md` is the item-by-item record of what is actually built against these sections. Where this catalog and `shared/src/contract/` disagree, the contract wins.

**Status words used below**

- **Built.** In the app, exercised by tests, reachable by the owner.
- **Deferred.** A real gap, named, with what it would take.
- **Future.** Space left deliberately, not designed and not built.

## 0. Hard context

- **Windows desktop app** (Tauri 2 shell, React and TypeScript inside a system webview). Standard desktop resolutions, resizable window, dark theme only. A light theme was deferred, so there is deliberately no second palette to keep in step.
- **One signed-in streamer per session.** The signed-in user's identity is the channel selector. There is no channel picker and no admin view of other channels. Multi-editor access is future.
- **The product's name is pending a rebrand.** The name lives in one constant so the swap is a single edit.
- **The audience is streamers.** The app often runs on a second monitor while streaming, with OBS and a game running, so glanceability and low visual noise matter more than density.
- **Live-first.** A WebSocket feed pushes real-time events, and the app should feel like a live companion rather than a settings panel that happens to refresh.

## 1. What this product is

A hosted Twitch bot the streamer installs a desktop app to control. The bot lives on a server and is always on, and the app is its remote control and dashboard. Feature domains: AI chat responses through Claude, song requests via channel points and Spotify, quotes, custom commands, auto-emote replies, viewer and chat analytics, channel-point reward management, and Discord go-live notifications.

## 2. Global state and connection concepts (every screen inherits these)

| State | Source | UI must handle |
|---|---|---|
| Server unreachable | any request failing, or the socket closing | distinguishable from "bot fine, you are offline". This is the app's problem, not the bot's. Built. |
| Signed out or session expired | 401s | route to sign-in. Sessions auto-refresh via refresh token, so expiry is rare but real. Built. |
| Channel status `active` | `/me` | normal operation. Built. |
| Channel status `needs_reauth` | `/me` | prominent and actionable. "Twitch revoked access, reconnect", with the reconnect action. Built. |
| Channel status `disconnected` | `/me` | bot deliberately off for this channel. Built. |
| Stream live or offline, with uptime when live | live feed `channel.status` plus streams data | ambient indicator, and what drives the "while streaming" feel. Built. |
| Spotify connected or not | `spotifyConnected` on `/me` | song features degrade gracefully with a connect action, never error walls. Built. |
| Rate limited | 429 plus `RateLimit-*` headers | rare in normal use, non-scary retry messaging. Built. |

The error envelope is uniform, `{ok:false, error:{code, message}}`, so there is one error presentation pattern and every screen reuses it.

## 3. Auth and onboarding flows

- **Sign in with Twitch.** Built. The app opens the system browser to the server's sign-in URL, and after Twitch consent the app receives its session as a JWT plus a refresh token. The app never sees Twitch credentials. There is a signed-out state, a waiting-for-browser state, and a failure and retry path.
- **Sign out.** Built, both the local session discard and the server-side refresh-token revocation.
- **Channel onboarding.** Built. A server-mediated browser flow over five Twitch permissions, for a signed-in user whose channel is not onboarded yet. It explains what the bot will do, launches the browser flow, and reflects completion live. This is a new streamer's first-run experience and is treated as a first-class flow rather than an edge case.
- **Spotify connect and disconnect.** Built, both in the system browser. Optional per channel, and everything song-related keys off it.
- **Declined-permissions handling.** Deferred in the app. The server records declined scopes, but nothing in the contract exposes which features are degraded, so the app cannot name them yet. A contract field has to land first.

## 4. Dashboard and live domain

- **Bot presence.** Built. Server health plus this channel's session state.
- **Live indicator and uptime.** Built. Stream start and end are tracked with real Twitch stream ids, so it survives deploys.
- **Live event feed.** Built, over the WebSocket at `/api/v1/live`, with the JWT supplied at connect and a 30-second heartbeat.
  - `chat.message` carries login, display name, text, roles (broadcaster, mod, vip, sub) and a timestamp. It is every chat message, bot-relevant or not, so the app can show live chat.
  - `song_queue.updated` says the queue changed.
  - `channel.status` carries live and offline transitions.
  - The feed handles connection drop and reconnect, where missed events are simply missed because the feed is ambient rather than a log of record, and it has an idle stream-offline quiet state.
- **Recent AI activity.** AI replies are visible in the chat feed itself, because the bot is a chatter. A dedicated AI-replies view is future.

## 5. Commands domain

Built.

- **List**, paginated, carrying name, response text, permission level (`everyone`, `vip`, `mod`, `broadcaster`) and the handler-backed flag.
- **Two kinds, one list.** Static commands are streamer-authored, mapping a name to a text reply, and are fully editable. Handler-backed commands are built-in behaviors such as `!uptime`, `!skipsong` and `!advice`, 17 of them today, whose level is declared in code and whose response is behavior rather than text. The list distinguishes them: static gets full CRUD, and handler-backed is visible and explained but not editable. Level editing for handler-backed commands is future.
- **Create, edit and delete static commands.** The name is validated against the server's own schema, including the leading `!` convention and the length and character rules. The response is capped at 500 characters. Uniqueness is per channel, so the same name can exist on another streamer's channel.
- **Empty state**, because a fresh channel has zero static commands.

## 6. Emotes domain

Built. Exact-match trigger and reply pairs, with list, create and delete. There is no edit, because delete and create is the model. A trigger fires only when a chat message equals it exactly. The design question here is discoverability next to commands, not complexity.

## 7. Quotes domain

Built.

- List, paginated, with per-channel numbering. Fetch by number, fetch a random one, create with text and an optional attribution, and delete. Numbering is stable and channel-scoped, and deletions leave gaps by design, because quote #7 stays #7 forever.
- Quotes also arrive through the "Add a quote" channel-point redemption in chat, so the app is a management view over the same data.

## 8. Songs domain

- **Queue view.** Built. Ordered pending requests carrying track, artist, requester and requested-at, updated in real time by `song_queue.updated`.
- **Drop the head of the queue.** Built, at `DELETE /songs/head`. A mod-sensitive action that also exists in chat as `!skipsong`.
- **Skip the currently playing track.** Built, at `POST /songs/skip`. This is a different song from the one Drop acts on, so the two controls are labeled for the track each acts on.
- **Song requests on and off.** Built, at `POST /songs/toggle`. It enables and disables the Twitch rewards themselves, so viewers cannot redeem what is disabled. Partial failure is reported honestly, meaning the setting changed but the reward is still visible.
- **How songs enter.** Channel-point redemption only. The app deliberately has no "add song" action, because a track without a redemption has no points behind it. That is policy, not a gap.
- **The two-stage queue.** Requests wait in the bot's queue and hand off to Spotify's queue only as the current track ends. The screen teaches this with two labels and one meta line rather than prose.
- **Spotify connection state** drives the whole domain. Not connected gets an explanation and a connect action, and connected shows the account and the linked-since date.
- **Requests playlist.** Built, and a core feature by owner decision. A toggle saves requested songs to a playlist, and when on the streamer names one. An existing playlist is appended to with database-side dedup, a missing one is created, and where creation is impossible the step is skipped gracefully. `docs/DECISIONS.md` decision 9 carries the decision itself.
- `!lastsong` and `!song` exist as chat commands, and the queue view is their app-side counterpart.

## 9. AI domain

- **AI on and off per channel.** Built, at `PATCH /me/settings {aiEnabled}`. The master switch, also togglable from chat with `!ai on|off` at mod level. It fails closed, so database trouble leaves the AI silent, which is worth a quiet note in the copy.
- **How it triggers**, as explainer content rather than controls. Mentions of the bot's name, where commands starting with `!` always win, plus the `!advice` and `!roast` game commands.
- **Per-role stream limits.** Built, both viewing and editing. Each viewer gets N AI requests per stream by their highest role, across everyone, vip, sub and mod, with the broadcaster unlimited. The usage counter appears in chat only when three or fewer remain. A per-channel threshold is future, and the AI pane leaves space for it.
- **Game-command images.** `waifu` and `fursona` produce deterministic images. A "reset everyone's images" control is future, and today the reset is an env salt bump.

## 10. Analytics domain

Built. The data begins in August 2026, so there is no deep history.

- **Summary**, at `/analytics/summary`, carrying lifetime viewers known, total messages, and top chatters. Chat totals are real and increment live.
- **Streams history**, with start, end and duration per stream. There is no analytics history from before the bot started recording, so empty and young states are the normal launch experience and are designed as first-class rather than apologetic.
- **Per-stream against lifetime framing** exists in the data, with `chat_totals` lifetime and per-stream from streams plus messages. Three range chips render it over one dataset. Richer queries need new endpoints, and every view that would need one is flagged.
- **Viewer detail**, meaning per-viewer totals, follow date and watch time from viewing sessions, exists in the data. The endpoints are deferred and no screen asks for it yet.

## 11. Settings domain

- **AI.** Built. Enabled, plus limits view and edit. The counter threshold is future.
- **Discord go-live notification.** Built. A configured-or-not boolean, because the URL is write-only by design. It is a capability, so the UI can set, replace and clear it but never display the stored value.
- **Songs and playlist.** Built. The reward toggle and the playlist controls, covered in section 8.
- **Spotify.** Built. Connect, disconnect and status.
- **Stream Deck API keys.** Built. List, showing the identifying prefix and created-at, create with the secret shown exactly once, and revoke. Keys work only on the songs endpoints, and the UI says so.
- **Managed rewards status.** Built. The three bot-managed channel-point rewards (Song Request, Skip queue, Add a quote) with their bound state. Personal rewards are never touched, and the copy says so.
- **App and updates.** Partially built. The running version is read from the build so it cannot drift. The updater's verdict is not given to this screen, so no "up to date" claim is made. A release-notes link is future.
- **Bug report.** Deferred. No report endpoint exists, and a button promising to attach version and logs while doing neither would be a lie in the one card whose whole job is trust.
- **Account.** Built. Signed-in identity, sign out, and disconnect channel as a two-click dangerous action. A "channel connected on" date is deferred, because `ChannelSummary` has no such field.

## 12. Empty and degraded states worth designing deliberately

A fresh channel with no commands, emotes, quotes or analytics. A stream offline, which is most of the time. Spotify not connected. AI off. `needs_reauth`. Server unreachable. A brand-new install before sign-in. The product's default state is "offline streamer, quiet bot", and the design is pleasant there rather than only during the live moments.

## 13. Explicitly out of scope for the app

No channel picker and no multi-channel admin. No adding songs without redemptions. No viewing another channel's data, which is structurally impossible server-side. No management of the bot's own Twitch account. No server ops such as deploys or backups. This is a streamer's tool, not an admin console.

## 14. Future space, left rather than built

Editors and roles for a streamer's team. A per-channel usage-counter threshold. An image-reset control. Richer analytics dashboards. A reorderable queue. Chat-retention settings. Localization.

---

Every deferred item above is a small, known server addition, and none of them change the architecture. The API contract lives in `shared/src/contract/` and is the single source of truth for shapes. This document defers to it wherever they disagree.
