# The preflight

This page describes `/uaeh-harness:uae-preflight`, the initial audit of a repository before launching it to production. It explains when it is requested, what documents it writes, how the seal with validity works, what it checks depending on the project type, and which verification templates the plugin ships.

## When it is used

The preflight is **on request**: before a production release (the pre-release checklist of `/uaeh-harness:uae-security lanzamiento` requires it) or when the user asks for it by name. It is never triggered on its own: not with a project's first task, not when validity expires, and not through the informational line the plugin shows when a session opens.

It runs in a **separate subagent** (`context: fork`, Sonnet model): it does not see the conversation that called it and returns only a summary of at most 40 lines. It does not edit the application's code (it only writes to `docs/harness/`), does not launch other subagents, and never reads or prints secret values (from `.env` files, only the names).

```
/uaeh-harness:uae-preflight <ruta del repo> [completa|incremental <categorías>] [riesgo critico|alto|medio|bajo] [local]
```

Without a path it uses the current directory. Without a git repository there is no seal and the run ends.

## What it writes

The documents go to the project's `docs/harness/` and are part of its repo:

| Document | Contents |
|---|---|
| `PROJECT_PROFILE.md` | Description, stack, dependencies and the project's real verification commands. |
| `ASSET_DATA_MAP.md` | Assets, data, transfers and owners. |
| `THREAT_MODEL.md` | Prioritized surfaces and threats. |
| `SECURITY_BASELINE.md` | Applicable security requirements and their evidence. |
| `LEGAL_MATRIX.md` | Applicable or to-be-validated legal requirements. |
| `SCALE_PLAN.md` | Architecture, bottlenecks and thresholds. |
| `ACCEPTANCE_MATRIX.md` | Requirement, test and evidence. |
| `AUDIT_REPORT.md` | Findings, impact, priority and owner; includes the run history. |
| `ROUTING_LESSONS.md` | Failures and learned rules (only the header if it did not exist). |

Before auditing, the skill consolidates what already exists: earlier audits, security gate runs, the project's pending items and lessons, and brand guidelines. Each earlier finding is imported with its ID and state; what was already measured is not measured again. Each new finding carries ten fields (ID `SEC-`, `LEG-`, `ESC-` or `DAT-` plus number, evidence, threat, severity, probability and impact, action, test, owner, state and decision). Each control is classified as `APLICA`, `NO_APLICA`, `POR_CONFIRMAR` or `REQUIERE_ABOGADO`; a corroborated finding cites `archivo:línea` and a hypothesis stays `POR_CONFIRMAR`.

### Repos that are not your own

With the `local` argument, before writing, `uaeh-ignorar.cjs --repo <repo> --local --docs-harness --aplicar` is run, which leaves `docs/harness/` in the clone's `.git/info/exclude` and never touches the `.gitignore` of someone else's repo.

## The seal and its validity

When it finishes, the preflight seals the result in `docs/harness/.preflight.json` with the fingerprint of the repo's risk surface. Risk comes from the project (health or money: `critico`; personal data: `alto`; everything else: `medio` or `bajo`; the `riesgo` argument takes precedence) and sets the validity:

| Risk | Validity |
|---|---|
| `critico` | 30 days |
| `alto` | 60 days |
| `medio`, `bajo` | 90 days |

If the seal could not be run, the first line of the response says so, with the command to finish it: without a seal there is no valid preflight.

The fingerprint covers seven categories: `manifiestos`, `esquema`, `auth`, `env`, `despliegue`, `rutas` and `visual`. On the next run:

- **Valid and unchanged:** it answers «preflight vigente, no se repite» (preflight valid, not repeated) and ends (unless `completa` is requested).
- **A category changed, or it expired:** **incremental** run: it reviews the `git diff` since the seal's commit for only those categories.
- **No seal:** full run.

The skill returns **delegations** to the main conversation, which is the one that can launch subagents: `/uaeh-harness:uae-security` (`deep` at critical risk, `standard` at high, `quick` at medium or low), a database or compliance audit with whatever skills the user has, and `/uaeh-harness:uae-visual design-md` or `audit-only` if there is an interface. If the user does not have those skills, the item stays as a gap in `AUDIT_REPORT.md` or as `REQUIERE_ABOGADO`.

## Checks by project type

