# Desktop app coverage ledger

The item-by-item record of what the desktop app does, measured against `docs/UI_FUNCTIONALITY.md`. The app is feature-complete, and this is the account of that claim: what is built, what is deliberately not, and what is a genuine gap.

Read `UI_FUNCTIONALITY.md` alongside it, because the section numbers below are that document's. Where the catalog and `shared/src/contract/` disagreed, the contract won and the row says so.

The design handoff directory was working reference only. It was gitignored, never committed, and deleted once its work was done. Nothing is lost by that: the design ids it defined are all listed below with their build status, every place the implementation departed from it is itemized in Deviations with the reason, and the per-screen design reasoning lives in the components' own comments. The owner retains the source zip.

**Status key**

- **BUILT.** In the app, exercised by tests, reachable by the owner.
- **BY DESIGN ABSENT.** Deliberately not built, with the reason. Not a gap.
- **DEFERRED.** A real gap, named, with what it would take.

---

## Section 2. Global state and connection concepts

| Item | Status | Where and note |
|---|---|---|
| Server unreachable, distinct from "you are offline" | BUILT | The `live/connection.ts` state machine drives the pill and the degraded banner independently of channel status. The two are never conflated, which `dashboard.test.tsx` asserts. |
| Signed out or session expired | BUILT | `useAuth` phases, with `withFreshSession` refreshing per call. |
| `status: active` | BUILT | Header pill. |
| `status: needs_reauth` | BUILT | Banner plus Reconnect, the TWITCH tile pulsing clay, and the bot switch inert. |
| `status: disconnected` | BUILT | The account card reads "Channel disconnected" and the Disconnect button becomes inert. |
| Stream live or offline, plus uptime | BUILT | Ticks locally, re-synced on every `channel.status`. |
| Spotify connected or not | BUILT | The songs screen and its missing-Spotify variant, plus the songs settings card. `spotifyConnected` on `/me` feeds the dashboard tile. |
| Rate limited, non-scary | BUILT | `errorPresentation.ts` renders it inline, with the `Retry-After` seconds. |
| One error presentation for the envelope | BUILT | `errorPresentation.ts`, one module, used by every screen. |

## Section 3. Auth and onboarding

| Item | Status | Where and note |
|---|---|---|
| Sign in with Twitch, in the system browser | BUILT | The sign-in screen, with the reachability pill. |
| Waiting-for-browser state | BUILT | The waiting screen. |
| Failure and retry | BUILT | Reopen plus Cancel. |
| Sign out, local discard | BUILT | Account card. |
| Sign out, server refresh-token revocation | BUILT | `POST /auth/app/logout` revokes the session server-side. |
| Channel onboarding, five scopes | BUILT | The onboarding screen. |
| Spotify connect | BUILT | The songs screen and the songs settings pane both start the chain in the system browser. |
| Spotify disconnect | BUILT | `DELETE /api/v1/spotify`, which switches song requests off with the account. |
| Declined-permissions handling, features named | DEFERRED | The server records declined scopes, but nothing in the contract exposes which features are degraded, so the app cannot name them. Needs a contract field before a screen can be honest about it. |

## Section 4. Dashboard and live

| Item | Status | Where and note |
|---|---|---|
| Bot presence, server health plus session state | BUILT | The status strip, five tiles. |
| Live indicator plus uptime | BUILT | Header pill. |
| `chat.message` feed | BUILT | Ambient, capped in memory, no backfill, as specified. |
| `song_queue.updated` | BUILT | Refetches. `queueLength` rides the event and is deliberately not used to render rows, because a length is not a list. |
| `channel.status` | BUILT | Drives the pill, the clock and the dot animations. |
| Connection drop and reconnect | BUILT | The degraded banner, and empty copy that states plainly that missed lines stay missed. |
| Idle stream-offline quiet state | BUILT | The offline dashboard, including the last-stream caption. |
| Dedicated AI-replies view | BY DESIGN ABSENT | Future in the catalog. AI replies are visible in the chat feed because the bot is a chatter. |

## Sections 5, 6 and 7. Commands, emotes and quotes

| Item | Status | Where and note |
|---|---|---|
| Commands list, two kinds, one list | BUILT | Handler-backed rows are locked with a `BUILT IN` chip. |
| Create, edit and delete static commands | BUILT | The command editor, whose validation runs the server's own schemas. |
| Level editing for handler-backed commands | BY DESIGN ABSENT | Future in the catalog. The declaration in code is the source of truth. |
| Commands empty state | BUILT | The empty screen, plus the built-ins-that-already-work card. |
| Emotes list, create and delete, with no edit | BUILT | Composer as the first row. |
| Quotes list, random, create and delete | BUILT | Retired numbers render as gaps, with the footnote saying why. |

