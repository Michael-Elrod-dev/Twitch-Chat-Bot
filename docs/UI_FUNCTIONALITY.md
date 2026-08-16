# Desktop App — UI Functionality Inventory

**Date:** 2026-08-16 · **Author:** Lead (Fable 5) · **Audience:** Claude Design (design authority), then the implementation engineer
**Status of ground truth:** every item marked ✅ is live in production and exercised; items marked 🔶 are small server additions the design may assume (they'll be built before or alongside the screen that needs them); items marked 🔮 are future features to leave *space* for, not design now.

---

## 0. How to read this document

You (Claude Design) **own the design** — layout, components, navigation, visual language, interaction patterns are yours. This document is the *what*, not the *how*: the complete catalog of functionality the app must surface, grounded in the real, running API. Nothing here prescribes a screen count or a component; the section grouping below is by *domain*, not by intended page.

Hard context you must design within:
- **Windows desktop app** (Tauri 2 shell, React + TypeScript inside a system webview). Standard desktop resolutions; resizable window; light/dark worth supporting from day one.
- **One signed-in streamer per session.** The signed-in user's identity *is* the channel selector — there is no channel picker, no admin view of other channels. (Multi-editor access is 🔮.)
- **The product's name/brand is PENDING a rebrand** — use a neutral placeholder everywhere (`{{APP_NAME}}`); do not design around the legacy name "AlmostHadAI".
- **The audience is streamers**: the app will often run on a second monitor *while streaming* (OBS + game running). Glanceability and low visual noise matter more than density.
- **Live-first**: a WebSocket feed pushes real-time events; the app should feel like a live companion, not a settings panel that happens to refresh.

## 1. What this product is

A hosted Twitch bot the streamer installs a desktop app to control. The bot lives on a server (always on); the app is its remote control and dashboard. Feature domains: AI chat responses (Claude-powered), song requests via channel points + Spotify, quotes, custom commands, auto-emote replies, viewer/chat analytics, channel-point reward management, Discord go-live notifications.

## 2. Global state & connection concepts (every screen inherits these)

| State | Source | UI must handle |
|---|---|---|
| Server unreachable | any request failing / WS closed | distinguishable from "bot fine, you're offline" — this is the app's problem, not the bot's |
| Signed out / session expired | 401s | route to sign-in; sessions auto-refresh via refresh token, expiry is rare but real |
| Channel status: `active` | `/me` | normal operation |
| Channel status: `needs_reauth` ✅ | `/me` | prominent, actionable: "Twitch revoked access — reconnect" with the reconnect action |
| Channel status: `disconnected` | `/me` | bot deliberately off for this channel |
| Stream live / offline (+ uptime when live) ✅ | live feed `channel.status` + streams data | ambient indicator; drives the "while streaming" feel |
| Spotify connected / not 🔶 (surfacing on `/me`) | connection state exists server-side | song features degrade gracefully with a connect action, never error walls |
| Rate limited | 429 + `RateLimit-*` headers ✅ | rare in normal use; non-scary retry messaging |

Error envelope is uniform (`{ok:false, error:{code, message}}`) — design one error presentation pattern and reuse it.

## 3. Auth & onboarding flows

- **Sign in with Twitch** ✅: app opens the *system browser* to the server's sign-in URL; after Twitch consent the app receives its session (JWT + refresh). The app never sees Twitch credentials. Design: a signed-out state, a "waiting for browser" state, and failure/retry.
- **Sign out** ✅ (local session discard; server refresh-token revocation 🔶 trivial).
- **Channel onboarding** ✅ (server-mediated browser flow, 5 Twitch permissions): for a signed-in user whose channel isn't onboarded yet — explain what the bot will do, launch the browser flow, reflect completion live. The friend's first-run experience; treat it as a first-class flow, not an edge case.
- **Spotify connect** ✅ (browser chain, one click) / **disconnect** 🔶: optional per channel; everything song-related keys off it.
- **Declined-permissions handling** ✅ server-side: if a streamer declined optional scopes, the affected features are named — surface which features are degraded and why, with a re-consent action.

## 4. Dashboard / live domain

- **Bot presence**: server health + this channel's session state ✅.
- **Live indicator + uptime** ✅ (stream start/end tracked with real Twitch stream ids; survives deploys).
- **Live event feed** ✅ over WS (`/api/v1/live`, JWT at connect, heartbeat 30s):
  - `chat.message` — login, display name, text, roles (broadcaster/mod/vip/sub), timestamp. (This is every chat message, bot-relevant or not — the app can show live chat.)
  - `song_queue.updated` — the queue changed (fetch or carry payload).
  - `channel.status` — live/offline transitions.
  - Design for: connection drop/reconnect (missed events are simply missed — the feed is ambient, not a log of record), and an idle "stream offline" quiet state.
- **Recent AI activity**: AI replies are visible in the chat feed itself (the bot is a chatter); no separate API 🔮 if design wants a dedicated AI-replies view.

## 5. Commands domain ✅

- **List** (paginated): name, response text, permission level (`everyone | vip | mod | broadcaster`), handler-backed flag.
- **Two kinds, one list**: *static* commands (streamer-authored name → text reply; fully editable) and *handler-backed* commands (built-in behaviors — `!uptime`, `!skipsong`, `!advice`, 17 today; their *level* is declarative in code, their response is behavior, not text). Design must distinguish: static = full CRUD; handler-backed = visible, explained, not editable (level editing 🔮).
- **Create / edit / delete static commands**: name (validated: `!`-prefixed convention, length/charset rules exist server-side), response (≤500 chars), level. Uniqueness per channel enforced (same name can exist on another streamer's channel — irrelevant to UI but explains errors).
- Empty state matters: a fresh channel has zero static commands.

## 6. Emotes domain ✅

Exact-match trigger → reply pairs. List / create / delete (no edit — delete+create is the model). Trigger fires only when a chat message *equals* the trigger. Small domain; the design question is discoverability next to commands, not complexity.

## 7. Quotes domain ✅

- List (paginated, per-channel numbering: quote #1, #2…), fetch by number, **random**, create (text + optional attributed-to), delete. Numbering is stable and channel-scoped; deletions leave gaps (by design — quote #7 stays #7 forever).
- Quotes also arrive via channel-point redemption in chat ("Add a quote" reward) — the app is a management view over the same data.

## 8. Songs domain

- **Queue view** ✅: ordered pending requests (track, artist, requester, requested-at). Real-time via `song_queue.updated`.
- **Skip head** ✅ (`DELETE /songs/head`) — mod-sensitive action; also exists as chat `!skipsong`.
- **Song requests on/off** ✅ (`POST /songs/toggle`): enables/disables the *Twitch rewards themselves* (viewers can't redeem what's disabled). Partial-failure honesty exists server-side (setting changed but reward still visible) — surface it if reported.
- **How songs enter**: channel-point redemption only — the app deliberately has **no "add song" action** (a track without a redemption has no points behind it; this is policy, not a gap).
- **Two-stage queue concept the UI should teach gently**: requests wait in the bot's queue and hand off to *Spotify's* queue only as the current track ends. (This confused even the owner; the design should make the pending→Spotify handoff legible.)
- **Spotify connection state** drives the whole domain: not-connected → explain + connect action; connected 🔶 (show account?/connected-since — minor server addition).
- **Requests playlist — owner-elevated core feature** (foundation ✅, controls 🔶, full UX spec in `PHASE1_DESIGN.md` §3): toggle "save requested songs to a playlist"; when on, name a playlist — existing gets appended (deduped), missing gets created where possible, creation-impossible is skipped gracefully. Design the setting + status; the create-if-missing plumbing is backend work flagged for the same milestone.
- `!lastsong`/`!song` etc. exist as chat commands; the queue view is their app-side counterpart.

## 9. AI domain

- **AI on/off per channel** ✅ (`PATCH /me/settings {aiEnabled}`): the master switch; also togglable from chat (`!ai on|off`, mod-level). Fail-closed semantics (DB trouble = AI silent) — worth a quiet note in design copy.
- **How it triggers** (explainer content, not controls): mentions of the bot's name (commands starting `!` always win), plus `!advice` / `!roast` game commands.
- **Per-role stream limits** (view ✅ via defaults; editing 🔶): each viewer gets N AI requests per stream by their highest role (everyone/vip/sub/mod/broadcaster-unlimited). Usage counter appears in chat only when ≤3 remain (threshold is a future per-channel setting 🔮 — leave space in AI settings).
- **Game-command images**: `waifu`/`fursona` deterministic images; a **"reset everyone's images"** action 🔮 (today an env salt bump — a designed control is future).

## 10. Analytics domain ✅ (data begins 2026-08; no deep history exists)

- **Summary** (`/analytics/summary`): lifetime viewers known, total messages; top chatters (chat totals are real and increment live).
- **Streams history**: start/end/duration per stream (from now on — the legacy era left no analytics history, so empty/young states are the *normal* launch experience; design them as first-class, not apologetic).
- **Per-stream vs lifetime** framing exists in data (`chat_totals` lifetime, per-stream via streams+messages) — richer queries are 🔶 as design demands them; don't limit ambition to today's single summary endpoint, but flag every view that needs a new endpoint.
- Viewer detail (per-viewer totals, follow date ✅ in data, watch-time via viewing sessions ✅ in data) — endpoints 🔶.

## 11. Settings domain

- **AI**: enabled ✅; limits view/edit 🔶; counter threshold 🔮.
- **Discord go-live notification**: configured-or-not boolean ✅ (the URL is write-only by design — it's a capability; the UI can set/replace/clear ✅ but never display the stored value).
- **Songs/playlist**: reward toggle ✅; playlist controls 🔶 (see §8).
- **Spotify**: connect ✅ / disconnect 🔶 / status 🔶.
- **Stream Deck API keys** ✅: list (prefix-identifiable, created-at), create (secret shown ONCE — design the copy-now moment), revoke. Keys work only on song endpoints — say so.
- **Managed rewards status** 🔶 (data exists): the three bot-managed channel-point rewards (Song Request / Skip queue / Add a quote) with their bound state; personal rewards are never touched (trust-building copy opportunity).
- **App/updates**: auto-update status + version (Tauri updater), release notes link 🔮.
- **Bug report**: in-app report action (Sentry/GitHub plumbing is implementation's problem; design the affordance: description + auto-attached version/logs disclosure).
- **Account**: signed-in identity, sign out, disconnect channel (dangerous action) 🔶.

## 12. Empty/degraded states worth designing deliberately

Fresh channel (no commands/emotes/quotes/analytics) · stream offline (most of the time!) · Spotify not connected · AI off · `needs_reauth` · server unreachable · brand-new install pre-sign-in. The product's *default* state is "offline streamer, quiet bot" — the design should be pleasant there, not just during the exciting live moments.

## 13. Explicitly out of scope for the app

No channel picker/multi-channel admin · no adding songs without redemptions · no viewing other channels' data (structurally impossible server-side) · no bot Twitch-account management · no server ops (deploys/backups) — this is a streamer's tool, not an admin console.

## 14. Future space (leave room, don't design now)

Editors/roles for a streamer's team · per-channel usage-counter threshold · image-reset control · richer analytics dashboards · reorderable queue · chat-retention settings · localization.

---

*Implementation note for the engineer (not design-relevant): every 🔶 is a small, known server addition; nothing 🔶 changes architecture. The API contract lives in `shared/src/contract/` and is the single source of truth for shapes; this document defers to it wherever they disagree.*
