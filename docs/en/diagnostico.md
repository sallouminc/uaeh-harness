# Diagnostics and troubleshooting

This page describes UAEH's three doctors (read-only diagnostic programs), the tool that cleans up security runs, and a table of frequent problems with their cause and remedy. It is the first place to look when something does not behave as expected.

## The three doctors

| Doctor | Skill | Script | What it checks |
|---|---|---|---|
| Layer 1 | `/uaeh-kit:doctor` | `plugins/uaeh-kit/scripts/doctor.cjs` | The kit: Node, Claude Code, hooks, config, rule injection, `CLAUDE.md`, status line. |
| Layer 2 | `/uaeh-harness:doctor` | `plugins/uaeh-harness/scripts/doctor.cjs` | The harness: git, git guard, mirror, locks, seal, closing guard. |
| Layer 3 | `/uaeh-harness:doctor puertas` | `plugins/uaeh-harness/scripts/doctor-puertas.cjs` | The gates (`puertas`): security, visual, codex and preflight. |

`/uaeh-harness:doctor` runs the two harness ones (layer 2 and gates). Both skills are invoked by hand only.

**States of each check** (common to all three): `OK` · `AVISO` (warning: works, but not as the method recommends) · `FALLÓ` (failed: something is broken) · `OMITIDA` (skipped: not measured; never counts as OK) · `NO_INSTALADA` (not installed) · `NO_APLICA` (not applicable). The `--json` outputs and the states are not translated.

### Layer 1 doctor (kit)

```
node "<plugin>/scripts/doctor.cjs" [--capa kit|todo] [--cwd <dir>] [--json] [--proponer]
```

`--capa todo` is equivalent to `kit`. Exit codes: 0 with no `FALLÓ` · 1 with `FALLÓ` · 2 incorrect usage. It only reads; the only possible write is that of `--proponer`, which leaves, next to each `settings.json` with duplicate hooks, a separate file `<nombre>.uaeh-propuesto.json` without the duplicates. **The original is never touched**; adopting the proposal is the user's decision.

