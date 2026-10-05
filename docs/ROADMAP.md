# Roadmap: from step tracker to GTM cockpit

v0.2 tracks whether each pack's file exists. v0.3 to v0.5 make the mod show whether the work is good, catch problems between packs, and act on them. Every idea from the brainstorm is listed here with its version, design and test.

## Ground rules

- **Use the packs' own scorers.** All ten packs ship standard-library Python scorers that print JSON with `--json`. The mod runs them; it never re-implements a rubric.
- **Run locally only.** `$.process.run(["python3", <scorer>, ...])` with a 20 s timeout. No network, no model call in scoring. This adds `$.process.run` to the mod's reach; README and SECURITY.md say so.
- **Warn by default.** Cross-pack checks are heuristics and never block. Score gates block only when the user sets a minimum.
- **Degrade, don't break.** A missing pack, a missing `python3`, or output the mod can't read shows `unknown` with the reason.

## v0.3: scoreboard

| Idea | Design | Where |
|---|---|---|
| Find the packs | Search `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, `~/.claude/skills/`, `~/.agents/skills/`, the project's `.claude/skills/`, and the `packsDir` setting. Newest version wins. | `hooks/locate.ts` |
| Run a scorer | Per-pack registry: scorer path, project input file, argv. | `hooks/packs.ts` |
| One score shape | Normalize `ok` / `pass` / `total` + `max_total` / `reasons` / `failures` / `problems` / `fixes` / `axes` into `{ status, score, reasons, fixes, axes, next }`. | `hooks/score.ts` |
| Scores on the board | Each step shows `82/100 · 2 fixes`, `pass`, `fail`, `missing` or `unknown`. | `register.tsx` Board tab |
| Drill into a step | Detail tab: axes as bars, each reason with its fix, the draft text, the scorer path. | Detail tab |
| Fix with Claude | Fills the prompt: the pack command plus the fix lines. | button |
| Score history | Each scoring run appends `{ at, score }` per pack per project to `$.store`; drawn as a sparkline. | `hooks/history.ts` |
| Live scoring on save | After a Write/Edit to a pack's draft, score it and toast `Cold email: 64, 3 fixes`. Debounced by file mtime. | `tool.call` hook |
| Score gates | `minScore` setting (0 = off). A Write to a `gtm/` draft whose content scores below it is refused with the fixes. Content is scored from stdin before the write. | `tool.call` hook |
| Voice check | Phrases under `## Phrases I refuse` in SOUL.md are flagged in any draft, every pack. | `hooks/voice.ts` |

## v0.4: what no single pack can see

| Idea | Design | Where |
|---|---|---|
| Stale drafts | A downstream draft older than an upstream change is stale. Upstream map from the suite's reads table: PSP → EVP, list, letter, offer, price, sequence, findability; EVP → letter, offer, page, sequence; price → page. Field changes are tracked by hashing the `psp` / `evp` / `pricing` blocks into `$.store` with a timestamp. | `hooks/drift.ts` |
| Consistency | Page leads with the EVP line (word overlap); every tier name in `gtm/price.json` appears in `gtm/page.json`; the letter uses at least one PSP vocabulary phrase; the sequence uses the buyer phrase. | `hooks/drift.ts` |
| Coverage gaps | Roles in `icp.role_targets` that no prospect-list entry targets. | `hooks/drift.ts` |
| Pricing view | Pocket-price waterfall bars from `pocket_price_waterfall.py --json` (when `gtm/waterfall.csv` exists) and the contrast set from `decoy_validator.py --json` (when `gtm/tiers.json` exists). | `hooks/views.tsx` |
| Prospect board | Call this week / hold / drop columns from `gtm/list.json` (one object or a list), with the signal per account. | `hooks/views.tsx` |
| Cold email view | Sequence touches from `gtm/letter.json`, the Mon/Wed/Fri rhythm, and a deliverability panel from `check_deliverability.py --domain` (needs `dig`, user-triggered). | `hooks/views.tsx` |
| EVP ladder | The five awareness tiers with the chosen tier and line highlighted. | `hooks/views.tsx` |
| GEO view | Days to `kill_date`, citation observations per engine, brand status. | `hooks/views.tsx` |
| Founder brand view | Last post per pillar from `drafts/`, warning past 7 days. | `hooks/views.tsx` |

## v0.5: actions and analytics

| Idea | Design | Where |
|---|---|---|
| Run next | `$.prompt.submit` the next command (asks first via a confirm button). | button |
| Guided sprint | `/gtm-sprint [to <step>]`: submits each pack in order; after each turn, scores it; continues only on pass; stop button. State in `$.state`. | `hooks/sprint.ts` |
| Tools Claude can call | `gtm_status`, `gtm_score` (pack), `gtm_consistency`, served by `tool.call` hooks. | `register.tsx` |
| Review subagent | `gtm-operator:reviewer`: read-only tools, prompt built from the PSP, EVP and SOUL.md rules. | `$.agent.register` |
| Weekly digest | `/gtm-digest` writes `gtm/digest-YYYY-MM-DD.md`: score changes, stale drafts, fixes resolved, outcomes. | `hooks/digest.ts` |
| Analytics | Trends per pack, time per step (from first file to pass), drafts to pass, fixes resolved. | Analytics tab |
| Outcome log | Inputs for replies and meetings this week, stored with the live letter's hash. | Analytics tab |

## Tests

Every behaviour gets a `claude plugin test` case, drawn on terminal and desktop when it draws; pure logic gets unit tests in the same suite. Scorer runs are stubbed with recorded JSON from each pack's examples.
