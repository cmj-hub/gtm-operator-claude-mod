# gtm-operator — a Claude Code mod for the GTM operator suite

A live cockpit for the [GTM operator skill packs](https://github.com/cmj-hub/gtm-operator-skills). It reads the same files `/gtm:next` reads (`brand-config.json`, `gtm/`, `drafts/`) and keeps the suite's state in front of you and in front of Claude.

## Requirements

Claude Code v2.1.287 or later (the first release with mods). Tested with Claude Code 2.1.289. The mods API can change between releases; if something stops drawing, run `claude plugin validate` on this folder and check the debug log.

Panes and the band draw in the terminal and the Desktop app's Code tab. In the VS Code extension, `claude -p` and cloud sessions the hooks still run: the guard works and `/gtm-board` answers in text.

## What it does

Shown only in a project that has a `brand-config.json` or a `gtm/` folder.

| Where | What |
|---|---|
| Band above the prompt | `GTM 2/11  Next: /evp:evp — no value line yet  [Use] [Board] [Hide]`. **Use** puts the command in your prompt. |
| Status line | `GTM 2/11 · next /evp:evp` |
| `/gtm-board` | A pane: operator, buyer, pain, value line, the 11 steps (✓ done, ▸ next, · open), and the install line for the next pack. |
| Toast | When a step completes: `GTM: Value line (EVP) done. Next: /prospect-list:who-to-contact` |
| System prompt | Each turn Claude reads what is done, what is next, and the suite's merge rules. |

It re-checks every 30 seconds and after any write or shell command. **Hide** on the band is remembered across sessions; **Show band** in the pane brings it back. Other mods' band rows stay visible above it.

## The guard: merge, never overwrite

`brand-config.json` and `SOUL.md` are shared by every pack. The mod refuses a Write or Edit that would:

- drop or change a value already filled in `brand-config.json` (adding fields is fine, so `/gtm:setup` still works),
- leave `brand-config.json` as anything but one JSON object,
- remove an existing `##` section from `SOUL.md`.

The refusal names the fields and tells Claude to ask you first. If the check itself fails, the write to those two files is refused rather than let through. Once you approve a change, run `/gtm-guard off`; `/gtm-guard on` restores it.

## Install

```text
/plugin marketplace add cmj-hub/gtm-operator-claude-mod
/plugin install gtm-operator@gtm-operator-claude-mod
```

Or from a clone, for one session:

```bash
claude --plugin-dir /path/to/gtm-operator-claude-mod
```

Pairs with the suite: `/plugin install gtm@gtm-operator-skills`.

## The steps it walks

Same order and checks as [`/gtm:next`](https://github.com/cmj-hub/gtm-operator-skills/blob/main/suite/skills/next/SKILL.md):

| Step | Done when | Next command |
|---|---|---|
| 0 Setup | `operator.name` and `icp.segment` filled | `/gtm:setup` |
| 1 Profile | `psp.primary_pain` and `psp.signal_anchors` filled | `/psp:psp` |
| 2 Value line | `evp.primary` filled | `/evp:evp` |
| 3 Prospect list | `gtm/list.json` | `/prospect-list:who-to-contact` |
| 4 First touch | `gtm/letter.json`, or `tone` + `infrastructure` | `/cold-email:cold-email` |
| 5 Offer | `gtm/offer.json` | `/sales-offer:cold-offer` |
| 6 Pricing | `pricing.currentTiers` or `gtm/price.json` | `/pricing:pricing` |
| 7 Landing page | `gtm/page.json` | `/landing-page:page` |
| 8 Email sequence | `gtm/sequence.json` | `/email-sequence:lifecycle-email` |
| 9 Findability | `gtm/findability.json` | `/geo:geo` |
| 10 Founder posts | a file in `drafts/` from the last 7 days | `/founder-brand:founder-brand` |

## Layout

```
.claude-plugin/plugin.json       manifest
.claude-plugin/marketplace.json  makes this repo installable as a marketplace
hooks/register.tsx               the hooks: band, pane, commands, guard, prompt section
hooks/gtm.ts                     pure logic: step walk, merge check, SOUL.md check
types/index.d.ts                 the mod's $.state contract
tests/gtm.test.ts                claude plugin test suite
```

## Develop

```bash
claude plugin validate .
claude plugin test .
tsc -p .        # after Claude Code has loaded the mod once (it writes .claude-plugin/types/)
```

## What it can reach

What `claude plugin validate .` reports, so you can review it before installing:

- **Hooks:** `session.start`, `classic.SessionStart` (after `/clear`, `/resume`, `/branch`), `command.run` (its two commands), `tool.call` (Write and Edit to guard, every call to refresh), `prompt.compose`, `ui.render` (the band and its own pane).
- **Calls:** `$.fs.read`, `$.fs.list`, `$.fs.exists` (your project's `brand-config.json`, `SOUL.md`, `gtm/`, `drafts/`), `$.store.get` / `$.store.set` (one key, `isBandHidden`), and display calls.
- **Never:** `$.fs.write`, `$.process`, `$.http.fetch`, `$.env`, `$.model`, `$.prompt.submit`. It writes nothing to your project, sends nothing over the network, and has no telemetry.

## Privacy

The one thing it saves is whether you hid the band, in Claude Code's plugin store under `~/.claude/plugins/store/`. Each turn it adds a short section to Claude's system prompt with the suite's state (steps done, next command); that text comes from your own files. The function-hook API it uses is early access in Claude Code and may change between releases.

MIT © Jay Mount Consulting
