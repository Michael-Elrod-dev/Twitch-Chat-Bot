# Lead Onboarding — read this first

You are the **lead / architect** on this project (a Claude Fable session). This document hands you the operating model, the standards that made this run work, and exactly where to resume. Read it, then read the "resume point" section last — it tells you what to do next.

## The arrangement

Three parties, and you only ever talk to one of them:
- **You (Fable, lead):** review, plan, write the docs, cut work packages, verify completed work, make the commits. **You write no production code yourself** — that's the engineer's job. You are the architectural authority and the last line of verification.
- **The engineer (a separate Opus session):** implements the packages you issue. You never see its conversation.
- **The owner (a human):** relays messages between you and the engineer by copy-paste, and makes product/decision calls. The owner is your only communication channel to the engineer.

Because of the relay, **every reply you write must contain two clearly-marked parts:**
1. A section addressed to the owner (findings, verification results, decisions, questions) — label it plainly (the prior run used **"FOR YOU (not for Opus)"**).
2. A **"PASTE TO OPUS"** block — the self-contained message the owner will paste into the engineer's session. It must stand alone: the engineer has only what's in the repo docs plus what you write here.

Shared state lives in `docs/`. The engineer reads the same repo you do.

## The standards that made this work (hold them)

These are not bureaucracy — each one caught real bugs this run:

1. **Reintroduction-validated tests.** Every bug fix must be proven by *reintroducing the defect and watching the test fail*, then restoring. A test that passes against the broken code is worthless — this protocol caught its own blind spots five separate times ("wrong-reason tests"). Demand it in every package; accept the honest "this defect can't be caught by a test and here's why" when it's true (e.g. timing-safety).
2. **Verify, don't trust the report.** Before you approve a package, run it yourself: `bash scripts/test-db.sh` (throwaway DB — see below), the server suite, lint, and for anything touching production, probe production directly (`curl https://almosthadai.duckdns.org/healthz`, hit endpoints). Read the actual diff for security- or correctness-critical code. Findings from the engineer are a starting point, not a conclusion — you overturned the engineer's diagnoses with evidence more than once, and it overturned yours.
3. **Parity on ports (owner rule).** When a package ports old behavior into the new codebase, spot-diff the legacy source against the port for core conditionals. A usage-counter suppression was silently dropped in a port and only caught by the owner using the bot live — presence-in-a-ledger is not behavioral parity.
4. **Commits are yours, one per verified package.** Plain-English messages, **no internal identifiers** like "P1-WPx" (owner rule). End every commit message with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. The owner pushes.
5. **The dev database is protected.** Server tests must run against the throwaway DB from `bash scripts/test-db.sh` (it prints a `TEST_DATABASE_URL` to export). The real dev DB holds live credentials and imported production data and is guarded — a `down -v` once destroyed the import (recoverable, but the guard exists now; respect it).
6. **New env var = three places, one commit:** the zod env schema, `.env.example`, and the compose passthrough. A code default silently masks a missing passthrough otherwise.
7. **Honest stops beat false progress.** If context runs low, stop clean and hand off rather than ship a half-built, unproven package. The prior lead did exactly this on the last package — the repo is at a clean save point because of it.

## What exists right now (the product)

A **hosted, multi-tenant Twitch bot**, live in production, that a streamer will control via a **Windows desktop app** (not yet built). Architecture and every locked owner decision are in **`docs/PHASE1_DESIGN.md`** (read its §8 for the decisions: TypeScript, Tauri 2, Hetzner VPS + Docker Compose, PostgreSQL, shared bot account, DuckDNS host, code-signing deferred).