## Section 8. Songs

| Item | Status | Where and note |
|---|---|---|
| Queue view, with track, artist, requester and requested-at | BUILT | Grid `28px 1fr 200px 110px 48px`. |
| Real-time via `song_queue.updated` | BUILT | The shell refetches, and the screen shares that one path. |
| Skip head | BUILT | `DELETE /songs/head` removes the next waiting request, so its control is "Drop" on the queue's head row, deliberately not beside the playing track, which is a different song. |
| Song requests on and off | BUILT | The header toggle on the songs screen and the row in songs settings, disabled when Spotify is absent. |
| Partial-failure honesty, setting saved but reward still visible | BUILT | Reported inline on the row, never as a toast. |
| No "add song" action | BY DESIGN ABSENT | Policy, not a gap. The policy card says so in the streamer's words. |
| Two-stage queue taught gently | BUILT | Two labels and one meta line, no prose, per the handoff's instruction. |
| Spotify connection state drives the domain | BUILT | The songs screen and its missing-Spotify variant. |
| Requests playlist: toggle, name, create-if-missing, skip gracefully | BUILT | In songs settings. The name resolves at save, and the confirmation line says what actually happened rather than "Saved". |
| Now-playing card | BUILT | `GET /songs/playing`. Paused keeps the track and freezes the bar. |
| Skip the currently playing Spotify track | BUILT | `POST /api/v1/songs/skip`, key-reachable, with the Skip button beside now-playing. One consequence is worth stating: skipping outside the ten-second handoff window plays one of the streamer's own tracks before the next request, and nothing is lost because the order holds. |

## Section 9. AI

| Item | Status | Where and note |
|---|---|---|
| AI on and off per channel | BUILT | Reaches the running bot without a restart, through the settings cache. |
| How it triggers, as an explainer | BUILT | The row's description, verbatim from the design. |
| Per-role stream limits, view | BUILT | Opens on the values the limiter actually enforces, not a proposal. |
| Per-role stream limits, edit | BUILT | Steppers, the whole set sent every time, bounds read off the schema. |
| Broadcaster unlimited | BUILT | Rendered as the word, in sage. No field, deliberately. |
| Usage-counter threshold as a setting | BY DESIGN ABSENT | Future in the catalog. Space left in the AI pane. |
| Game-command images, and reset-everyone's-images | BY DESIGN ABSENT | Future. Today the reset is an env salt bump. |

## Section 10. Analytics

| Item | Status | Where and note |
|---|---|---|
| Summary: viewers known, total messages | BUILT | Four stat cards. |
| Top chatters | BUILT | Bars scaled to the busiest chatter, not the total. |
| Streams history: start, end, duration | BUILT | The streams table. An open stream reads "live". |
| Young and empty states as first-class | BUILT | Real small numbers, a plain sentence, and a footer that counts the real streams. No apology anywhere, asserted as a negative in `analytics.test.tsx`. |
| Per-stream against lifetime framing | BUILT | Three range chips over one dataset. `this_stream` resolves through the same function the dashboard uses, so the two screens cannot disagree. |
| "Since <date>" header | BUILT, relabeled | Reads "last stream <date>". The contract has no earliest-stream field, and `lastStreamAt` is the most recent one, so labeling it "since" claimed the figures began after most of the data they include. |
| Viewer detail: per-viewer totals, follow date, watch time | DEFERRED | The data exists and no endpoint does. No screen asks for it yet. |

## Section 11. Settings

