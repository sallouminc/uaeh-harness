# Configuration

This page is the reference for `uaeh.config.json`, UAEH's only configuration file, and for the environment variables and `uaeh-config.cjs` subcommands that accompany it. It serves to look up what each key does, its factory value and how it is validated.

## Where it lives and how it is created

The file is `UAEH_HOME/uaeh.config.json`; by default, `~/.claude/uaeh/uaeh.config.json`. It is **the only configuration file and is never per project**: the guards cannot depend on a file that the repo under review could itself change.

It is created with the installer, which copies it from the template `plugins/uaeh-harness/templates/uaeh.config.example.json` and never overwrites an existing one:

```
node "<plugin>/scripts/instalar.cjs" config            # dry run: shows what it would do
node "<plugin>/scripts/instalar.cjs" config --aplicar  # creates it
```

Without the file, everything works with the factory values. `/uaeh-harness:setup` performs this step as part of installation.

## Precedence and validation

From highest to lowest: **command-line flag > `UAEH_*` variable > file > factory value.**

Loading never throws an exception because of a broken configuration. An unknown top-level key produces the warning «clave desconocida en uaeh.config.json … (se ignora)» (unknown key in uaeh.config.json … (ignored)); JSON that does not parse, or a value of the wrong type or out of range, produces a warning and the factory value is used. The warnings are shown by the doctor ([diagnostico.md](diagnostico.md)) and by the line the plugin prints when a session opens. Keys starting with `_` (for example `_comentario`) in the template are notes and have no effect.

## Minimal example

```json
{
  "version": 1,
  "commits": { "credito": "prohibir", "firma": "Authored By: ejemplo.com" },
  "zonaHoraria": "America/Mexico_City",
  "preflight": { "jurisdiccion": "México" }
}
```

The rest of the keys take their factory value; nested sections are merged with the factory ones.

## Keys

### General

| Key | Type | Default | What it controls |
|---|---|---|---|
| `version` | number | `1` | Version of the file format. |
| `idioma` | `auto`, `es`, `en` | `auto` | Language of the texts the kit injects; `auto` is equivalent to Spanish in this version. Any other value gives a warning and falls back to `auto`. |
| `zonaHoraria` | IANA zone | `""` | Zone for the dates the scripts write. Empty: the system's. An invalid zone gives a warning. |

### `commits`

| Key | Type | Default | What it controls |
|---|---|---|---|
| `commits.credito` | `permitir`, `prohibir` | `permitir` | With `prohibir`, the git guard denies Claude's identity or credit in author, committer and message. Secrets and sensitive files are always checked. |
| `commits.firma` | text | `""` | Final line required in messages when credit is prohibited. Empty: no signature. |

### `listaBlanca`

Defines which files require going through the harness (money, accounts, database, production). The patterns are case-insensitive regular expressions over the lowercase relative path; an invalid one is ignored with a warning.

| Key | Type | Default | What it controls |
|---|---|---|---|
| `listaBlanca.excluirRutas` | list of strings | `[]` | Folder names that do not count; added to the factory ones (`tasks`, `docs`, `output`, `builds`, `node_modules`, `.git`, `respaldo`, `respaldos`, `captura`, `capturas`). |
| `listaBlanca.excluirExtensiones` | list of strings | `[]` | Extensions that do not count; added to the factory ones (documents, images, video, `lock`, `css`, `scss`, `map`). |
| `listaBlanca.categorias` | object `{ category: [patterns] }` | `{}` | **Replaces** the factory patterns of that category. The factory ones: `dinero`, `cuentas`, `baseDeDatos`, `produccion`. |
| `listaBlanca.agregar` | object `{ category: [patterns] }` | `{}` | **Adds** patterns to a factory or new category. |

### `arnes`, `reglas`, `statusline`

| Key | Type | Default | What it controls |
|---|---|---|---|
| `arnes.extra` | list of `[folder, pattern, recursive?]` | `[]` | Extra folders that the integrity seal watches. Absolute paths only; relative ones or ones with `~` are ignored with a warning. |
| `reglas.inyectar` | boolean | `true` | Whether the kit injects the method's rules through a hook. With `false` and no block in a `CLAUDE.md`, the kit's doctor marks `FALLÓ`. |
| `statusline.estadoClaude` | boolean | `false` | The status line shows Claude's official status dot and activates the watcher. |
| `statusline.guardarLimites` | boolean | `false` | The status line saves the 5h/7d limits in the cache. |

### `datos`

| Key | Type | Default | What it controls |
|---|---|---|---|
| `datos.runs` | path | `""` | Folder for security gate runs. Empty: `UAEH_HOME/runs`. |
| `datos.retencion.completasDias` | number | `30` | Age from which a run is compacted (only the code copies are deleted). |
| `datos.retencion.borrarDias` | number | `365` | Age from which the entire run is deleted. |
| `datos.retencion.mantenerUltimas` | number | `3` | Most recent runs of each repo that are always kept complete. |
| `datos.retencion.avisoGB` | number | `5` | Total size from which a warning says cleanup is advisable. |

### `wsl`

| Key | Type | Default | What it controls |
|---|---|---|---|
| `wsl.distro` | string | `Ubuntu-24.04` | WSL2 distro where the Linux pieces run. Only letters, digits, `.`, `_` and `-`; otherwise it falls back to the default. |
| `wsl.usuario` | string | `""` | The distro's user. Lowercase; never `root`; otherwise it is left empty. |

### `codex`

Codex is optional and **off by default**. Turning it on sends OpenAI a clean copy of the audited repo (see [codex.md](codex.md) and [privacidad.md](privacidad.md)).

