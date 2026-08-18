# The desktop app

The Windows client for the bot: Tauri 2 + React + TypeScript. The server is
always on; this is its remote control and live dashboard for one signed-in
streamer.

Scope is **Windows, dark theme only** — no light theme, no web layout. Both were
explicitly deferred, so there is deliberately no second palette to keep in step.

## Running it

```bash
npm install                       # from the repo root; this is a workspace
npm run build                     # @almosthadai/shared must exist on disk first
npm run tauri -w @almosthadai/app -- dev
```

`npm run dev -w @almosthadai/app` runs the front end alone in a browser. The
shell degrades to no-ops there: the window buttons do nothing and the deep link
never arrives, so sign-in cannot complete. That is deliberate — the alternative
is a crash on a missing `__TAURI_INTERNALS__`.

Point it at a server with `VITE_API_BASE_URL`; see [.env.example](.env.example).

## How the pieces fit

| Path | What lives there |
|---|---|
| `src/theme/` | Every design value, as constants. `applyTheme` turns them into CSS custom properties; the stylesheet contains no literal colors. |
| `src/api/` | One fetch wrapper over the `{ ok, data \| error }` envelope. Transport failure is an `unavailable` code, not a different species of problem. |
| `src/auth/` | The sign-in arc, the token store, and the deep-link parser. |
| `src/live/` | The WebSocket connection state machine. Knows nothing about channel status. |
| `src/shell/` | Title bar, icon rail, channel header — the chrome every signed-in screen keeps. |
| `src/screens/` | The auth screens. The domain screens arrive with WP9. |
| `src-tauri/` | The Rust shell: window, system browser, deep link, updater. |

## Three things worth knowing before changing anything

**`{{APP_NAME}}` is one constant.** It lives in `src/theme/tokens.ts`. `index.html`
ships an empty `<title>` and `tauri.conf.json` an empty window title precisely so
there is no second copy to forget at the rebrand; the app writes both on boot.

**Connection state is not channel state.** `connecting / open / reconnecting /
down` describes our link to the server. When it is not `open`, the header reads
`UNKNOWN` — never `OFFLINE`, and status tiles read `?` rather than zero. Telling
a broadcaster their bot is off because our socket dropped would be a lie about a
bot that is almost certainly still working. `src/shell/channelStatus.ts` is the
one place the two meet, and it is a pure function so that stays testable.

**`enabled` is not `status`.** `status` is what the world did to the channel
(Twitch revoked consent); `enabled` is what the owner chose with the header
switch. The API returns both, and the UI must be able to say "streaming, bot
paused" without contradicting itself.

## Fonts

Instrument Sans and JetBrains Mono are bundled as `@fontsource` npm packages and
imported from `src/theme/global.css`. Nothing reaches Google Fonts at runtime: a
machine with no internet renders correctly, and Google is never told when the app
opened.

## The updater

`tauri.conf.json` scaffolds it and leaves it **inactive**, because an active
updater needs a public key that does not exist until the first release signs one.
Finishing it at that release means: generate a key pair with
`npm run tauri -- signer generate`, put the public half in `plugins.updater.pubkey`,
set `active: true` and `createUpdaterArtifacts: true`, and hold the private half
as a repository secret. This is independent of Windows code signing, which is
deferred — updates stay cryptographically verified either way.

## Icons

`src-tauri/icons/` holds a placeholder generated from the design tokens: the clay
rounded square that appears in the title bar. It is a placeholder for the same
reason the wordmark is — the rebrand has not happened.
