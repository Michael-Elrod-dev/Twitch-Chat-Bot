# Decisions of record and tracked work

The living register of owner decisions, tracked future work, and standing rules. The full build history lives in git history, not here. This document describes only what stands today and what is planned.

## 1. Locked owner decisions

1. **TypeScript everywhere.** The server, the shared contract, and the desktop app are all TypeScript with strict compiler settings.
2. **Desktop shell: Tauri 2.** Windows-only thin client. Auto-update goes through Tauri's own updater against GitHub Releases, with Tauri's update signing independent of Windows code signing.
3. **Hosting: Hetzner VPS.** A CX23 (2 vCPU, 4 GB, Falkenstein) running Docker Compose, about $7 per month all-in. Backups go to the existing S3 bucket.
4. **Code signing: deferred.** The installer is unsigned and SmartScreen shows a one-time warning, accepted for the current audience. Tauri's update signing keeps auto-updates cryptographically verified regardless. Revisit at the third user.
5. **Bot account: single shared identity.** One bot account chats in all channels.
6. **Domain: DuckDNS subdomain to start.** A real domain later is a config swap plus redirect-URI re-registration in the Twitch and Spotify consoles.
7. **Database engine: PostgreSQL.**
8. **Database hosting: on the box, built like it's remote.** Postgres runs in the compose stack on the VPS at no extra cost, held to six guardrails that keep it location-agnostic:
   1. The app knows only `DATABASE_URL` from the environment. No locality assumptions, TLS-ready.
   2. Schema exists solely as versioned Drizzle migrations in git, reproducible on any Postgres anywhere.
   3. The app connects as a least-privilege role, never superuser.
   4. Verified `pg_dump` backups ship to S3. The backup artifact is both the migration vehicle and the disaster-recovery vehicle (new box, compose up, restore dump).
   5. A scheduled CI restore drill proves dumps restorable continuously instead of discovering breakage in a crisis.
   6. Pooling discipline, so managed poolers slot in without code changes.

   Graduation to a managed Postgres (about $19 to $25 per month) happens when any trigger fires: first paying user, any user beyond owner plus friend, public promotion begins, or the database outgrows the box (multi-GB or sustained load). The procedure is dump, restore to the managed instance, flip `DATABASE_URL`, rotate credentials. Zero code changes, under an hour, pre-rehearsed by the restore drill.
9. **Requests playlist is a core product feature** (owner-elevated). The streamer can toggle "save requested songs to a playlist" and name the playlist. If it exists on their Spotify account, songs are appended with database-side dedup. If not, the bot creates it with the first request. If creation is impossible, the step is skipped gracefully. `docs/UI_FUNCTIONALITY.md` section 8 carries the product spec.

## 2. Tracked future work

- **Chat-message retention.** Unbounded growth of `chat_messages` is accepted at the current scale. Implement a rolling window (90 days was the proposal) when growth actually matters. Trigger: multi-GB table size or query slowdown. Aggregates (`chat_totals`, `streams`, `viewing_sessions`) stay permanent regardless.
- **Queue-truth reconciliation for UI queue editing.** When the app grows queue editing beyond view, drop, and skip, every Spotify-facing mutation should verify the external state around the change. Naive read-after-write races Spotify's propagation delay and would raise false alarms, so the correct shape is verify-with-tolerance and converge, the same pattern the EventSub subscription reconciler uses. Notes for that day: only one track is ever in flight to Spotify (handed over inside the ten-second advance window), so the bot's own queue is sole truth for waiting songs and reorders need no Spotify check at all. Spotify's read-the-queue endpoint has not been verified against current docs. The playback monitor's periodic re-read is today's convergence mechanism and the seam to extend.
- **Spotify platform lockdown and the bring-your-own-app path.** The Spotify app runs in Development Mode. The app owner's Premium subscription is load-bearing (a lapse kills API access for all channels). Non-owner users must be allowlisted in the Spotify developer dashboard, so a new streamer's Spotify account gets added at onboarding. Extended quota now requires a registered business with 250k monthly active users, which means the songs feature cannot scale to public users under current policy. If a subscription-product future arrives, the researched answer is a hybrid: serve early users from the allowlist, and beyond that grow a guided bring-your-own-Spotify-app wizard where each streamer creates their own developer app and is then their own app's Premium-holding owner. Spotify offers no programmatic app creation, so BYO is always a human dashboard task the app can make tolerable with screenshots, paste, and validation. Per-channel Spotify client credentials are a small schema addition when needed. In every model, each streamer needs their own Premium (Spotify's playback rule).
- **The friend's onboarding is the standing acceptance test.** A second channel signs in, connects, and runs without anyone touching the server. That includes adding the friend's Spotify account to the allowlist.

## 3. Deferred observations ledger

Items covered by tests but not yet witnessed live. The owner walks this list when time allows.

| # | Item | Basis today | What the owner would do |
|---|---|---|---|
| 1 | AI-limit denial | Steppers save and read back (server tests). The limiter reads limits at decision time, proven by reintroduction | Settings, AI, set Everyone to 1. Two AI requests from a non-mod. Second refused. Restore to 3 |
| 2 | Discord webhook replace and clear | Round-trips server-side. Write-only proven structurally and by a whole-document negative in the app suite | Settings, Notifications. Replace with a URL, then Clear. Confirm the stored value is never shown |
| 3 | Uptime tick | Formatter unit-tested. Re-sync on `channel.status` asserted | Watch the header pill advance across a real stream |
| 4 | Last-stream caption | Rendered from `lastStream`, unit-tested | Look at the dashboard after a stream ends |
| 5 | Mod-green chat color | Derived from the pipeline's own role logic, unit-tested | Have a moderator speak while the app is open |
| 6 | Reconnect does not re-enable disabled rewards | Known and stated in the README. Shipped behavior accepted | See the provenance-based restore spec below |
| 7 | Provenance-based reward restore | Specced, not built. See below | A future work item |
| 8 | Danger-zone disconnect | Nine tests on throwaway channels, including content survival in rows and a Twitch-refusal path | Deliberately never run against the live channel |