| Key | Type | Default | What it controls |
|---|---|---|---|
| `codex.habilitado` | boolean | `false` | Without `true`, the Codex auditor exits with `NO_HABILITADO` without launching anything. |
| `codex.consentimiento` | string | `""` | Date of consent; written by `instalar.cjs puertas codex --consiento --aplicar`. |
| `codex.modelos.profundo` | `{ modelo, esfuerzo }` | `gpt-6-astra`, `high` | Model of the deep level. `esfuerzo`: `low`, `medium`, `high` or `xhigh`; an incomplete level falls back to the default. |
| `codex.modelos.equilibrado` | `{ modelo, esfuerzo }` | `gpt-6-sol`, `medium` | Balanced level. |
| `codex.modelos.rapido` | `{ modelo, esfuerzo }` | `gpt-6-luna`, `medium` | Fast level. |
| `codex.timeoutDiffMin` | number between 1 and 240 | `10` | Cap, in minutes, for one run of the Codex auditor in `diff` mode. |
| `codex.timeoutCompletaMin` | number between 1 and 240 | `40` | Cap, in minutes, for one run of the Codex auditor in `completa` mode. |

Both caps apply when the auditor is launched without `--timeout-min N`; if it is passed, `--timeout-min` wins. A value that is out of range or not a number produces a warning and the default is used. When the cap is reached, the process tree is killed, and the cap used is recorded in `codex/resumen.json` (`tope_min`).

Requiring the second family (Codex) in the security gate's `lanzamiento` mode is not a key: it is a fixed rule of the skill, which only the person in charge can explicitly waive.

The keys `codex.exigir`, `visual.viewports` and `proyectos` were removed from the configuration. An older file that still has them keeps loading without warnings: they are ignored and can be deleted.

### `visual`, `preflight`

| Key | Type | Default | What it controls |
|---|---|---|---|
| `visual.catalogo` | absolute path | `""` | Own visual catalog. Empty: `catalogo-visual.md` in `UAEH_HOME` if it exists; otherwise the plugin's generic one. |
| `preflight.jurisdiccion` | string | `""` | Jurisdiction of the preflight's legal matrix. Empty: deduced from the repo and marked to be confirmed. |

The visual gate's widths are 360 and 1440, fixed in its templates.

## Environment variables

They override the file. Only the ones a user might need are listed.

| Variable | What it does | Where it is read |
|---|---|---|
| `UAEH_HOME` | UAEH state folder. Default: `<CLAUDE_CONFIG_DIR>/uaeh`. | `scripts/lib/comun.cjs` |
| `CLAUDE_CONFIG_DIR` | Claude Code folder. Default: `~/.claude`. | `scripts/lib/comun.cjs` |
| `CODEX_HOME` | Codex folder. Default: `~/.codex`. | `scripts/lib/comun.cjs`, `instalar.cjs` |
| `UAEH_TZ` | IANA time zone; takes precedence over `zonaHoraria`. | `scripts/lib/comun.cjs` |
| `UAEH_COMMIT_CREDITO` | `permitir` or `prohibir`; overrides `commits.credito`. | `scripts/lib/config.cjs` |
| `UAEH_COMMIT_FIRMA` | Text; overrides `commits.firma`. | `scripts/lib/config.cjs` |
| `UAEH_RUNS_DIR` | Runs folder; overrides `datos.runs`. | `scripts/lib/config.cjs` |
| `UAEH_WSL_DISTRO` | WSL distro; overrides `wsl.distro`. | `scripts/lib/config.cjs` |
| `UAEH_WSL_USER` | WSL user; overrides `wsl.usuario`. | `scripts/lib/config.cjs` |
| `CODEX_JS` | Path to `@openai/codex/bin/codex.js` if the auditor does not find the Codex CLI. | `skills/uae-security/scripts/auditor-codex.cjs` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Context compaction cap (accepts `700000`, `700k`, `1M`); takes precedence over what `settings.json` says. | `uaeh-kit/scripts/ventana-contexto.cjs` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Fixed model for subagents. It is defined in the `env` section of `settings.json`; the kit's doctor checks it and `/uaeh-kit:setup settings` proposes it. | `uaeh-kit/scripts/doctor.cjs` |

## uaeh-config.cjs subcommands

`plugins/uaeh-harness/scripts/uaeh-config.cjs` hands values from the configuration to the skills without writing a machine's paths. Each subcommand prints **one line** and exits with 0; incorrect usage writes the message to stderr and exits with 64. It creates no folders and writes nothing.

| Subcommand | Prints |
|---|---|
| `runs-dir [--repo <carpeta>]` | The runs folder (`datos.runs`, `UAEH_RUNS_DIR` or `UAEH_HOME/runs`); with `--repo`, that repo's subfolder. |
| `ahora-local` | Current date and time in the configured zone (ISO 8601 with offset). |
| `prefijo-motor` | What goes before a Linux program: on Windows, `wsl.exe -d <distro> [-u <usuario>] -e`; on Linux, an empty line. |
| `prefijo-caja` | The previous prefix plus `/opt/uaeh/bin/uaeh-sandbox ejecutar` (the sandbox). |
| `ruta-motor <ruta>` | The path as the Linux engine sees it (on Windows, `/mnt/<letter>/…`; on Linux, the same). |
| `catalogo-visual` | Path of the visual catalog in force. |
| `jurisdiccion` | `preflight.jurisdiccion` on one line; empty if not configured. |

## See also

- [instalacion.md](instalacion.md) — how the file is created during installation.
- [arnes.md](arnes.md) — git guard, whitelist and seal, which read these keys.
- [codex.md](codex.md) — Codex consent and models.
- [visual.md](visual.md) and [preflight.md](preflight.md) — `visual` and `preflight` keys.
- [diagnostico.md](diagnostico.md) — how to see configuration warnings.