| Item | Status | Where and note |
|---|---|---|
| AI enabled | BUILT | The AI pane. |
| AI limits view and edit | BUILT | The AI pane. |
| Discord webhook: set, replace, clear, never display | BUILT | Write-only is structural, because the contract carries a boolean and no route returns the value. |
| Songs reward toggle | BUILT | The songs pane. |
| Playlist controls | BUILT | The songs pane. |
| Spotify connect, disconnect and status | BUILT | The songs pane, sharing the songs screen's card component. |
| Stream Deck keys: list, create with show-once, revoke | BUILT | The key renders exactly once and closing discards it, pinned by test. |
| Key scope stated | BUILT | The shield note names the three things a key can do. |
| Managed rewards status plus trust copy | BUILT | The meta counts what the bot manages rather than claiming to know the streamer's own rewards. |
| App version plus auto-update status | BUILT, partial | The version is read from the build, so it cannot drift. The `CURRENT` chip states which version is running. The design's "up to date" claim is not made, because this screen is not given the updater's verdict. |
| Release notes link | BY DESIGN ABSENT | Future in the catalog. |
| Bug report affordance | DEFERRED | Named in the catalog and not built. No report endpoint exists, and a button promising to attach version and logs while doing neither would be a lie in the one card whose whole job is trust. |
| Account: identity and sign out | BUILT | The account pane. |
| Account: "Channel connected <date>" | DEFERRED | `ChannelSummary` has no connected-at date. The line renders without one rather than inventing a plausible number from the token's issue time. One contract field would close it. |
| Disconnect channel, a dangerous action | BUILT | `DELETE /api/v1/me/channel`. Two-click confirmation, status becomes `disconnected`, the session stops, the three managed rewards are disabled and never deleted, and all content is untouched. It is never exercised against the owner's live channel, and is proven in `channelSwitch.test.ts` only. Reconnecting does not re-enable the two rewards it switched off, which the deferred ledger in `docs/DECISIONS.md` records. |

## Section 12. Empty and degraded states

| State | Status | Where |
|---|---|---|
| Fresh channel, with no commands, emotes, quotes or analytics | BUILT | The commands empty screen, and analytics' real-zeroes rendering. |
| Stream offline | BUILT | The offline dashboard. |
| Spotify not connected | BUILT | The songs screen's missing-Spotify variant, and the songs settings pane. |
| AI off | BUILT | Status tile plus the AI pane. |
| `needs_reauth` | BUILT | The reconnect banner. |
| Server unreachable | BUILT | The degraded banner. |
| Brand-new install, before sign-in | BUILT | The sign-in screen. |

## Section 13. Explicitly out of scope, confirmed absent

No channel picker. No adding songs without redemptions. No cross-channel data, which is structurally impossible because no route accepts a channel id. No management of the bot's own Twitch account. No server ops. All five verified absent from `app/src/`.

## Section 14. Future space, left rather than built

Editors and roles. A per-channel counter threshold. An image reset. Richer analytics. A reorderable queue. Chat retention. Localization. None occupy UI, and none are stubbed.

---

## Design ids

| Id | Screen | Status |
|---|---|---|
| `1a` | Rail tooltip on hover | BUILT |
| `2a` and `2b` | Dashboard, live and offline | BUILT |
| `2c`, `4d` and `4e` | Commands, empty, editor | BUILT |
| `3a` | Emotes | BUILT |
| `3b` | Quotes | BUILT |
| `3c` and `4c` | Songs, and Spotify missing | BUILT |
| `3d` | Analytics | BUILT |
| `3e` | Settings, AI | BUILT |
| `5a` | Settings, Songs | BUILT |
| `5b` | Settings, Notifications | BUILT |
| `3f` | Settings, Stream Deck, with the show-once modal | BUILT |
| `5c` | Settings, Account, with the danger zone | BUILT |
| `3g`, `5d` and `3h` | Sign in, waiting, onboarding | BUILT |
| `4a` and `4b` | needs_reauth, server unreachable | BUILT |

Every id the handoff defined is accounted for above. `1b` and `1c` are design-canvas variants of the big-figure type scale, not screens.

---

## Deviations from the design, and why

Each of these is the contract winning over the mock.

1. **Skip and Drop are two controls on two different songs.** Skip advances Spotify's player through `POST /songs/skip`, and Drop removes the next waiting request through `DELETE /songs/head`. The design drew one control, the contract has two actions, and conflating them would silently delete a viewer's request while the streamer believed they skipped what they were hearing. Each label names the track it acts on.
2. **The analytics header reads "last stream", not "since".** No earliest-stream field exists.
3. **The playlist line omits "last added 4 minutes ago".** `SpotifyPlaylist` carries no last-added timestamp.
4. **The webhook row omits "Set on 2 Aug".** No set-on date is stored or served.
5. **The rewards meta reads "N of 3 bound", not "3 of yours untouched".** The API deliberately never enumerates the streamer's own rewards, because the trust claim rests on not looking, so the app must not print a count of them.
6. **The identity card omits the connected-on date.** No such field exists.
7. **The App card says `CURRENT` without "up to date".** The updater's verdict is not given to this screen.
8. **There is no bug-report button.** Not in scope, and no endpoint.
9. **The streams table shows the real weekday.** The mock draws "Thu 14 Aug", and 14 Aug 2026 is a Friday.
