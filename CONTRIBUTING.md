# Contributing

Issues and pull requests are welcome.

Before you open a pull request:

```bash
claude plugin validate .
claude plugin test .
```

Both must pass; CI runs them on every push. Develop against the folder with `claude --plugin-dir .` so edits hot-reload.

- The step walk must match [`/gtm:next`](https://github.com/cmj-hub/gtm-operator-skills/blob/main/suite/skills/next/SKILL.md). Change both together.
- Keep the mod's reach small: no network, no processes, no writes in the user's project. A change that adds a call to the `calls:` line of `claude plugin validate` needs a line in the README's "What it can reach" and in `SECURITY.md`.
- Add a test for each behaviour, drawn on both `terminal` and `desktop` when it draws.
- Bump the version in `.claude-plugin/plugin.json` and add a `CHANGELOG.md` entry.
- Re-render images after changing `assets/spec.json`, `lockup.html`, `demo.html` or `logo.svg`.
