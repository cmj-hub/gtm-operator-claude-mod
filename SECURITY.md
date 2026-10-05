# Security

## What this mod does on your machine

- It runs inside Claude Code as a mod: `hooks/register.tsx` and `hooks/gtm.ts`. `claude plugin validate .` lists every hook and call; the README's "What it can reach" section mirrors it.
- It reads `brand-config.json`, `SOUL.md`, `gtm/` and `drafts/` in your project root, and lists the folders where packs install (`packsDir`, `~/.claude/plugins/cache/`, the skills folders). It writes nothing in your project.
- It runs the installed packs' own scripts: each pack's scorer on its draft, and for the views the pricing pack's waterfall and decoy check and the cold-email pack's spam lint, subject score and reply triage. `python3 <script> <your file> --json`, no shell, 20-second timeout. These are standard-library Python that read a file and print JSON; none opens a network connection. Turn all of it off with the `runScorers` setting.
- The cold-email deliverability check runs only when you press its button: it looks up your sending domain's DNS records with `dig`, which does reach the network (DNS only).
- It reads one environment variable, `HOME`, to find the plugin cache.
- It saves whether you hid the band and each project's score history in Claude Code's plugin store under `~/.claude/plugins/store/`.
- It refuses some Write and Edit calls to `brand-config.json` and `SOUL.md` (see the README's guard section). It never approves a tool call, so your permission rules and prompts apply as before.
- It adds a short section to Claude's system prompt with the suite's state, built from your own files.
- Network: none. It never calls `$.http.fetch` or a model, and starts no process other than the packs' scorers.
- No telemetry. No credentials asked for or stored. Nothing is sent, posted or published.

## Reporting a vulnerability

Email jay@jaymountconsulting.com with "security" and the repo name in the subject, or open a private advisory under this repo's Security tab. Do not open a public issue for a vulnerability. Expect a reply within five business days.

## Supported versions

Only the latest release on `main` gets fixes.
