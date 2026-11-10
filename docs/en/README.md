# UAEH Documentation

This index gathers the pages of the UAEH user documentation (version 1.0) and indicates which one to read depending on what is needed. Each page explains one topic in full and links to its neighbors.

UAEH is a working method for programming with AI agents, packaged as two Claude Code plugins: `uaeh-kit` (layer 1, informs only) and `uaeh-harness` (layers 2 and 3, with hooks that can block an action). A hook is a small program that Claude Code runs automatically at certain moments of the session.

[Español](../es/README.md)

## If looking for X, go to page Y

| If looking for… | Page |
|---|---|
| Installing, updating, or checking that everything works | [instalacion.md](instalacion.md) |
| The method rules, the context watcher, the status line, the CLAUDE.md diet | [kit.md](kit.md) |
| The verification circuit: independent reviewers, integrity seal, task log, closing guard, git guard | [arnes.md](arnes.md) |
| The security gate (scanners, Codex auditor, sandbox) | [seguridad.md](seguridad.md) |
| The in-browser visual audit and the design audit | [visual.md](visual.md) |
| The launch preflight and its nine documents and its seal with an expiry | [preflight.md](preflight.md) |
| Using Codex as a second engine and what is sent to OpenAI | [codex.md](codex.md) |
| All the keys of `uaeh.config.json` and the environment variables | [configuracion.md](configuracion.md) |
| Which operating systems are supported, tested, or untested | [plataforma.md](plataforma.md) |
| Diagnosing a problem or interpreting a verdict from the doctors | [diagnostico.md](diagnostico.md) |
| Removing UAEH without leaving the machine half-configured | [desinstalar.md](desinstalar.md) |
| What UAEH reads and writes, and what leaves the machine | [privacidad.md](privacidad.md) |
| Measuring your own usage and reproducing the evidence table | [medicion.md](medicion.md) |

## Recommended reading order

1. [instalacion.md](instalacion.md): requirements, installing the two plugins, and checking with the doctors.
2. [kit.md](kit.md): layer 1. It is the one that produces the measured savings and the only one that blocks nothing.
3. [arnes.md](arnes.md): layer 2. It adds control over high-risk changes (money, accounts, database, production with real data).
4. The layer 3 gates, as needed: [seguridad.md](seguridad.md), [visual.md](visual.md), [preflight.md](preflight.md) and, if a second engine is wanted, [codex.md](codex.md).
5. Consult when needed: [configuracion.md](configuracion.md), [plataforma.md](plataforma.md), [diagnostico.md](diagnostico.md), [privacidad.md](privacidad.md), [medicion.md](medicion.md) and [desinstalar.md](desinstalar.md).

## The three layers, in a table

| Layer | Plugin | What it provides | Blocks |
|---|---|---|---|
| 1. Method and efficiency kit | `uaeh-kit` | Rules, context map, context window watcher, CLAUDE.md diet, measurements, status line | No |
| 2. Verification harness | `uaeh-harness` | Independent reviewers, integrity seal, log, closing guard, git guard | Yes |
| 3. Gates | `uaeh-harness` | Security, visual, and preflight | Yes, in the reviewer part |

## Conventions of this documentation

- Terminal commands go in code blocks. `<plugin>` is the folder where Claude Code installed the plugin; `<carpeta del proyecto>` (the project folder) is the working repository.
- `UAEH_HOME` is the UAEH state folder: by default `~/.claude/uaeh`.
- The statuses of the checks (`OK`, `AVISO`, `FALLÓ`, `OMITIDA`, `NO_INSTALADA`, `NO_APLICA`) and the gate verdicts (`LISTA`, `NO_INSTALADA`, `NO_LISTA`, `APAGADA`) are written exactly as the software prints them.
- The installers work as a dry run by default: only `--aplicar` (apply) writes, and it leaves a backup of whatever it overwrites.

## See also

- [instalacion.md](instalacion.md)
- [kit.md](kit.md)
- [plataforma.md](plataforma.md)
