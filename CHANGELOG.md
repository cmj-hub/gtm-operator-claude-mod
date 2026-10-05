# Changelog

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
