# Uninstalling

This page gives the order for removing UAEH without leaving the machine half-configured, and explains what each command removes and what is removed by hand. The order matters: the git guard must be removed while the plugin is still installed.

The installers do not delete the user's own files. Every removal command is a dry run by default: it writes only with `--aplicar`, and repeating it answers "nothing to do".

## Recommended order

| Step | What is removed | How |
|---|---|---|
| 1 | Git guard | `instalar.cjs git-guard --quitar --aplicar` |
| 2 | Rules block, settings, and status line | the kit's `instalar.cjs todo --quitar --aplicar` (or each subcommand separately) |
| 3 | Codex | `puertas codex --retirar --aplicar` and `instalar.cjs codex --quitar --aplicar` |
| 4 | Layer 3 on Linux or WSL | `desinstalar.sh --aplicar` |
| 5 | The plugins | Disable or uninstall |
| 6 | State in `UAEH_HOME` | User's decision |

## 1. Git guard (before disabling the plugin)

The git guard is set in the global git configuration, which points to a copy (the mirror) at `UAEH_HOME/estable/uaeh-harness/git-hooks`. If the plugin is disabled or uninstalled first, that global configuration would keep pointing to the mirror and the command that undoes it (`instalar.cjs`) would no longer be at hand. That is why it is removed first:

```
node "<plugin>/scripts/instalar.cjs" git-guard --quitar
node "<plugin>/scripts/instalar.cjs" git-guard --quitar --aplicar
```

The first command is a dry run and the second writes. What `--quitar` (remove) does:

- If the global configuration points to the mirror, it removes it; or restores it to the previous value if it had been replaced with `--reemplazar` (replace) (the previous value is recorded in `git-guard.estado.json`, inside the mirror).
- If it points elsewhere, it does not touch it and reports so.
- The mirror is kept on disk. It is not deleted.

When the plugin is installed, its skill can be used: `/uaeh-harness:setup git-guard --quitar --aplicar`.

If the command with `--aplicar` refuses because a review is open in another terminal, wait for it to finish or repeat with `--forzar` (see [arnes.md](arnes.md)).

## 2. Rules block, settings, and status line

The kit's three reversals can be done at once. The `todo --quitar` command applies them in reverse order (status line, settings, global `CLAUDE.md` block) and leaves a single backup per file:

```
node "<plugin-kit>/scripts/instalar.cjs" todo --quitar
node "<plugin-kit>/scripts/instalar.cjs" todo --quitar --aplicar
```

The first is a dry run and the second writes. Each piece also has its own command:

```
node "<plugin-kit>/scripts/instalar.cjs" claude-md --quitar --aplicar
node "<plugin-kit>/scripts/instalar.cjs" claude-md --proyecto <carpeta del proyecto> --quitar --aplicar
node "<plugin-kit>/scripts/instalar.cjs" settings --quitar --aplicar
node "<plugin-kit>/scripts/instalar.cjs" statusline --quitar --aplicar
```

- `claude-md --quitar` acts on the global `CLAUDE.md`; with `--proyecto`, on a project's one. Only the block between `UAEH:BEGIN` and `UAEH:END` is removed.
- `settings --quitar` removes `env.CLAUDE_CODE_SUBAGENT_MODEL` and `autoCompactWindow` from `settings.json` (by default `~/.claude/settings.json`) **only if they still hold the value the kit wrote** (`sonnet` and `700000`). If the user changed them, they are respected and the installer says so with a `NOTA`. `env` is removed only if it ends up empty; no other key is touched. Limit: it cannot tell apart an identical value set by hand by the user.
- `statusline --quitar` removes `statusLine` from `settings.json` only if it points to the kit's bar, and deletes from `UAEH_HOME/estable/` only the files the kit copied. The other plugin's folder, `estable/uaeh-harness/`, is left intact.

Every file the installer modified has a backup next to it named `<archivo>.uaeh-respaldo-<AAAAMMDD-HHmmss>`. Restoring it means copying it over the original. If the installer shows a `NOTA` about seal snapshots from the last 90 minutes, a review is in progress in another terminal; it is best to wait for it to finish.

## 3. Codex

Turn off the Codex auditor (sets `codex.habilitado` to `false` and clears the date of `codex.consentimiento`):

```
node "<plugin>/scripts/instalar.cjs" puertas codex --retirar --aplicar
```

The templates written by `instalar.cjs codex` are removed with:

```
node "<plugin>/scripts/instalar.cjs" codex --quitar
node "<plugin>/scripts/instalar.cjs" codex --quitar --aplicar
```

The first is a dry run and the second writes, in the Codex folder (by default `~/.codex`, or the one in the `CODEX_HOME` variable):

