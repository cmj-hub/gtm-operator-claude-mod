# Security

## What this mod does on your machine

- It runs inside Claude Code as a mod: `hooks/register.tsx` and `hooks/gtm.ts`. `claude plugin validate .` lists every hook and call; the README's "What it can reach" section mirrors it.
- It reads `brand-config.json`, `SOUL.md`, `gtm/` and `drafts/` in your project root. It writes nothing in your project.
- It saves one value, whether you hid the band, in Claude Code's plugin store under `~/.claude/plugins/store/`.
- It refuses some Write and Edit calls to `brand-config.json` and `SOUL.md` (see the README's guard section). It never approves a tool call, so your permission rules and prompts apply as before.
- It adds a short section to Claude's system prompt with the suite's state, built from your own files.
- Network: none. It never calls `$.http.fetch`, starts a process, reads environment variables, or calls a model.
- No telemetry. No credentials asked for or stored. Nothing is sent, posted or published.

## Reporting a vulnerability

Email jay@jaymountconsulting.com with "security" and the repo name in the subject, or open a private advisory under this repo's Security tab. Do not open a public issue for a vulnerability. Expect a reply within five business days.

## Supported versions

Only the latest release on `main` gets fixes.
