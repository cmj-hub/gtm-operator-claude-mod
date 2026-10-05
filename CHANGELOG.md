# Changelog

## [0.6.1] — 2026-10-05

Found while capturing the screens in a live session.

### Fixed
- A gate refusal always says what to change: the scorer's fixes, else its reasons, else the axes furthest below their maximum (`raise hook (5/20): ...`). A draft at 79 against a minimum of 80 used to be refused with an empty list.
- `gtm_score` takes `file` as well as `pack`, and scores that file; Claude reached for a path first and got "Unknown pack".
- The Analytics tab labels CSV rows "imported from CSV", not "letter imported".

### Added
- `assets/screens/`: fourteen real terminal captures (hero, gate, band, every tab and view) and the converter that makes them; a Screens section in the README.

## [0.6.0] — 2026-10-05

### Added
- `/gtm-outcomes`: replies and meetings per cold email version, and `/gtm-outcomes import <file.csv>` to read them from a CRM export or spreadsheet (a `date` column plus `replies` and/or `meetings`). Importing the same dates again replaces them; bad rows are named and skipped.
- An eval suite (`evals/`, `claude plugin eval`) with a manual CI workflow: the guard keeps the brand config, Claude names the failing drafts, and Claude scores a new post before calling it ready.

### Fixed (found running the mod in a real terminal)
- The band no longer wraps its labels into two-line columns beside a docked pane; it drops the reason for the next step when the row is short.
- The pricing waterfall shows whole percents (`-28%`, `0%`, `+64%`), not `-0%` or `+63.78%`.
- The Detail tab shows a JSON draft as labelled lines (`primary_pain: ...`) instead of one run-on line.

## [0.5.1] — 2026-10-05

Found by running v0.5.0 on a sample project with the ten packs installed from the marketplace.

### Fixed
- `/gtm-sprint` and `/gtm-sprint resume` in a `-p` run or the SDK no longer say the command is in your prompt (there is none); they name the command to run.
- The type contract declares the mod's own three tools, so its `tool.call` matchers type-check whatever MCP servers the machine has connected.

### Changed
- New demo, lockup and social images showing scores, the score gate and cross-pack warnings; README says when the mod uses the network (only the deliverability button).

## [0.5.0] — 2026-10-05

Actions and analytics.

### Added
- **Run** on the band and **Run next** on the board run the next pack.
- `/gtm-sprint [to <step>|stop|resume]` and the **Sprint** button: run the packs in order, each only after the one before passes its scorer.
- Tools Claude can call: `gtm_status`, `gtm_score`, `gtm_consistency`.
- `gtm-operator:reviewer`: a read-only subagent that reviews one draft against the PSP, EVP, SOUL.md and its scorer.
- Analytics tab: score trends, drafts and time to pass, fixes resolved, and an outcome log (replies, meetings) tied to the live cold email.
- `/gtm-digest` and **Copy weekly digest**.

## [0.4.0] — 2026-10-05

What no single pack can see.

### Added
- Health tab and `/gtm-health`: drafts gone stale after a PSP, EVP or price change; a landing page that doesn't lead with the EVP or name the tiers; a letter or sequence with none of the buyer's words; roles the prospect list leaves out. Each with Fix with Claude. Claude reads them too.
- Views tab: Pricing (pocket-price waterfall, tier contrast check), Prospects (call / hold / drop), Cold email (lint and subject scores, send rhythm, reply triage, deliverability on request), EVP ladder, GEO (kill date, citations, blocked crawlers), Founder (pillar rotation, 7-day warning).
- Warning counts on the band and the status line.

## [0.3.0] — 2026-10-05

From step tracker to scoreboard: the mod now scores every draft with its pack's own scorer.

### Added
- Scores on the board: each step runs its pack's scorer and shows `37/100 · 11 fixes`, `pass` or `fail`, with a score trend.
- Detail tab: score breakdown, fixes, refused phrases, the draft, and **Fix with Claude**.
- `/gtm-score [pack]`: the scores as text, for surfaces where nothing draws.
- Live scoring: saving a draft scores it and toasts the result.
- `minScore` setting: an optional gate that refuses a draft below the score you set.
- Voice check: phrases under `## Phrases I refuse` in SOUL.md are flagged in every draft.
- Score history per project, kept across sessions.
- Settings: `runScorers`, `minScore`, `packsDir`, `python`.
- Claude reads which drafts fail and their first fix each turn.

### Changed
- The mod now runs local processes (the packs' scorers) and reads `HOME`; README and SECURITY.md list exactly what.

## [0.2.0] — 2026-10-05

Meets the Claude Code mods docs, and gets a logo.

### Added
- Logo (`assets/logo.svg`, `.claude-plugin/icon.png`), README lockup, header, social preview and demo image, all from sources in `assets/`.
- `classic.SessionStart` hook: the board and band come back after `/clear`, `/resume` and `/branch`.
- **Hide** on the band is remembered across sessions (`$.store`, one key).
- README: requirements and tested Claude Code version, where it draws, what it can reach, FAQ.
- `SECURITY.md`, `CONTRIBUTING.md`.

### Changed
- The band keeps what other mods draw there.
- The Write/Edit guard fails closed: if the check fails, the write to `brand-config.json` or `SOUL.md` is refused.
- `/gtm-board` and `/gtm-guard` run while Claude is working.

## [0.1.0] — 2026-10-05

First release: band above the prompt, status line, `/gtm-board` pane, step toasts, system prompt section, and the merge-never-overwrite guard with `/gtm-guard`.
