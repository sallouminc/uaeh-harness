# Codex as a second engine (optional)

This page explains what Codex is for within UAEH, how to install it, how consent to send it code is given and withdrawn, what is sent to it, and what limits it has. Codex is **off by default**: the harness and the security gate work fully without it.

## What it is for

Whoever built the code should not grade it, and a model from another family often sees different things. Codex (from OpenAI) acts as a **read-only, blind** security auditor: it receives the code, the scope and the threat model, never Claude's findings. Its findings enter the security gate as candidates: they go through the same filter and the same sandbox confirmation as the others. A match between Claude and Codex raises priority, not state. See [seguridad.md](seguridad.md).

## Install

| Step | Who | Command |
|---|---|---|
| 1. Install the CLI | user | `npm i -g @openai/codex` |
| 2. Sign in | user, in their terminal | `codex login` |
| 3. Give consent | user (see below) | `instalar.cjs puertas codex --consiento --aplicar` |

Minimum version: **0.163.0** (constant `CODEX_MINIMO` in `plugins/uaeh-harness/scripts/doctor-puertas.cjs`). With an earlier version the doctor emits `AVISO`, because the isolation was measured with that version or a later one. The state is checked with `node "<plugin>/scripts/doctor-puertas.cjs" --puerta codex`; if Codex is off, the verdict is `APAGADA` and it does not prevent the global verdict.

## Consent

Using Codex as an auditor **sends OpenAI a clean copy of the audited repository**. Therefore:

- `codex.habilitado` is `false` by default. With that value, `auditor-codex.cjs` exits with code 3 (`NO_HABILITADO`) without launching Codex or sending anything.
- Enable (writes `codex.habilitado=true` and the date in `codex.consentimiento`, with a backup):

  ```
  node "<plugin>/scripts/instalar.cjs" puertas codex --consiento --aplicar
  ```
- Withdraw consent (turns it off again):

  ```
  node "<plugin>/scripts/instalar.cjs" puertas codex --retirar --aplicar
  ```

Without `--aplicar` the installer only shows what it would do. Even when enabled, it must not be used with code that cannot be shared with that provider, nor on someone else's repository without the owner's approval. Without Codex, the security gate keeps working; only the second-family piece goes unrun and is reported as such (the `lanzamiento` mode requires it unless the owner explicitly waives it).

## What is sent

The contents of the clean copy `<run>/fuente/` are sent (see [privacidad.md](privacidad.md)): without `.env*` files (except `.env.example`, `.env.sample` and `.env.template`, which hold no real values), without git-ignored files and without the repository's scanner configurations. In `diff` mode the patch of what changed is added (also without `.env`, with the same exception). `codex exec review --uncommitted` is never used, because it would include untracked files.

## Levels and models

The auditor accepts `--modelo profundo|equilibrado|rapido`. The model and effort for each level come from `codex.modelos` in `uaeh.config.json`, not from Codex's own configuration:

| Level | Default model | Effort | Typical use |
|---|---|---|---|
| `profundo` | `gpt-6-astra` | `high` | standard or deep audits and diffs for money or accounts |
| `equilibrado` (default) | `gpt-6-sol` | `medium` | quick and incremental audits |
| `rapido` | `gpt-6-luna` | `medium` | light tasks |

Effort accepts `low`, `medium`, `high` or `xhigh`. The old aliases `astra` and `sol` are equivalent to `profundo` and `equilibrado`. The deep level usually has a short usage allowance per time window: it is best reserved for what deserves it.

## Timing

Codex runs in the background. On real diffs, the author measured 1.5 to 2 minutes per run. The cap for one run comes from the configuration: `codex.timeoutDiffMin` (**10 minutes** by default) in `diff` mode and `codex.timeoutCompletaMin` (**40 minutes** by default) in `completa` mode. If the auditor is launched with `--timeout-min N`, that value wins. When the cap is reached, the process tree is killed, and the cap used is recorded in `codex/resumen.json` (`tope_min`). The keys are detailed in [configuracion.md](configuracion.md).

## Isolation test

Before trusting the auditor, and after every Codex update:

```
node "<plugin>/skills/uae-security/scripts/auditor-codex.cjs" --probar-sandbox
```

It must answer `SANDBOX_OK` (reads and does not write), using a toy folder: it does not send the user's code. If it does not answer that way, the Codex auditor is `UNKNOWN` and is reported. `doctor-puertas.cjs --puerta codex --vivo` runs it and remembers the result; that test spends Codex usage allowance. Without `--vivo`, the doctor warns if Codex changed version since the last test.

## Known limits

- **Windows:** the read-only sandbox **does not restrict reading to the clean copy**. The prompt tells it to read only the copy, but a model that disobeys could read other paths on the disk. That is why the clean copy is the main defense and it is never given a path to the real repository. On Windows the auditor uses `windows.sandbox="elevated"` (without it, read-only mode blocks even reading); measured by the author with versions 0.157.0 and 0.163.0.
- **Linux:** `-s read-only` is used with no extra arguments. It is **not tested by the author**; `--probar-sandbox` checks it on each machine.
- The `sandbox_mode` field of Codex agents is not a guarantee (measured by the author). The guarantee is the integrity seal ([arnes.md](arnes.md)).
- **What was measured:** Windows 11 with Codex CLI 0.163.0 and a session started with `codex login`; there, `--probar-sandbox` answers `SANDBOX_OK`.
- **What the author did not measure:**
  - Codex on Linux with `-s read-only`.
  - Authentication by API key instead of `codex login`.
  - Availability of the default models (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`) on other accounts or plans. If a model is not available, it is changed in `codex.modelos`.
  - On every machine, `--probar-sandbox` is the check.

## Codex templates

`instalar.cjs codex` (or `/uaeh-harness:setup codex`) works even when Codex is switched off (it warns with a note); `instalar.cjs todo` includes it only if `codex.habilitado` is `true`. It leaves Codex working with the same rules as Claude Code, for example to take over when it runs out of its usage limit. It is a dry run by default; with `--aplicar` it writes and backs up whatever it overwrites:

| What | Where | How |
|---|---|---|
| UAEH block | `~/.codex/AGENTS.md`, between the markers `UAEH:BEGIN` and `UAEH:END` | replaced in place without touching the rest of the file |
| Five agents `uae_architect`, `uae_builder`, `uae_security`, `uae_triage`, `uae_verifier` | `~/.codex/agents/` | model and effort come from `codex.modelos` |
| `config.toml` fragment | only printed | **the user pastes it by hand** into `~/.codex/config.toml` |

The fragment carries four keys: `project_doc_fallback_filenames`, `project_doc_max_bytes`, `max_concurrent_threads_per_session` and the Windows `sandbox`. The plugin never edits `config.toml` on its own. On Windows, the `elevated` sandbox may ask for administrator permission the first time.

To remove them, use `instalar.cjs codex --quitar --aplicar` (see [desinstalar.md](desinstalar.md)); the fragment pasted into `config.toml` is removed by hand.

## See also

- [seguridad.md](seguridad.md): where Codex enters the order of work.
- [privacidad.md](privacidad.md): what leaves the machine and with what permission.
- [configuracion.md](configuracion.md): the `codex` block of `uaeh.config.json`.
- [diagnostico.md](diagnostico.md): the doctor's `codex` gate.
