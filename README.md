# claude-kit

Claude Code plugins by hal-9, MIT licensed, in one marketplace (`hal-9`). Two kinds:

- **Mods** change Claude Code's own interface: a band, a button, a guard. One folder each under `mods/`.
- **Flows** run a piece of work from start to end with agents and skills. One folder each under `flows/`.

| Plugin | Kind | What it does |
| --- | --- | --- |
| [baton](mods/baton) | mod | Measures real context use per model request, stops subagents that run too long or too big, hands remaining work to a fresh session. |
| [relay](mods/relay) | mod | Role buttons above the prompt: review or adversarially review the working tree with Codex, hand a task to Codex, or verify with a second Claude model; findings become fix prompts. |
| [cache-meter](mods/cache-meter) | mod | Band above the prompt: prompt-cache countdown, cache hit rate of the last request, context fill against auto-compact, and a Compact button. |
| [mod-switch](mods/mod-switch) | mod | Footer menu that switches your mods on and off per session. |
| [story-loop](flows/story-loop) | flow | One command takes a Shortcut story or a GitHub issue to a reviewed draft PR: signed-off plan, workers building test-first, mutants on the diff, a browser check with screenshots, a second-model review and a Copilot review, all on a live board. [How it works](flows/story-loop/README.md). Experimental, in a supervised pilot. |
| [savvy-flow](flows/savvy-flow) | flow | Fork of johnnyvizz/claude-kit's savvy-flow: tiered workers build test-first at named seams; a code-review pass closes the flow. |

## Install

```
/plugin install baton --marketplace hal-9/claude-kit
```

Answer `y` to add the marketplace, pick the user scope. Repeat with another plugin's name for the next one. Installed plugins are named `<plugin>@hal-9`.

This repository was called `claude-mods` and its marketplace `claude-mods`. If you installed from it before, remove that marketplace and install again from this one.

## Add a plugin

1. A mod goes in `mods/<name>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts` and a README. A flow goes in `flows/<name>/` with its skills and agents.
2. Add it to `.claude-plugin/marketplace.json`.
3. `claude plugin validate <folder>`, and `claude plugin test <folder>` for a mod.
