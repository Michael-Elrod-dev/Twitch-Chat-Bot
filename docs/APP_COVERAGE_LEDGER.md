# Desktop App — Coverage Ledger

**Date:** 2026-08-17 · **Author:** Implementation engineer · **Against:** `docs/UI_FUNCTIONALITY.md`
**Status:** FINAL — this document replaces the deleted design handoff as the record of what the app does.
**Purpose:** the app is feature-complete as of the final screens tranche. This is the item-by-item
account of that claim — what is built, what is deliberately not, and what is a genuine gap.

Read `UI_FUNCTIONALITY.md` alongside it: the section numbers below are that document's. Where the
catalog and `shared/src/contract/` disagreed, the contract won and the row says so.

**The design handoff (`design_handoff_bot_desktop_app/`) was deleted on 2026-08-17**, which was its
stated exit criterion — it was working reference, gitignored and never committed. Nothing is lost by
its going: the design ids it defined are all listed below with their build status, every place the
implementation departed from it is itemised with the reason in Deviations, and the per-screen design
reasoning lives in the components' own comments. The owner retains the source zip.

**Status key**
- **BUILT** — in the app, exercised by tests, reachable by the owner.
- **BY DESIGN ABSENT** — deliberately not built, with the reason. Not a gap.
- **DEFERRED** — a real gap, named, with what it would take.

---

## §2 Global state & connection concepts

| Item | Status | Where / note |
|---|---|---|
| Server unreachable, distinct from "you're offline" | BUILT | `live/connection.ts` state machine drives the pill and `4b` independently of channel status. The two are never conflated — asserted in `dashboard.test.tsx`. |
| Signed out / session expired | BUILT | `useAuth` phases; `withFreshSession` refreshes per call. |
| `status: active` | BUILT | Header pill. |
| `status: needs_reauth` | BUILT | `4a` banner + Reconnect, TWITCH tile pulsing clay, bot switch inert. |
| `status: disconnected` | BUILT | Account card reads "Channel disconnected"; the Disconnect button becomes inert. New this tranche. |
| Stream live/offline + uptime | BUILT | Ticks locally, re-synced on every `channel.status`. |
| Spotify connected / not | BUILT | `3c` vs `4c`, and the `5a` card. `spotifyConnected` on `/me` feeds the dashboard tile. |
| Rate limited, non-scary | BUILT | `errorPresentation.ts` → inline, with `Retry-After` seconds. |
| One error presentation for the envelope | BUILT | `errorPresentation.ts`, one module, used by every screen. |

## §3 Auth & onboarding

| Item | Status | Where / note |
|---|---|---|
| Sign in with Twitch (system browser) | BUILT | `3g`, with the reachability pill. |
| Waiting-for-browser state | BUILT | `5d`. |
| Failure / retry | BUILT | Reopen + Cancel. |
| Sign out (local discard) | BUILT | Account card. |
| Sign out (server refresh-token revocation) | BUILT | `POST /auth/app/logout` revokes the session server-side. |
| Channel onboarding, five scopes | BUILT | `3h`. |
| Spotify connect | BUILT | `4c` and `5a` both start the chain in the system browser. |
| Spotify disconnect | BUILT | `DELETE /api/v1/spotify`; switches song requests off with the account. |
| Declined-permissions handling, features named | DEFERRED | The server records declined scopes; nothing in the contract exposes *which* features are degraded, so the app cannot name them. Needs a contract field before a screen can be honest about it. |

## §4 Dashboard / live

| Item | Status | Where / note |
|---|---|---|
| Bot presence (server health + session state) | BUILT | Status strip, five tiles. |
| Live indicator + uptime | BUILT | Header pill. |
| `chat.message` feed | BUILT | Ambient, capped in memory, no backfill — as specified. |
| `song_queue.updated` | BUILT | Refetches. `queueLength` now rides the event but is deliberately not used to render rows: a length is not a list. |
| `channel.status` | BUILT | Drives pill, clock and dot animations. |
| Connection drop / reconnect | BUILT | `4b`, and the empty copy states plainly that missed lines stay missed. |
| Idle "stream offline" quiet state | BUILT | `2b`, including the last-stream caption. |
| Dedicated AI-replies view | BY DESIGN ABSENT | Marked 🔮 in the catalog; AI replies are visible in the chat feed because the bot is a chatter. |

## §5 Commands · §6 Emotes · §7 Quotes