## 4. Specced, not built

- **Provenance-based reward restore.** At disconnect, record which rewards the teardown itself disabled. At reconnect, re-enable exactly those and only those, owner-visibly logged. A blanket re-enable would trample the streamer's own choices, which is why provenance is the design.
- **Played-history table.** The now-playing requester is held in memory only, so a server restart loses it and the card shows the track with no requester. A played-history table is the proper fix.
- **Chat-totals batching.** Totals are written synchronously per message today. The batching architecture is the named scale path in the method's own comment, not built at current scale.
- **Usage-counter preferences.** The AI reply counter's threshold and an always-on preference belong in `channel_settings` as fields for the AI settings screen, so a streamer who wants a running count can have one.

## 5. Open register

Small items carried deliberately, each with its reason.

- **Declined-scope naming** needs a contract field before the UI can name what a streamer declined.
- **Viewer-detail endpoints** do not exist yet (the API serves aggregates, not per-viewer drill-downs).
- **Bug-report affordance.** No endpoint exists. A button claiming to attach logs while doing neither would be a fake, so no button ships until the endpoint does.
- **`ChannelSummary.connectedAt`** is needed for the account screen's "connected since" date line.
- **Updater verdict.** The auto-updater is scaffolded but inactive (`active: false`, no public key). Finishing steps are written in `app/README.md`. The account screen's "Up to date" line gets its truth source when the updater goes live.
- **`findPlaylistByName` is bounded at ten pages** (500 playlists). Past that it creates a duplicate playlist rather than hanging a settings save. The bound is logged, not silent.
- **Commands and emotes are fetched whole at limit 200** and paged in memory. Fine at current scale, a real query when someone has more.
- **Tokens live in `localStorage`** behind the `SessionStorage` interface, so a swap to the Windows credential store is one implementation. A named security-audit input.

## 6. Ops backlog

- Production-artifact restore drill (restore a real S3 dump, not just the CI-generated one).
- Registry-based deploy (build and push an image, pull on the box) replacing the rsync script.
- Duplicate-rate counters for EventSub delivery metrics.
- Optional external uptime monitor (the scheduled CI probe is the interim).
- S3-sourced restore-drill upgrade once AWS secrets are added to the repo settings.
- GitHub Actions still running on the Node 20 runtime need version bumps (`docker/build-push-action`, `docker/setup-buildx-action`, `actions/cache`, `actions/upload-artifact`).
- Standing moderate npm advisories (audit at level high stays green, the moderates are watched).

## 7. Security-audit stage

A dedicated audit run by a separate, fresh session before any public or promoted launch. Scope: system-design vulnerabilities across the whole surface. Auth and OAuth flows and token handling, the public webhook, API authorization and tenant isolation, secret handling, dependency CVEs, and the public GitHub repo itself (history for leaked secrets, workflow permissions, exposed config). Named audit inputs: the `localStorage` token seam, the WebSocket token-in-query pattern (a ticket endpoint is the named upgrade path), the webview CSP breadth, and the OAuth state in-memory fallback. Deliverable: a findings report ranked by severity, fixes issued as normal work.

## 8. Definition of v1 and what remains

v1 is everything through the security audit plus owner-added features to be specified later. Version tags before that are working builds. Remaining: the release-process proof (updater signing, first tagged release, one proven auto-update cycle), the rebrand, the security audit, the friend's onboarding, the deferred-observations pass above, and the owner's future features.

## 9. Rebrand carriers

The product name is one constant in the app, but the name also lives in infrastructure. When the rebrand lands, these all carry it: the README, `package.json`, the Docker image name, the Postgres volume name, the deploy path `/opt/almosthadai`, the DuckDNS host plus the Twitch and Spotify console redirect URIs, the bot's Twitch login (a separate decision), the CI installer's `VITE_API_BASE_URL`, the app icon, and the `APP_NAME` constant.

## 10. Design principles

- **Status is what the world did to a channel. Enabled is what the owner chose. Disconnected is a teardown the broadcaster can reach.** These are separate facts and the app renders them separately. Conflating them lies to the broadcaster: a paused bot would report itself broken, or a broken bot would report itself merely paused, and the recovery paths differ.
- **The product's default state is an offline streamer and a quiet bot.** Most of the time nothing is live. The design must be pleasant there, not only during the exciting moments.

## 11. House rules

- Any new server env var lands in three places in one commit: the env schema, `.env.example`, and the compose passthrough. `VITE_` variables are exempt as client-build-time.
- "Typecheck clean" means `npm run typecheck` at the repo root exits 0. That is the CI command.
- Server tests run only against the throwaway database from `scripts/test-db.sh`, with `REQUIRE_DB_TESTS=1` so skips fail loudly. Never the dev compose database.
- Tests that pin a bug are validated by reintroducing the defect and watching them fail.
- The contract in `shared/src/contract/` wins over any doc that disagrees with it.
- Commit messages are plain English describing the change, ending with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. The owner pushes.

## 12. Open items

- The design-review zip in the owner's Downloads folder awaits the owner's confirm-to-delete.
- The adjacent design-capabilities zip belongs to a different project and must not be touched.
- The `.gitignore` rule for the design-handoff directory stays, so a re-extraction can never become a commit.
