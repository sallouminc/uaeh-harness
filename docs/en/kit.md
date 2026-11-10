# Layer 1: the efficiency kit

This page describes `uaeh-kit`, the layer 1 plugin: what each piece does, which hooks it installs, why none of them blocks anything, and how to remove each thing. It is the layer the measured savings come from; the other two layers buy control, not savings.

The kit only informs. No hook blocks a tool, edits a file on its own, or sends data off the machine. The hooks always exit with code 0 and, if something fails, stay silent.

## Pieces

| Piece | What it does |
|---|---|
| Context injection | When each session opens, it prepends the marker `[uaeh-kit ctx v1]`, the compact method rules (about 900 characters), and the project's `tasks/context-map.md` (up to 7,500 characters, searched in the working folder and up to 4 folders above it). The compact rules are omitted if any loaded `CLAUDE.md` already carries the `UAEH:BEGIN…END` block or if `reglas.inyectar` is `false`. With no map, one line points to `/uaeh-kit:setup proyecto` |
| Context window watcher | When the session opens, it warns if any `CLAUDE.md` that Claude Code will load exceeds 40,000 characters. On every message it reads the last usage line of the transcript and warns once per session at 80% and once more at 90% of the compaction limit |
| Per-project context map | A short file (`tasks/context-map.md`) with what the project is, commands, key files, what not to read, and pitfalls. It is injected automatically, so the session starts without rediscovering the project |
| Rules block | The full method rules between `<!-- UAEH:BEGIN v… -->` and `<!-- UAEH:END -->`, in the global `CLAUDE.md` or a project's one |
| Recommended settings | `CLAUDE_CODE_SUBAGENT_MODEL = "sonnet"` (subagents use the cheaper model) and `autoCompactWindow = 700000`, the limit measured by the author with a 1M window; with smaller windows it should be adjusted |
| Status line | Model, effort, 5-hour and 7-day limits, session duration, folder, and a context bar measured against the compaction limit, not against the raw window. Red means close the work block |
| CLAUDE.md diet | Moves the dated chronicle of an oversized `CLAUDE.md` to `tasks/bitacora.md`, without losing or rewriting lines |
| Measurement | Four read-only scripts over the local transcripts. See [medicion.md](medicion.md) |

The reason for the diet: a project's `CLAUDE.md` is re-read in full on every turn of every session and every subagent, and a large part of the cost of a long session is re-reading context, not writing.

## Skills

A skill is a command that Claude Code offers once the plugin is installed.

| Skill | What it does |
|---|---|
| `/uaeh-kit:setup [todo\|claude-md\|settings\|statusline\|proyecto [carpeta]]` | Dry-run plan, confirmation, and application with backups; fills in the project map with real content from the repository. See [instalacion.md](instalacion.md) |
| `/uaeh-kit:doctor` | 15 checks with statuses `OK \| AVISO \| FALLÓ \| OMITIDA \| NO_INSTALADA \| NO_APLICA`. With `--proponer` (propose) it leaves a `settings.uaeh-propuesto.json` without duplicate hooks and does not touch the original |
| `/uaeh-kit:medir [días]` | Runs the four measurement scripts and recommends at most three actions |
| `/uaeh-kit:dieta` | Slims down a `CLAUDE.md` above 40,000 characters and proves, line by line against git, that nothing was lost. It must end with `RESULTADO: PASS` |

Only `dieta` can be invoked by the model on its own; `setup`, `doctor`, and `medir` are run by hand.

## Hooks it installs

The three hooks are in `plugins/uaeh-kit/hooks/hooks.json`. They use the exec form (`command` is `node` and the script goes in `args`), with no intermediate shell, so they do not depend on Git Bash or on paths with spaces.

| Event | Script | Maximum time |
|---|---|---|
| `SessionStart` | `hooks/inyectar-contexto.js` | 5 s |
| `SessionStart` | `hooks/vigia-contexto.js inicio` | 5 s |
| `UserPromptSubmit` | `hooks/vigia-contexto.js prompt` | 5 s |

None blocks: they do not use `onFailure`, a failing hook is deliberately ignored, and none exits with code 2 (the one that would block a message).

## What the kit writes and reads

- Reads: the session transcript (for the usage line), `settings.json` (for the compaction limit), the `CLAUDE.md` files Claude Code would load, and `tasks/context-map.md`.
- Writes only with `setup --aplicar` (always with a backup `<archivo>.uaeh-respaldo-<AAAAMMDD-HHmmss>`) and with the doctor's `--proponer`; also one-line markers («ya avisé», "already warned") in the system temporary folder, and caches in `UAEH_HOME/cache/` only if they are enabled.
- Network: none, unless `statusline.estadoClaude` is `true` (off by default): then a background script queries `status.claude.com` at most every 90 seconds.

More detail in [privacidad.md](privacidad.md).

## Configuration specific to this layer

In `UAEH_HOME/uaeh.config.json` (by default `~/.claude/uaeh/uaeh.config.json`):

| Key | Effect |
|---|---|
| `idioma` | `auto` (Spanish in version 1), `es`, or `en` for the injected rules and the block |
| `zonaHoraria` | IANA zone for the dates of backups and reports; empty uses the system's |
| `reglas.inyectar` | When `false`, the compact rules are never injected (the map still is) |
| `statusline.estadoClaude` | When `true`, the status line shows the official Claude status (makes network requests) |
| `statusline.guardarLimites` | When `true`, writes the limit percentages to `UAEH_HOME/cache/rate-limits-cache.json` |

Unknown keys are reported as a warning and ignored; a broken file falls back to the default values. The full reference is in [configuracion.md](configuracion.md).

## How to remove each thing

| What | How |
|---|---|
| All the kit's hooks and skills | Disable the plugin with `/plugin disable uaeh-kit` |
| Only the compact rules injection | `reglas.inyectar: false` in `uaeh.config.json` |
| Rules block in `CLAUDE.md` | `node "<plugin>/scripts/instalar.cjs" claude-md --quitar --aplicar` (with `--proyecto <dir>` for a project's one) |
| `settings.json` keys (`CLAUDE_CODE_SUBAGENT_MODEL`, `autoCompactWindow`) | `node "<plugin>/scripts/instalar.cjs" settings --quitar --aplicar`. It removes them only if they still hold the value the kit wrote |
| Status line | `node "<plugin>/scripts/instalar.cjs" statusline --quitar --aplicar`. It removes `statusLine` if it points to the kit's bar and deletes the files the kit copied to `UAEH_HOME/estable/` |
| All of the above at once | `node "<plugin>/scripts/instalar.cjs" todo --quitar --aplicar` |
| Project files (`CLAUDE.md`, `tasks/*`) | There is no command; they are normal project files and are deleted or edited like any other |

The full order for removing all of UAEH is in [desinstalar.md](desinstalar.md).

## See also

- [instalacion.md](instalacion.md)
- [medicion.md](medicion.md)
- [configuracion.md](configuracion.md)
- [arnes.md](arnes.md)
- [privacidad.md](privacidad.md)