| Item | Status | Where / note |
|---|---|---|
| Commands list, two kinds, one list | BUILT | `2c`. Handler-backed rows are locked with a `BUILT IN` chip. |
| Create / edit / delete static commands | BUILT | `4e` editor; validation runs the server's own schemas. |
| Level editing for handler-backed commands | BY DESIGN ABSENT | 🔮 in the catalog; the declaration in code is the source of truth. |
| Commands empty state | BUILT | `4d`, plus the built-ins-that-already-work card. |
| Emotes list / create / delete, no edit | BUILT | `3a`, composer as the first row. |
| Quotes list / random / create / delete | BUILT | `3b`; retired numbers render as gaps with the footnote saying why. |

## §8 Songs

| Item | Status | Where / note |
|---|---|---|
| Queue view (track, artist, requester, requested-at) | BUILT | `3c`, grid `28px 1fr 200px 110px 48px`. |
| Real-time via `song_queue.updated` | BUILT | Shell refetches; the screen shares that one path. |
| Skip head | BUILT | `DELETE /songs/head` removes the next *waiting* request, so its control is "Drop" on the queue's head row — deliberately not beside the playing track, which is a different song. |
| Song requests on/off | BUILT | Header toggle on `3c` and the row on `5a`; disabled when Spotify is absent. |
| Partial-failure honesty (setting saved, reward still visible) | BUILT | Reported inline on the row, never as a toast. |
| No "add song" action | BY DESIGN ABSENT | Policy, not a gap — the policy card says so in the streamer's words. |
| Two-stage queue taught gently | BUILT | Two labels and one meta line; no prose, per the handoff's instruction. |
| Spotify connection state drives the domain | BUILT | `3c` / `4c`. |
| Requests playlist: toggle, name, create-if-missing, skip gracefully | BUILT | `5a`; the name resolves at save, and the sage line says what actually happened rather than "Saved". |
| Now-playing card | BUILT | `GET /songs/playing`; paused keeps the track and freezes the bar. |
| Skip the *currently playing* Spotify track | BUILT | `POST /api/v1/songs/skip`, key-reachable, Skip button beside now-playing. `skipTrack()` finally has a caller. **Consequence:** skipping outside the ten-second handoff window plays one of the streamer's own tracks before the next request — nothing is lost and the order holds. |

## §9 AI

| Item | Status | Where / note |
|---|---|---|
| AI on/off per channel | BUILT | `3e`, and it reaches the running bot without a restart (settings-cache fix, Task 0). |
| How it triggers (explainer) | BUILT | The row's description, verbatim from the design. |
| Per-role stream limits, view | BUILT | Opens on the values the limiter actually enforces, not a proposal. |
| Per-role stream limits, edit | BUILT | Steppers; whole set sent every time; bounds read off the schema. |
| Broadcaster unlimited | BUILT | Rendered as the word, in sage. No field, deliberately. |
| Usage-counter threshold as a setting | BY DESIGN ABSENT | 🔮 in the catalog. Space left in the AI pane. |
| Game-command images / reset-everyone's-images | BY DESIGN ABSENT | 🔮; today an env salt bump. |

## §10 Analytics

| Item | Status | Where / note |
|---|---|---|
| Summary: viewers known, total messages | BUILT | `3d`, four stat cards. |
| Top chatters | BUILT | Bars scaled to the busiest chatter, not the total. |
| Streams history: start/end/duration | BUILT | Streams table; an open stream reads "live". |
| Young/empty states as first-class | BUILT | Real small numbers, a plain sentence, and a footer that counts the real streams. No apology anywhere — asserted as a negative in `analytics.test.tsx`. |
| Per-stream vs lifetime framing | BUILT | Three range chips over one dataset. `this_stream` now resolves through the same function the dashboard uses, so the two screens cannot disagree. |
| "Since <date>" header | BUILT — **relabelled** | Reads "last stream <date>". The contract has no earliest-stream field, and `lastStreamAt` is the most recent one; labelling it "since" claimed the figures began after most of the data they include. |
| Viewer detail (per-viewer totals, follow date, watch time) | DEFERRED | The data exists; no endpoint. 🔶 in the catalog, and no screen asks for it yet. |

## §11 Settings

