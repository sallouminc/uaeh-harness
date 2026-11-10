# Installation

This page explains what is needed before installing UAEH, how to install the marketplace and the two plugins, what each `setup` step does, how to check the result with the doctors, and how to update. Each installer first works as a "dry run" («en seco»): it shows what would change and only writes with `--aplicar` (apply).

## Requirements per layer

| Layer | Requirements |
|---|---|
| All | Node 20 or later on the `PATH`; Claude Code 2.1.295 or later |
| 1. `uaeh-kit` | Node only. The hooks are Node scripts and do not require Git Bash |
| 2. `uaeh-harness` (harness) | Git 2.31 or later. On Windows, Git for Windows (its `sh` runs the git hooks) |
| 3. Security gate | Ubuntu 24.04 x86_64: on Windows 11, WSL2 with systemd; or Linux directly. Also Docker and Python 3 (the Linux installer requires `python3`). See [plataforma.md](plataforma.md) |
| 3. Visual gate | Playwright (Chromium of the pinned version), `playwright-cli`, and Chrome |
| Optional | Codex CLI 0.163.0 or later, only for the Codex auditor. See [codex.md](codex.md) |

Node is essential and is checked before installing with `node --version` in the terminal: the doctors are Node scripts and cannot run without Node. Without Node, `uaeh-kit` leaves the session working but injects nothing (each hook ends as a non-blocking error: `Executable not found in $PATH: "node"`). With `uaeh-harness`, **every Bash and PowerShell command is blocked** with the message `PreToolUse:Bash hook error: […guardia-git.js]: failed; blocking because onFailure is "block"`: this is intentional, because the guard fails closed. The fix is to install Node 20 or later and reopen the sessions, or to disable the plugin with `/plugin disable uaeh-harness`.

## Installing the plugins

A plugin is a package that Claude Code loads to add skills (commands such as `/uaeh-kit:setup`), agents, and hooks. In a Claude Code session:

```
/plugin marketplace add sallouminc/uaeh-harness
/plugin install uaeh-kit@uaeh
/plugin install uaeh-harness@uaeh
```

Then run the `setup` of each plugin and, at the end, the doctor of each one:

```
/uaeh-kit:setup
/uaeh-harness:setup
/uaeh-kit:doctor
/uaeh-harness:doctor
```

To try a plugin without installing it, from a clone of the repository: `claude --plugin-dir ./plugins/uaeh-kit` (or `./plugins/uaeh-harness`).

If the installation of `uaeh-harness` fails with `EPERM` on a file under `vendor/`, the probable cause is an endpoint antivirus that takes a vulnerable-code example from the bundled security guides for malware. The fix and the details are in [diagnostico.md](diagnostico.md).

## Close and reopen all sessions

> **After installing or updating, it is mandatory to close and reopen ALL Claude Code sessions**: every open terminal and the standalone Claude app.

A session opened before the installation does not load the new hooks or agents, and `/clear` does not fix it. The typical symptom is that the guards are not applied in that session even though the doctor says everything is fine. Steps:

1. Close every session (`/exit` in the terminals; close the window of the standalone Claude app).
2. Open a new session in the project folder.
3. Run `/uaeh-kit:doctor` and check that the context injection shows `OK`.

## What `setup` does in layer 1

`/uaeh-kit:setup [todo | claude-md | settings | statusline | proyecto [carpeta]]` runs `plugins/uaeh-kit/scripts/instalar.cjs`. With no argument it is equivalent to `todo` (all), which is `claude-md` (global) + `settings` + `statusline`. `proyecto` (project) is not part of `todo`.

