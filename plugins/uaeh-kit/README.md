# uaeh-kit — UAEH layer 1: the method plus a token-efficiency kit

**[Leer en español → README.es.md](README.es.md)**

`uaeh-kit` packages the part of the UAEH method where the measured savings come from: rules that keep the main conversation small, a context map injected at the start of every session, a watchdog that tells you when to close the session, a CLAUDE.md "diet" with a checker that proves nothing was lost, measurement scripts over your own local transcripts, and an optional status line with a context bar.

**Informative only.** Nothing in this plugin blocks a tool call, edits a file on its own, or sends anything off your machine. Hooks always exit 0; if something fails, they stay silent.

## Install

```
/plugin install uaeh-kit --marketplace sallouminc/uaeh-harness
```

(or `/plugin marketplace add sallouminc/uaeh-harness` then `/plugin install uaeh-kit@uaeh`). Requires **Node ≥ 20** on your PATH (the hooks are Node scripts; no Git Bash needed). Then:

```
/uaeh-kit:setup       # dry-run plan → confirm → rules block, settings, optional status line, project map
/uaeh-kit:doctor      # what is installed, what is missing, whether the injection really reaches the model
```

To try it without installing: `claude --plugin-dir ./plugins/uaeh-kit` from a clone of this repository.

## What it adds to a session

| Piece | Where | What it does |
|---|---|---|
| **Context injection** | hook `SessionStart` | Prepends the marker `[uaeh-kit ctx v1]`, then the compact rules of the method (≈ 900 characters; skipped when your CLAUDE.md already carries the full `UAEH:BEGIN…END` block or `reglas.inyectar` is `false`), then your project's `tasks/context-map.md` (up to 7,500 characters, searched up to 5 folders above the working directory). Without a map it prints one line pointing to `/uaeh-kit:setup proyecto`. |
| **Context watchdog** | hooks `SessionStart`, `UserPromptSubmit` | At startup, warns if any CLAUDE.md that Claude Code will load (project chain or global) is over 40,000 characters. On each prompt, reads the last usage line of the session transcript and warns **once per session** at 80 % and again at 90 % of the compaction cap. |
| **Rules block** | `templates/bloque-claude-md.md` (ES) / `.en.md` | The full method rules between `<!-- UAEH:BEGIN v… -->` and `<!-- UAEH:END -->`, inserted at the end of your global or project CLAUDE.md by `setup claude-md`. Re-running replaces the block in place; `--quitar` removes it. |
| **Settings snippet** | `templates/settings-snippet.json` | `env.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet"` and `autoCompactWindow = 700000`. `setup settings` adds only the keys you don't already have, with a backup. 700,000 is the value the author measured with a 1M-token window; adjust for smaller windows. |
| **Project templates** | `templates/proyecto/` | `CLAUDE.md`, `tasks/context-map.md`, `tasks/todo.md`, `tasks/lessons.md`. `setup proyecto` copies them without overwriting and then the skill fills the map with real content from your repo. |
| **Status line** | `statusline/` | Model, effort, 5-hour and 7-day rate limits, session duration, folder, and a context bar measured against the **compaction cap**, not the raw window (so red means "close the block now"). Optional; `setup statusline` copies it to a fixed path (`UAEH_HOME/estable/`) and registers it only if you have no status line. |
| **Measurement** | `scripts/uso-*.cjs`, `uaeh-listado-skills.cjs` | Tokens re-read per model and project, loose steps vs parallel, agents and skills used, and the size of the skill listing injected into every session. Read-only over your local transcripts; they never print conversation content. `/uaeh-kit:medir` runs all four and interprets them. |
| **Diet** | `/uaeh-kit:dieta` + `scripts/verificar-dieta-claudemd.cjs` | Moves the dated chronicle of a fat CLAUDE.md to `tasks/bitacora.md`. The checker proves, line by line against git, that nothing was lost or paraphrased. |

### Every hook, with the exact command it runs

From `hooks/hooks.json` (`${CLAUDE_PLUGIN_ROOT}` is the plugin's install folder). They use the *exec form* (`command` is the executable, the script goes in `args`): no shell is involved, so paths with spaces and machines without Git Bash are fine.

| Event | Executable | Arguments | Timeout |
|---|---|---|---|
| `SessionStart` | `node` | `${CLAUDE_PLUGIN_ROOT}/hooks/inyectar-contexto.js` | 5 s |
| `SessionStart` | `node` | `${CLAUDE_PLUGIN_ROOT}/hooks/vigia-contexto.js inicio` | 5 s |
| `UserPromptSubmit` | `node` | `${CLAUDE_PLUGIN_ROOT}/hooks/vigia-contexto.js prompt` | 5 s |

None of them uses `onFailure`; a failing hook is ignored by design, and none of them ever exits with code 2 (which would block a prompt).

## Skills

| Skill | Model may invoke it? | What it does |
|---|---|---|
| `/uaeh-kit:setup [todo\|claude-md\|settings\|statusline\|proyecto [dir]]` | no | Dry-run plan, confirmation, then applies with backups; fills the project map with real content. |
| `/uaeh-kit:doctor` | no | 15 checks with states `OK · AVISO · FALLÓ · OMITIDA · NO_INSTALADA · NO_APLICA`; `--proponer` writes a proposed `settings.json` without duplicated hooks (never edits the original). |
| `/uaeh-kit:medir [days]` | no | Runs the four measurement scripts in one command and recommends at most three actions. |
| `/uaeh-kit:dieta` | yes | The CLAUDE.md diet, verified. |

## Configuration (optional)

Single user-level file `UAEH_HOME/uaeh.config.json` (`UAEH_HOME` defaults to `<claude config dir>/uaeh`, i.e. `~/.claude/uaeh`; `CLAUDE_CONFIG_DIR` is honored). Keys used by this layer:

```json
{
  "idioma": "auto",
  "zonaHoraria": "",
  "reglas": { "inyectar": true },
  "statusline": { "estadoClaude": false, "guardarLimites": false }
}
```

- `idioma`: `auto` (Spanish in v1), `es` or `en` for the injected rules and the rules block.
- `zonaHoraria`: IANA zone for timestamps in backups and reports; empty = system zone (`UAEH_TZ` overrides).
- `reglas.inyectar`: set `false` to never inject the compact rules (the map is still injected).
- `statusline.estadoClaude`: when `true`, the status line shows the official Claude status dot and a background script queries `status.claude.com` at most every 90 s. **Off by default: with it off, the kit makes no network requests at all.**
- `statusline.guardarLimites`: when `true`, writes your rate-limit percentages to `UAEH_HOME/cache/rate-limits-cache.json` for external dashboards. Off by default.

Unknown keys are reported by the doctor as warnings and ignored. A broken file falls back to defaults.

## Privacy and footprint

- Reads: the session transcript (`transcript_path` given by Claude Code) for the usage line; your `settings.json` for the compaction cap; CLAUDE.md files Claude Code would load; `tasks/context-map.md`. The measurement scripts read `.jsonl` transcripts under the Claude config folder and only extract usage numbers and tool, agent and skill names.
- Writes: only through `setup --aplicar` (with backups) and the doctor's `--proponer`; one-line "already warned" markers in the OS temp folder; caches under `UAEH_HOME/cache/` only when opted in.
- Network: none, unless `statusline.estadoClaude` is `true`.

## Platform

Tested by the author on Windows 11 (Node 24). Linux and macOS: layer 1 is plain Node and should work; the unit tests run on `ubuntu-24.04` and `windows-latest` in CI. Prompts and messages are in Spanish in v1; the JSON contracts (`--json` of doctor and measurement scripts) are stable.