| Item | Status | Where / note |
|---|---|---|
| AI enabled | BUILT | `3e`. |
| AI limits view + edit | BUILT | `3e`. |
| Discord webhook: set / replace / clear, never display | BUILT | `5b`. Write-only is structural: the contract carries a boolean and no route returns the value. |
| Songs reward toggle | BUILT | `5a`. |
| Playlist controls | BUILT | `5a`. |
| Spotify connect / disconnect / status | BUILT | `5a`, sharing the songs screen's card component. |
| Stream Deck keys: list, create (show once), revoke | BUILT | `3f`; the key renders exactly once and closing discards it, pinned by test. |
| Key scope stated | BUILT | The shield note names the three things a key can do. |
| Managed rewards status + trust copy | BUILT | `5b`. The meta counts what the bot manages rather than claiming to know the streamer's own rewards. |
| App version + auto-update status | BUILT — **partial** | Version is read from the build, so it cannot drift. The `CURRENT` chip states which version is running; the design's "Up to date" claim is not made, because this screen is not given the updater's verdict. |
| Release notes link | BY DESIGN ABSENT | 🔮 in the catalog. |
| Bug report affordance | DEFERRED | Named in the catalog, not in this tranche's scope, and not built. No report endpoint exists, and a button promising to attach version and logs while doing neither would be a lie in the one card whose whole job is trust. |
| Account: identity, sign out | BUILT | `5c`. |
| Account: "Channel connected <date>" | DEFERRED | `ChannelSummary` has no connected-at date. The line renders without one rather than inventing a plausible number from the token's issue time. One contract field would close it. |
| Disconnect channel (dangerous) | BUILT | `DELETE /api/v1/me/channel`. Two-click confirmation; status → `disconnected`; session stopped; the three managed rewards **disabled, never deleted**; all content untouched. **Never exercised against the owner's live channel** — proven in `channelSwitch.test.ts` only. Reconnecting does not re-enable the two rewards it switched off; see the deferred ledger. |

## §12 Empty / degraded states

| State | Status | Where |
|---|---|---|
| Fresh channel (no commands/emotes/quotes/analytics) | BUILT | `4d`, and analytics' real-zeroes rendering. |
| Stream offline | BUILT | `2b`. |
| Spotify not connected | BUILT | `4c`, `5a`. |
| AI off | BUILT | Status tile + `3e`. |
| `needs_reauth` | BUILT | `4a`. |
| Server unreachable | BUILT | `4b`. |
| Brand-new install, pre-sign-in | BUILT | `3g`. |

## §13 Explicitly out of scope — confirmed absent

No channel picker · no adding songs without redemptions · no cross-channel data (structurally
impossible: no route accepts a channel id) · no bot Twitch-account management · no server ops.
All five verified absent from `app/src/`.

## §14 Future space — left, not built

Editors/roles · per-channel counter threshold · image reset · richer analytics · reorderable queue ·
chat retention · localization. None occupy UI; none are stubbed.

---

## Design ids

| Id | Screen | Status |
|---|---|---|
| `1a` | Rail tooltip on hover | BUILT |
| `2a` / `2b` | Dashboard live / offline | BUILT |
| `2c` / `4d` / `4e` | Commands, empty, editor | BUILT |
| `3a` | Emotes | BUILT |
| `3b` | Quotes | BUILT |
| `3c` / `4c` | Songs, Spotify missing | BUILT (this tranche) |
| `3d` | Analytics | BUILT (this tranche) |
| `3e` | Settings · AI | BUILT (this tranche) |
| `5a` | Settings · Songs | BUILT (this tranche) |
| `5b` | Settings · Notifications | BUILT (this tranche) |
| `3f` | Settings · Stream Deck + show-once modal | BUILT (this tranche) |
| `5c` | Settings · Account + danger zone | BUILT (this tranche) |
| `3g` / `5d` / `3h` | Sign in, waiting, onboarding | BUILT |
| `4a` / `4b` | needs_reauth, server unreachable | BUILT |

Every id the handoff defined is accounted for above. `1b` and `1c` are design-canvas variants of the
big-figure type scale, not screens.

---

## Deviations from the design, and why

Each of these is the contract winning over the mock, per the tranche's scope guard.

1. **Skip and Drop are two controls on two different songs (`3c`).** Skip advances Spotify's player
   (`POST /songs/skip`); Drop removes the next waiting request (`DELETE /songs/head`). The design
   drew one control; the contract has two actions, and conflating them would silently delete a
   viewer's request while the streamer believed they skipped what they were hearing. Each label
   names the track it acts on.
2. **Analytics header reads "last stream", not "since".** No earliest-stream field exists.
3. **`5a` playlist line omits "last added 4 minutes ago".** `SpotifyPlaylist` carries no
   last-added timestamp.
4. **`5b` webhook row omits "Set on 2 Aug".** No set-on date is stored or served.
5. **`5b` rewards meta reads "N of 3 bound", not "3 of yours untouched".** The API deliberately
   never enumerates the streamer's own rewards — the trust claim rests on not looking, so the app
   must not print a count of them.
6. **`5c` identity omits the connected-on date.** No such field.
7. **`5c` App card says `CURRENT` without "Up to date".** The updater's verdict is not given to
   this screen.
8. **`5c` has no bug-report button.** Not in scope, and no endpoint.
9. **Streams table shows the real weekday.** The mock draws "Thu 14 Aug"; 14 Aug 2026 is a Friday.