| Subcommand | What it writes |
|---|---|
| `claude-md` | The rules block between `<!-- UAEH:BEGIN -->` and `<!-- UAEH:END -->` at the end of the global `CLAUDE.md` (`--proyecto <dir>` puts it in a project's one). `--idioma es\|en`. `--quitar` (remove) removes the block |
| `settings` | In Claude Code's `settings.json`, only the missing keys: `env.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet"` and `autoCompactWindow = 700000` |
| `statusline` | Copies the status line to `UAEH_HOME/estable/` and registers it as `statusLine` in `settings.json` only if there is no other status line |
| `proyecto <dir>` | Creates `CLAUDE.md` and `tasks/context-map.md`, `tasks/todo.md`, `tasks/lessons.md` from templates, without overwriting anything that exists |

## What `setup` does in the harness

`/uaeh-harness:setup [config | git-guard | codex | visual | todo | puertas <puerta>]` runs `plugins/uaeh-harness/scripts/instalar.cjs`. `todo` is `config` + `git-guard` (+ `codex` if `codex.habilitado` is `true`). `visual` and `puertas` (gates) are not part of `todo`.

| Subcommand | What it does |
|---|---|
| `config` | Creates `UAEH_HOME/uaeh.config.json` from the template; never overwrites an existing one |
| `git-guard` | Copies the git guard to the mirror `UAEH_HOME/estable/uaeh-harness/`, tests it in a temporary repository (a clean commit passes; a `.env` and a fake secret are rejected) and only if the test passes sets the global git configuration to point to the mirror. A foreign value already set (husky or another guard) is not overwritten: it is reported; `--reemplazar` (replace) replaces it and records it so it can be restored |
| `codex` | Optional. Writes the UAEH block into `~/.codex/AGENTS.md` and the `uae_*.toml` agents; prints the `config.toml` snippet to paste by hand. See [codex.md](codex.md) |
| `visual --proyecto <carpeta>` | Copies the Playwright and axe templates to a project, and the `DESIGN.md` if missing. See [visual.md](visual.md) |
| `puertas [seguridad\|visual\|codex\|preflight\|todas]` | Installs or repairs only what the gates doctor found missing. See below |

In layer 1 the backup has the form `<archivo>.uaeh-respaldo-<AAAAMMDD-HHmmss>`, next to the original file. The installers do not delete anything.

### Two `config` decisions

After creating `uaeh.config.json`, `setup` asks two things: whether Claude credit in commit messages is prohibited and with which signature (`commits.credito`, `commits.firma`), and which of the user's own file names always count as money, accounts, database, or production (`listaBlanca.agregar`). The remaining keys are in [configuracion.md](configuracion.md).

### Installing the layer 3 gates

```
node "<plugin>/scripts/instalar.cjs" puertas seguridad
node "<plugin>/scripts/instalar.cjs" puertas seguridad --aplicar
```

On Windows, with `--aplicar`, the installer first copies `/opt/uaeh` to `/opt/uaeh-respaldo/<fecha>` and runs the Linux installers as root inside WSL. On Linux it prints the commands with `sudo` for the user to run. Anything that requires an administrator, a password, or closing other sessions (installing WSL, `wsl --terminate`, `codex login`) is printed and never executed. Details of the Linux engine are in [plataforma.md](plataforma.md).

## Checking with the doctors

The doctors only read; the self-tests work in temporary folders that are deleted.

| Command | What it checks |
|---|---|
| `/uaeh-kit:doctor` | 15 layer 1 checks, including the proof that the context injection reached the model |
| `/uaeh-harness:doctor arnes` | Layer 2: git, global guard and its mirror, duplicate hooks, personal copies of agents, three self-tests (`--rapido` (quick) skips them) |
| `/uaeh-harness:doctor puertas` | One verdict per gate: `LISTA`, `NO_INSTALADA`, `NO_LISTA`, or `APAGADA` |

The statuses of each check are `OK | AVISO | FALLÓ | OMITIDA | NO_INSTALADA | NO_APLICA`. An `OMITIDA` (skipped) was not measured and never equals `OK`. How to interpret each failure: [diagnostico.md](diagnostico.md).

## Updating

```
claude plugin marketplace update uaeh
claude plugin update uaeh-kit@uaeh
claude plugin update uaeh-harness@uaeh
```

Before continuing, it is worth confirming that no other terminal has a review in progress: installing while a seal is open changes the measured harness and voids that review's verdict. The harness commands with `--aplicar` refuse in that case; wait, or repeat with `--forzar` ([arnes.md](arnes.md)).

Then, from the installed copy of the plugin:

```
node "<plugin>/scripts/instalar.cjs" git-guard --aplicar
node "<plugin>/scripts/instalar.cjs" puertas seguridad --actualizar --aplicar
```

The first one refreshes the git guard mirror. The second is only needed if layer 3 exists: `--actualizar` (update) copies the `/opt/uaeh` programs again (and `--reparar` (repair) forces both Linux installers). When finished, close and reopen all sessions (previous section).

## See also

- [kit.md](kit.md)
- [arnes.md](arnes.md)
- [plataforma.md](plataforma.md)
- [diagnostico.md](diagnostico.md)
- [desinstalar.md](desinstalar.md)