The reference `checks-por-stack.md` sets which checks to expect depending on the stack. Commands are never copied without validating that they exist in `package.json`, `composer.json`, `pyproject.toml`, `pubspec.yaml`, `Makefile` or CI.

| Stack | Tests | Types or analysis |
|---|---|---|
| Node / TypeScript, Next.js | `npm test` or `pnpm test`, or the real scripts | `tsc --noEmit` or real script; lint |
| Angular / Ionic | Configured test | `tsc` and Angular build |
| PHP / CodeIgniter | PHPUnit if present | PHPStan and PHPCS if present |
| Python / Flask / Django | `pytest` | `mypy` or `pyright`, `ruff` if present |
| Flutter / Dart | `flutter test` | `flutter analyze` |
| Rust | `cargo test` | `cargo check`, `cargo clippy` |

A successful `build` is not equivalent to a functional test. If there are no tests, the gap is flagged. Note measured with Node 24: `node --test` counts an empty test file as "1 passing test", and Node 20 does not expand a glob; the form that works from Node 20 is `node --test --test-reporter=tap` with no path.

## Security, legal matrix and scale

- **Security** (the skill's `seguridad.md`): controls for identity and sessions, server-side authorization, API and data, migrations and backups, infrastructure, with three levels (basic, high, critical) according to the real surface.
- **Legal matrix** (`legal.md`): the jurisdiction comes from `preflight.jurisdiccion` in `uaeh.config.json` (`uaeh-config.cjs jurisdiccion`); if empty, it is deduced from the repo's facts and stays `POR_CONFIRMAR`. **It is not legal advice**: the preflight identifies requirements and generates a checklist, does not issue an opinion and does not replace legal advice from the applicable jurisdiction.
- **Scale** (`escala.md`): a thousand registered users are not a thousand simultaneous ones. It asks for figures on active users, concurrency, target latencies and budget; what cannot be measured stays `POR_CONFIRMAR`. It does not recommend microservices or larger infrastructure just because a certain number of users is reached.

## Verification templates

The plugin ships two templates so that the project has a single verification command: `plugins/uaeh-harness/templates/verify.ps1` (Windows, tested on PowerShell 5.1; untested on 7) and `plugins/uaeh-harness/templates/verify.sh` (bash). The project copies one to `scripts/` and adapts only the block between the "comprobaciones" (checks) markers. The preflight does not copy it on its own.

Output contract: all checks run even if one fails, and a summary is printed.

| Code | Means |
|---|---|
| 0 | Everything passed. |
| 1 | Some check failed. |
| 3 | Nothing failed, but a test check did not demonstrate at least one real test: unknown, never green. |

Test counting is optional per check: `node-tap` mode for `node --test`, or an expression with a group that captures the number (pytest, jest, vitest, PHPUnit, cargo). Commands are fixed text reviewed by a person, never built from a prompt or an external file.

## uaeh-ignorar.cjs

`plugins/uaeh-harness/scripts/uaeh-ignorar.cjs` keeps the gates' local evidence (screenshots, reports, browser session states) from getting into git by accident.

```
node "<plugin>/scripts/uaeh-ignorar.cjs" [--repo <carpeta>] [--local] [--docs-harness] [--aplicar]
```

| Flag | Effect |
|---|---|
| `--repo` | Repository to check. |
| `--local` | Uses the clone's private file (`.git/info/exclude`) instead of `.gitignore`. |
| `--docs-harness` | Adds `docs/harness/`; used with `--local` on repos that are not your own. |
| `--aplicar` | Adds the missing lines, only once, and confirms with `git check-ignore`. Without it, it only reports. |

Exit codes: 0 everything ignored · 1 something missing · 2 error (not a git repo, could not read or write) · 64 incorrect usage.

## Platform

The fingerprint, the seal and the verification templates are tested in CI (Windows and Linux; `verify.ps1` only on Windows PowerShell 5.1). The complete skill is tested on Windows 11.

## See also

- [seguridad.md](seguridad.md) — the gate that the preflight delegates to.
- [visual.md](visual.md) — incremental visual audit and `design-md`.
- [configuracion.md](configuracion.md) — `preflight.jurisdiccion`.
- [diagnostico.md](diagnostico.md) — doctor checks for the preflight gate.
- [arnes.md](arnes.md) — how it relates to the integrity seal and the log.