- In `AGENTS.md`, it removes only the block between `<!-- UAEH:BEGIN v… -->` and `<!-- UAEH:END -->`, with a backup. The rest of the file is not UAEH's.
- It deletes the `agents/uae_*.toml` files (five: `uae_architect`, `uae_builder`, `uae_security`, `uae_triage`, `uae_verifier`) that are identical to the ones the plugin generates today. Modified ones are left, with a `NOTA`.
- `config.toml` is never touched: if the snippet was pasted by hand, it is removed by hand.

More about Codex in [codex.md](codex.md).

## 4. Layer 3 on Linux or WSL

The Linux engine is removed with `plugins/uaeh-harness/wsl/desinstalar.sh`, run inside Linux or WSL, with the plugin's `wsl/` folder as the script's location. This is what the installation left behind:

- Under `/opt/uaeh`, as root: the sandbox programs, the validators, `uaeh.conf`, and `instalado.json`.
- Docker Engine, gitleaks, osv-scanner, semgrep, their rules, and the container images (the scanners end up in `/usr/local/bin`).
- Backups that `instalar.cjs puertas seguridad --aplicar` creates before updating: copies of `/opt/uaeh` in `/opt/uaeh-respaldo/<fecha>`.

The script is a dry run by default: without root and without writing anything, it lists what it would remove.

```
bash desinstalar.sh
sudo bash desinstalar.sh --aplicar
```

- With no other options, `--aplicar` removes all of `/opt/uaeh` and the `uaeh-*` programs from `/usr/local/bin`.
- `--con-escaneres` also removes gitleaks, osv-scanner and semgrep, **only if they are exactly the ones UAEH installed**. It checks against `/opt/uaeh/instalado.json` (binary fingerprint for gitleaks and osv-scanner; environment version for semgrep). If they do not match, they are the user's: they are left and a warning is given. It must go in the **same run** that removes `/opt/uaeh`, because afterwards there is no record to check against.
- `--con-imagenes` removes the sandbox container images, identified by digest. An image in use is left, with a warning.

Full example:

```
sudo bash desinstalar.sh --con-escaneres --con-imagenes --aplicar
```

What the script never does:

- Uninstall Docker Engine, which may be in use for other purposes. It prints the command to remove it by hand.
- Remove the base packages (`ca-certificates`, `curl`, `gnupg`, `pipx`, `python3`).
- Delete the audit run and evidence folders: it only names them.
- Touch the `/opt/uaeh-respaldo/<fecha>` backups.

It can be repeated: the second time it says there is nothing to remove. It was tested in a disposable `ubuntu:24.04` container (the `instaladores-contenedor` continuous integration job).

The visual gate also leaves a global `playwright-cli` and, in `UAEH_HOME/cache/visual-fixture`, the dependencies of its self-test. In every project where `instalar.cjs visual --proyecto` was run, `playwright.visual.config.ts`, `tests/visual/visual.spec.ts`, the `DESIGN.md` if it was missing, and evidence exclusions were copied: these are project files and are removed by hand. The preflight writes its documents in `docs/harness/` of each audited repository.

## 5. Disabling or uninstalling the plugins

With the guard already removed:

```
/plugin disable uaeh-harness
/plugin disable uaeh-kit
```

`/plugin disable` disables the plugin without deleting it. To remove it completely, use Claude Code's plugin manager (`/plugin`). Afterwards, close and reopen all sessions, as when installing ([instalacion.md](instalacion.md)).

The `uaeh-harness` hooks can block: if Node fails, the `guardia-git.js` hook blocks all Bash and PowerShell until the hook is repaired or the plugin is disabled.

## 6. What remains in `UAEH_HOME`

`UAEH_HOME` is by default `~/.claude/uaeh` (or `UAEH_HOME`, or the `CLAUDE_CONFIG_DIR` folder plus `uaeh`). The installers never delete it.

| Item | What it is |
|---|---|
| `uaeh.config.json` | The user's configuration |
| `registro.jsonl` | The task log |
| `integridad/`, `sesiones/`, `excepciones.jsonl` | Integrity seal snapshots, session state, and closing guard exceptions |
| `runs/` | Security gate runs, with copies of the audited code |
| `cache/` | Caches |
| `estable/` | Mirrors of the status line and the git guard |

Part of this content is audit evidence and the task log. Deleting it is the user's decision; to reduce only `runs/`, `node "<plugin>/scripts/uaeh-runs.cjs" limpiar` acts as a dry run and `--aplicar` compacts or deletes according to the configured retention.

## 7. Emergency without Node

If Node is not available, `instalar.cjs` cannot run and commits may fail. In the user's terminal, the global git configuration is undone with:

```
git config --global --unset core.hooksPath
```

This removes the guard but does not restore a previous value that had been replaced with `--reemplazar`; if one existed, it must be set again by hand.

## See also

- [instalacion.md](instalacion.md)
- [arnes.md](arnes.md)
- [codex.md](codex.md)
- [plataforma.md](plataforma.md)
- [diagnostico.md](diagnostico.md)
