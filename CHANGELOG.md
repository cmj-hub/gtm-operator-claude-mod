# Changelog

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
