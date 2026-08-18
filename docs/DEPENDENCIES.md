# Dependency Management

How dependencies are versioned, updated, and merged in this repo.

---

## Exact pins, not ranges

Every entry in `package.json` is an exact version, `"express": "4.22.1"` rather than
`"^4.22.1"`.

This is the standard for **applications**. Libraries use ranges so consumers can
dedupe, but an application is the final consumer and gains nothing from that flexibility.
What it gains from pinning is that a fresh `npm install` six months from now resolves
to exactly what was tested, without relying on the lockfile alone to hold the line.

`package-lock.json` is committed and CI installs with `npm ci`, which installs
strictly from the lockfile and **fails** if it disagrees with `package.json`. Between
the pins and `npm ci`, there is no path by which CI silently tests a different
dependency set than the one you get locally.

Upgrades are not made by hand. Renovate proposes them.

## The update flow

```
Renovate opens a PR  ->  CI runs lint, typecheck and both test suites  ->  owner merges when green
```

1. **Renovate opens a PR.** Mondays before 9am. All non-major updates are grouped
   into a single PR; each major gets its own.
2. **CI runs automatically** on that PR. ESLint, typecheck, the server suite
   against a service Postgres, the app suite plus a front-end bundle build, and a
   Docker image smoke test, all on the Node version in `.nvmrc`. A separate job
   runs `npm audit --audit-level=high`, and a tag-gated job builds the Windows
   installer.
3. **You merge it** when CI is green. Nothing automerges.

A green CI run *is* the review for a patch or minor bump. Majors deserve an actual
read of the changelog, which is why they are never grouped in with the rest.

### If CI fails on a Renovate PR

The bump broke something, which is exactly what the pipeline is for. Options, in
order of preference:

- **Fix forward.** If the break is a small API change, push a commit onto
  Renovate's branch and merge once green.
- **Leave it open.** An unmerged Renovate PR is harmless. It sits there and gets
  rebased as other things merge.
- **Close it.** Renovate will not reopen a PR you closed for that same version.

Never merge a red one to "fix it later".

## Configuration

| File | Purpose |
|---|---|
| `renovate.json` | Update policy. Schedule, grouping, no automerge |
| `.github/workflows/ci.yml` | Lint + test job, and a separate audit job |
| `.nvmrc` | Node version, read by CI and by `nvm` locally |
| `package.json` `engines.node` | Declares the Node floor (`>=24`) |

Key `renovate.json` settings and why:

- **`rangeStrategy: "pin"`** keeps new dependencies pinned exactly, matching the
  existing style rather than reintroducing carets.
- **Weekly schedule**, because a batch on Monday morning beats a trickle all week.
- **Non-majors grouped, majors separate**, so there is one PR to glance at plus
  one PR per thing that genuinely needs thought.
- **`lockFileMaintenance` monthly** refreshes transitive dependencies even when no
  direct dependency changed. This is what picks up sub-dependency security fixes.
- **`automerge: false` everywhere**, so a human merges. On a project this size the
  review cost is seconds and the blast radius of an unattended bad merge is the whole
  bot.
- **`vulnerabilityAlerts` unscheduled**, so security PRs ignore the Monday window
  and open immediately.

## The security audit job

`npm audit --audit-level=high` runs as its **own** CI job, deliberately separate from
lint and test.

An advisory published against a transitive dependency has nothing to do with whatever
PR happens to be open at the time. Keeping it separate means it fails visibly, in its
own line on the checks list, without blocking unrelated work.

**Threshold is `high`.** Lower thresholds produce noise that trains you to ignore the
job, which is worse than not having it.

### Current state

`npm audit` is the live answer and this section does not restate a count. The
standing moderate advisories come from two chains, `express` to `qs` and
`drizzle-kit` to `esbuild`. Neither fails the build at the `high` threshold, and
both clear when their upstreams ship a bump that Renovate brings in.

## Node version

Pinned to **24** in `.nvmrc`, with `engines.node: ">=24"` in `package.json`.

CI reads `.nvmrc` via `actions/setup-node`'s `node-version-file`, so the version lives
in exactly one place. To move Node versions, edit `.nvmrc` and `engines` together and
let CI prove it.

## Owner setup (one-time)

Renovate needs a GitHub App installed. It cannot be enabled from inside the repo.
The click-through is:

1. Install <https://github.com/apps/renovate>, scoped to this repository.
2. Renovate opens an onboarding PR describing what it will do. Merging that PR
   activates `renovate.json`.

### Fallback: Dependabot

If you would rather use GitHub's built-in option and install nothing, Dependabot
covers the same ground with less control over grouping. Create
`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
      day: monday
      time: "09:00"
    open-pull-requests-limit: 5
    labels:
      - dependencies
    groups:
      non-major:
        update-types:
          - minor
          - patch
```

**Use one or the other, never both.** Two bots proposing the same bumps produces
duplicate PRs that conflict with each other. That file is deliberately *not* present
in the repo so that installing Renovate is the only step needed.