Checks: `node` (≥ 20) · `claude-code` (recommended version ≥ 2.1.295) · `rutas` (state folders writable) · `hooks-json` (each hook points to a script that exists) · `duplicados` (hooks from an earlier manual installation in `settings.json`) · `config` (validity of `uaeh.config.json`) · `tope-compactacion` (context cap; recommended 700000) · `transcripciones` (readable format) · `inyeccion` (the rules marker appears in recent transcripts) · `claude-md-tamano` (warning about the character limit) · `bloque-reglas` (method block up to date) · `statusline` · `espejo` (mirror version equal to the plugin's) · `skills-listado` · `subagente-modelo`.

### Layer 2 doctor (harness)

```
node "<plugin>/scripts/doctor.cjs" [--cwd <dir>] [--json] [--rapido]
```

`--rapido` skips the three self-tests, which are left `OMITIDA`. Without it, it takes a few seconds longer. Codes: 0 with no `FALLÓ` · 1 with `FALLÓ` · 2 incorrect usage. It only reads: the self-tests work in their own temporary folders that are deleted, and the doctor never edits `settings.json`, agents or skills; it only points out duplicates and copies.

Checks: `node` · `git` (≥ 2.31) · `rutas` · `config` · `hooks-json` · `duplicados` (hooks in `settings.json` that the plugin already registers) · `copias-personales` (personal agents or skills with the same name as the plugin's) · `guarda-git` (the global `core.hooksPath` points to the mirror) · `espejo` (equal to the plugin) · `humo` (smoke self-test of the guard in a temporary repo) · `candado` (self-test: a reviewer refuses to delete, the main session passes) · `sello` (self-test: `INTACTO` and then `ROTA`) · `guardia-cierre` (on or off) · `politica-commits` (credit and signature in force) · `sellos-abiertos` (`OK` with no reviews open in other terminals; `AVISO` with N open, because installing or changing the configuration at that moment would void their verdict).

### Gates doctor (layer 3)

```
node "<plugin>/scripts/doctor-puertas.cjs" [--puerta seguridad|visual|codex|preflight] [--todas] [--rapido | --vivo] [--json]
```

Without `--puerta` it checks all four; `--puerta` accepts several, repeated or separated by commas. `--rapido` and `--vivo` do not go together.

| Flag | Effect |
|---|---|
| `--rapido` | Only the cheap checks (~5 s with WSL awake): skips self-tests, the size of the runs and the visual catalog. It is what the security gate runs before each audit. |
| `--vivo` | Adds the expensive, real checks: Codex's isolation test (**spends Codex usage**, ~2 min) and the visual self-test with a browser (~2 min). Ask for approval first. |

Each gate receives a state: `LISTA` (ready: no `FALLÓ` or `NO_INSTALADA`; it may carry `AVISO`) · `NO_INSTALADA` (a piece is missing) · `NO_LISTA` (not ready: something failed) · `APAGADA` (off; Codex only, without consent: it is optional). The global verdict is `LISTA` if all the requested ones are `LISTA` or `APAGADA`. Codes: 0 `LISTA` · 1 `NO_LISTA` · 2 incorrect usage. The only possible write is, with `--vivo`, the memory of the Codex test in `UAEH_HOME/cache/doctor-ultimo.json`.

| Gate | Checks |
|---|---|
| seguridad | `plataforma`, `motor`, `wsl-version`, `sistema`, `systemd`, `escaneres`, `reglas-semgrep`, `docker`, `imagenes`, `programas`, `validadores`, `uaeh-conf`, `python`, `parche-cyber-neo`, `vendor`, `corridas` |
| visual | `node`, `playwright-cli`, `chrome`, `config-global`, `candado-navegador`, `guias`, `catalogo`, `autoprueba` |
| codex | `consentimiento`, `cli`, `sesion`, `modelos`, `agents-md`, `aislamiento` |
| preflight | `skill`, `plantillas`, `huella`, `jurisdiccion` |

## Security runs: uaeh-runs.cjs

The security gate keeps a copy of the audited code in each run, and the folder grows without limit. `plugins/uaeh-harness/scripts/uaeh-runs.cjs` manages it:

```
node "<plugin>/scripts/uaeh-runs.cjs" listar|tamano|limpiar [--base <carpeta>] [--aplicar] [--json]
```

| Command | Does |
|---|---|
| `listar` | Lists the runs by repo. |
| `tamano` | Size per repo and total; warns if it exceeds `datos.retencion.avisoGB`. |
| `limpiar` | Applies the retention policy. **Dry run by default**: without `--aplicar` it does not change a single byte. |

Policy (`datos.retencion`, see [configuracion.md](configuracion.md)): the `mantenerUltimas` most recent runs of each repo (3) are always kept complete; of the rest, after `completasDias` (30) they are compacted (only the code copies are deleted and findings, reports and evidence are kept) and after `borrarDias` (365) the whole folder is deleted. It never touches `estado-hallazgos.json`, never follows symbolic links or junctions, and does not touch Docker volumes. Codes: 0 fine · 1 error (dangerous base, failure to delete) · 2 incorrect usage.

## Frequent problems

| Symptom | Cause | Remedy |
|---|---|---|
| After installing or updating, the hooks or the `uaeh-harness:*` agents do not appear. | A session opened before installing does not load the new hooks or agents, and `/clear` does not fix it. | Close and reopen **all** Claude Code sessions (terminals and the standalone Claude app). |
| The kit's doctor marks `inyeccion` as `AVISO`: «no vista en transcripciones recientes» (not seen in recent transcripts). | There has not yet been a new session with the plugin loaded, or the injection does not arrive. It is checked in the transcript, not in the hook's output. | Open a new session with the plugin loaded and run the doctor again. If `reglas.inyectar` is `false` and there is no block in any `CLAUDE.md`, the state is `FALLÓ`: turn the key on or run `/uaeh-kit:setup claude-md`. |
| `duplicados` at `AVISO`: hooks in `settings.json` that the plugin already registers and «correrían dos veces» (would run twice). | An earlier manual installation of the method was left behind. | Remove those hooks from `settings.json` by hand (the doctor does not edit). The kit's can first generate a proposal with `--proponer`. |
| `guarda-git`: «sin guarda de git» (no git guard), or «otra guarda: …» (another guard). | There is no global `core.hooksPath`, or it points to another guard (for example husky). | `/uaeh-harness:setup git-guard`. A foreign guard is not overwritten on its own: replacing it requires `--reemplazar`, and `git-guard --quitar --aplicar` restores the previous one. |
| `espejo`: «desactualizado …; instalar.cjs git-guard --aplicar» (out of date), or `NO_INSTALADA`. | The plugin was updated and the fixed-path mirror was left with the earlier version. | `node "<plugin>/scripts/instalar.cjs" git-guard --aplicar` from the plugin's new copy, and reopen the sessions. |
| `claude plugin install uaeh-harness@uaeh` fails entirely with `EPERM: operation not permitted, copyfile …` on a file under `vendor/`. | An endpoint antivirus takes a vulnerable-code example from the bundled security guides for malware and blocks the copy. Measured on Windows 11 with Bitdefender, with `vendor/cyber-neo/references/lang-python.md`; fixed with a one-character change documented in `vendor/cyber-neo/PATCHES/0003-ejemplo-que-dispara-antivirus.md`. Another antivirus or signature version may flag a different file. | Create an antivirus exclusion for Claude Code's plugins folder (`~/.claude/plugins`) and repeat the installation. It is worth reporting the flagged file. |
| Every Bash and PowerShell command is blocked with `PreToolUse:Bash hook error: […guardia-git.js]: failed; blocking because onFailure is "block"`. Or, with only `uaeh-kit`, the hooks show `Executable not found in $PATH: "node"` and nothing is injected. | Node is not on the `PATH`. With `uaeh-harness` the block is intentional: the guard fails closed. The doctors are Node scripts and cannot run either. | Check `node --version` in the terminal. Install Node 20 or later and reopen the sessions, or disable with `/plugin disable uaeh-harness`. |
| A harness command with `--aplicar` refuses, saying a review is open. | Another terminal has a verifier or auditor with its seal open; installing now would void its verdict. | Wait for it to finish, or repeat with `--forzar` (it voids that review's verdict). A review that died without closing blocks for up to 90 minutes. See [arnes.md](arnes.md). |
| A `git commit` is denied. | The guard reviews the real content of the commit inside git: secrets in added lines, sensitive `.env`-type files, browser evidence and, with `commits.credito=prohibir`, Claude's credit or identity. The guard's message indicates the type and the `ruta:línea`, never the value. | Take the secret or the file out of the commit, or adjust the message to the policy (`commits.firma`). The guard also applies with `--no-verify`; it is not bypassed. |
| The closing guard does not let the response finish. | Reviewers ran without the task being logged, or there was a whitelist commit with no review. It blocks only once per pending item and per session. | Log the task with `uaeh-registro.cjs`. If it is a false positive: `node "<plugin>/hooks/uaeh-guardia-cierre.js" directo "motivo"`; if it was an already-logged re-verification: `descartar "motivo"`. They are recorded in `excepciones.jsonl`. To turn it off: create `UAEH_HOME/guardia-cierre.apagada`. |
| A reviewer's seal is `ROTA`, or the reviewer reports `UNKNOWN`. | Something changed in the repo or in the harness while the reviewer was working (even another session). | Repeat the review without touching the repo or the harness during the round. A review with a `ROTA` or `DESCONOCIDO` seal is never PASS. |
| `wsl-version` at `FALLÓ`: «está en WSL 1: Docker necesita WSL 2» (it is on WSL 1: Docker needs WSL 2). | The distro was left on WSL 1. | `wsl --set-version <distro> 2`, a command the user runs in their terminal. |
| `systemd` at `AVISO`: «el proceso 1 es …» (process 1 is …). | The distro does not use systemd, which the gate's Docker needs. | Put `[boot]` with `systemd=true` in the distro's `/etc/wsl.conf` and run `wsl --shutdown`. |
| `programas`, `validadores` or `imagenes` at `AVISO`, `FALLÓ` or `NO_INSTALADA`; versions different from the pin; something in layer 3 «desactualizado» (out of date) after updating the plugin. | The layer 3 installed in the Linux engine does not match the plugin. | Dry run first: `node "<plugin>/scripts/instalar.cjs" puertas seguridad --actualizar` and then with `--aplicar`; for different versions or missing images, `--reparar`. What requires administrator rights (installing WSL, `sudo`, `wsl --terminate`) is printed by the installer and run by the user. |
| The visual self-test exits with 3, or the doctor says «autoprueba sin dependencias o sin navegador (no se probó nada)» (self-test without dependencies or browser; nothing was tested). | The self-test's dependencies or the exact Chromium for the pinned Playwright version are missing. | `node "<plugin>/skills/uae-visual/pruebas/probar-visual.cjs" --instalar`, or `instalar.cjs puertas visual --aplicar`. A 3 is never a success. |
| `cli` at `NO_INSTALADA`: «sin Codex CLI» (no Codex CLI). Or `sesion` at `FALLÓ`: «sin sesión de Codex» (no Codex session). | Codex is not installed or has no signed-in session. | `npm i -g @openai/codex`, `codex login` in the user's terminal, or `CODEX_JS` with the path to `codex.js`. Codex is optional. |
| The codex gate appears as `APAGADA`; the auditor exits with `NO_HABILITADO`. | `codex.habilitado` is `false` (factory value): without consent, no code is sent to OpenAI. | This is expected. To use it: `instalar.cjs puertas codex --consiento --aplicar` (see [codex.md](codex.md)). |

## What to attach when reporting a problem

1. The output of the corresponding doctor, in JSON: `node "<plugin>/scripts/doctor.cjs" --json` (and `doctor-puertas.cjs --json` if the problem is with a gate).
2. The Claude Code version (`claude --version`).
3. The operating system and, on Windows, the WSL version and the distro.

Before sending, check that the output carries no private data: paths with user or project names, repository names or any sensitive value. The doctor never prints secret values, but paths do appear.

## See also

- [instalacion.md](instalacion.md) — installation and updating.
- [configuracion.md](configuracion.md) — keys and variables the doctors use.
- [arnes.md](arnes.md) — git guard, seal and closing guard.
- [seguridad.md](seguridad.md) and [plataforma.md](plataforma.md) — Linux engine requirements.
- [visual.md](visual.md) — visual self-test.
