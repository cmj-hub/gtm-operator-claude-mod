# Changelog

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