- **Server:** TypeScript monorepo (`server/`, `shared/`), Postgres + Redis + Caddy in Docker Compose, deployed to a Hetzner box at `https://almosthadai.duckdns.org`. EventSub via webhook. ~794 server tests.
- **Live and working:** OAuth onboarding with encrypted tokens, the full authenticated REST API + realtime WebSocket feed, AI chat (Claude), song requests + Spotify + the requests-playlist foundation, quotes, commands, emotes, analytics, all 17 chat commands. The bot answers in the owner's channel now.
- **The legacy Phase-0 bot has been deleted** — the repo contains exactly one bot.
- **Contract source of truth:** `shared/src/contract/`. Where any doc disagrees with the contract, the contract wins.

## Key docs

- `docs/WORK_PACKAGES.md` — the living log: every package's spec, the engineer's report, and your verification verdict. **Its tail is the resume point.** Read the Phase-1 section; Phase-0 is archived.
- `docs/PHASE1_DESIGN.md` — architecture + locked owner decisions + §9 risks/tracked-future-work.
- `docs/UI_FUNCTIONALITY.md` — the design-agnostic catalog of everything the desktop app must surface (you wrote this for the designer).
- `docs/PHASE1_EVENTSUB_FACTS.md` — verified Twitch platform facts.
- `docs/DEPENDENCIES.md` — the Renovate → CI-green → manual-merge flow.
- `docs/archive/` — Phase 0 record; historical, don't edit.
- `design_handoff_bot_desktop_app/` — **Claude Design's approved handoff** (the app's visual/interaction spec). It is **working reference: gitignored, never committed, and its deletion is an exit criterion of the final screens tranche.** Read its `README.md`; it is the acceptance spec for the app's look and behavior.

## Owner-facing carry-overs (things the owner still owes or must decide)

- **The rebrand / product name is still unchosen.** The app treats `{{APP_NAME}}` as one constant, so the app rebrand is trivial; the infrastructure carriers (README, package names, Docker image/volume, `/opt/almosthadai`, the DuckDNS host and the Twitch/Spotify console redirect URIs, and the bot's Twitch login as a separate decision) are inventoried in the design handoff README and the WORK_PACKAGES log. The name is on the critical path for nothing that's currently issued, but it lands before public launch.
- **Dedicated security-audit stage** (owner-requested) — to be run by a *separate* Fable session before public launch, covering system-design vulns and the public GitHub repo (leaked-secret history, workflow perms). Recorded in `WORK_PACKAGES.md` under FUTURE. Not this session's job unless the owner redirects.
- The owner does live-proof steps and console/OAuth actions when a package reaches them; brief them clearly when needed.

## Resume point (do this)

The remaining work is **the desktop app**, all specced and open:
- **The app-shell + auth package (issued, not started):** the `app/` Tauri 2 + React + TS workspace, the design tokens as a theme module, the persistent shell (title bar / icon rail / channel header), the auth screens, the WS connection state machine, the channel enable/disable endpoint for the header master switch (contract-first, reintroduction-tested), and a CI Windows-installer artifact. Its full spec is the "Desktop app shell & auth (remainder)" entry in `WORK_PACKAGES.md`. **Design note preserved from the prior lead:** the master switch needs a NEW `enabled` column, never a reuse of `status` — `status` is what the world did to the channel, `enabled` is what the owner chose; conflating them lies to the broadcaster.
- **Then the three screen tranches** (dashboard/live → content domains → songs/analytics/settings), each verified separately, with the small server additions each needs riding along contract-first. On the final tranche's close, delete `design_handoff_bot_desktop_app/` and prove no remnants.

The auth foundation the whole app sits on is already hardened and deployed (an open-redirect token-exfiltration hole was found and closed before any UI was built on it). Nothing needs unpicking; the repo is green and production is healthy.

**Your first actions:** read `docs/WORK_PACKAGES.md` (Phase-1 section, and its tail), `docs/PHASE1_DESIGN.md` §8, and `design_handoff_bot_desktop_app/README.md`; verify the current state yourself (`bash scripts/test-db.sh` then the server suite, and a production health probe); then issue the app-shell package to the engineer via a PASTE TO OPUS block, following the pattern in `WORK_PACKAGES.md`.
