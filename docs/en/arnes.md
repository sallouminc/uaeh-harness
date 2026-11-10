# The verification harness (layer 2)

This page describes layer 2 of the UAEH method, which ships in the `uaeh-harness` plugin: which changes require an independent review, what that review looks like, which hooks block, and how to get out of a block. The principle is "whoever builds never verifies". Unlike layer 1, the hooks in this layer **block**.

## The whitelist: what enters the circuit

Only four types of change go through the review circuit. Everything else (interface, copy, scripts, pages, ordinary bugs) is done directly: minimal change, tests for the area touched, and a re-read of the diff.

| Type | Examples |
|---|---|
| Money | commissions, charges, subscriptions, payments and the prices that are charged, wherever they live |
| Accounts | sign-in, passwords, permissions, roles, tokens |
| Database | schema, migrations, row-level access rules, bulk deletes |
| Production | publishing something that touches real personal data or money |

The closing guard recognizes these files **by path name**, with factory patterns. That is why it can produce false positives (see "How to get out of a block"). The patterns are adjusted in `uaeh.config.json`, in the `listaBlanca` block:

| Key | Effect |
|---|---|
| `listaBlanca.agregar` | adds patterns to a category (`dinero`, `cuentas`, `baseDeDatos`, `produccion` or a new one) |
| `listaBlanca.categorias` | replaces the factory patterns of that category |
| `listaBlanca.excluirRutas` | folders that do not count, in addition to the factory ones (`tasks`, `docs`, `output`, `node_modules`, among others) |
| `listaBlanca.excluirExtensiones` | extensions that do not count, in addition to the factory ones (`md`, `txt`, images, `css`, among others) |

The patterns are regular expressions over the lowercase relative path.

## The `uae-loop` circuit

The skill `/uaeh-harness:uae-loop <task>` is the protocol for the whitelist. A single pass, with no retry loop:

1. **Checkpoint:** git status, branch, base commit and start time. Goal: the whole task in 30 minutes or less.
2. **Plan:** at `high` risk, ten lines in the conversation itself; at `critical` (real money, data deletion, health, destructive migration) the `uae-architect` agent writes it and the user gives the go-ahead before building.
3. **The main conversation builds**, since it already has the context, with at least one test of the new behavior. The `uae-builder` agent only enters with two or more independent pieces in parallel, more than about 300 lines, or `critical` risk.
4. **Work commit:** the reviewers look at that exact state.
5. **Parallel review:** `uae-verifier` (always) at the same time as the security reviewer (if the change touches money or accounts), under the integrity seal. Each receives a reading map and a 15-minute cap; if that is not enough, it returns `UNKNOWN` with what was missing.
6. **If it fails:** there is no automatic repair. The finding is presented to the user in a few lines and **the user decides**. If the user decides to fix it, only the criterion that failed is verified again.

60 minutes after the start the circuit stops and the user chooses between continuing, cutting scope, or dropping it. Findings outside what was asked go to a list in `tasks/todo.md` and are presented at close; they never open a cycle on their own.

## The agents

| Agent | What it does |
|---|---|
| `uae-verifier` | independent verification: runs the tests for the area and reviews the diff against the criteria; does not edit |
| `uae-security` | independent security auditor over the diff and execution paths; does not edit |
| `uae-builder` | implements an already-defined brief; never approves its own work |
| `uae-architect` | defines plan, rollback and tests for critical changes before code is written; does not implement |
| `uae-triage` | decides whether a task enters the whitelist when it is not possible to know what it touches without reading half the repository |
| `browser-verifier` | visual verification in a browser under a command whitelist (see [visual.md](visual.md)) |
| `design-auditor` | read-only visual audit (see [visual.md](visual.md)) |

## The integrity seal

A reviewer cannot approve something it changed itself. Before and after each review, `scripts/uaeh-integridad.cjs` takes a raw-bytes "snapshot" of: the commit and branch, all tracked and untracked files, ignored entries that look like code or credentials, the effective git configuration and its hooks, and the harness itself (the plugin, the mirror of the git guard, and the Claude Code and Codex configuration). The result is compared, not the command; for that reason it does not depend on how each shell splits arguments.

| Result | Exit code | Meaning |
|---|---|---|
| `INTACTO` (intact) | 0 | nothing changed during the review |
| `ROTA` (broken) | 3 | something changed: the verdict is voided |
| `DESCONOCIDO` (unknown) | 4 | it could not be measured |

The design rule: "could not be measured" is `DESCONOCIDO`, never `INTACTO`. A `ROTA` snapshot is equivalent to `UNKNOWN`: the reviewer must report `UNKNOWN` or `BLOCKED`, never PASS. In the circuit, a review with a `ROTA` seal or without the orchestrator's snapshot is repeated once; if it recurs, it is `BLOCKED`. The six reviewers (all the agents in the table except `uae-builder`) get an automatic snapshot through a hook, in addition to the circuit's manual snapshot:

```
node "<plugin>/scripts/uaeh-integridad.cjs" foto <carpeta del proyecto>
node "<plugin>/scripts/uaeh-integridad.cjs" comparar <id> <carpeta del proyecto>
```

### Reviews open in another terminal

Because the seal also measures the harness itself, installing or changing the configuration while another terminal has a review in progress (a verifier or auditor with an open seal) changes what is measured and voids that review's verdict: the seal becomes `ROTA`. To avoid this, the harness installer (`instalar.cjs config`, `git-guard`, `codex`, `todo` and `puertas`) first checks for open reviews:

- As a dry run, it shows an `AVISO` with the open reviews.
- With `--aplicar` it **refuses**: it writes nothing, exits with code 1 and says which review is open and for how many minutes. This includes `git-guard --quitar`.
- The options are to wait for the review to finish or to repeat the command with `--forzar`, which continues, leaves the warning and voids that review's verdict.

A review counts as open if it has a seal snapshot less than 90 minutes old with no closure in the log. Limit: a review that died without closing blocks for up to 90 minutes, or until `--forzar` is used. The layer 2 doctor shows this in the `sellos-abiertos` check ([diagnostico.md](diagnostico.md)).

The kit installer (`uaeh-kit`) also writes to things the seal measures (`settings.json`, the global `CLAUDE.md` and the `estable/` folder), but it does not depend on the harness: when it finds seal snapshots from the last 90 minutes it only warns with a `NOTA` and continues. It is best to wait for the review to finish.

## Final states

| State | Meaning |
|---|---|
| `PASS_TECHNICAL` | code and automatic verification are correct; does not authorize production |
| `PASS_RELEASE_READY` | all required gates approved and human authorization obtained |
| `PENDING_HUMAN_REVIEW` | regulated, sensitive or irreversible decision pending |
| `BLOCKED_SECURITY` | critical or high vulnerability open |
| `FAIL` | test or requirement not met |
| `UNKNOWN` | evidence is missing |

**UNKNOWN is never PASS.** An exit code of 0 with no tests run is not PASS either: `UNKNOWN` or `FAIL` is reported.

## The task log

When the verdicts arrive, the same turn records one line per task in `registro.jsonl` (inside `UAEH_HOME`, by default `~/.claude/uaeh`):

```
node "<plugin>/scripts/uaeh-registro.cjs" --proyecto <carpeta> --ruta <build|deep> --riesgo <high|critical> --ciclos <n> --minutos <min> --estado <ESTADO> --tarea "<resumen corto>"
```

`--ruta` is `quick`, `build` or `deep`; `--estado` is one of the six final states; `--tarea` accepts up to 120 characters. The log summary is obtained with `node "<plugin>/scripts/uaeh-resumen.cjs" 7` (last 7 days); see [medicion.md](medicion.md).

## What runs and what blocks

All hooks use exec form (`node` with arguments, no shell).

| Event | Hook | Blocks? | When |
|---|---|---|---|
| `PreToolUse` (Bash, PowerShell) | `guardia-git.js` | **Yes** | denies `reset --hard`, `push --force`, `--no-verify` and `commit -n`, `clean -f` and any attempt to remove the git guard; on `git commit` it looks for secrets and `.env`-type files. With `onFailure: block`: if Node fails, all Bash and PowerShell stays blocked until the hook is repaired or the plugin is disabled |
| `PreToolUse` | `uaeh-guardia-cierre.js commit` | No | records a `git commit` that touches whitelist files and reminds the model |
| `PreToolUse` | `solo-lectura.js` | **Yes, reviewers only** | read-only lock for `uae-verifier`, `uae-security` and `browser-verifier`; in the main session and in other agents it exits silently |
| `PreToolUse` | `solo-navegador.js` | **Yes, `browser-verifier` only** | command whitelist for the browser verifier; anywhere else it exits silently |
| `SubagentStart` | `uaeh-integridad.cjs hook-inicio` | No | takes the integrity snapshot of the six reviewers |
| `SubagentStop` | `uaeh-integridad.cjs hook-fin` | **Yes** | if the snapshot is `ROTA` or could not be measured, the reviewer must report `UNKNOWN` or `BLOCKED` |
| `SubagentStop` | `uaeh-guardia-cierre.js revisor` | No | records that a reviewer ran in this session |
| `Stop` | `uaeh-guardia-cierre.js cierre` | **Yes, once per session** | does not let the response close if reviewers ran and the task is not in the log, or if there was a whitelist commit with no reviewer |
| `SessionStart` | `linea-inicio.cjs` | No | one line if the git guard is missing or out of date, or if the configuration has warnings; otherwise silence |

## The git guard, in two layers

| Layer | Where it runs | What it denies |
|---|---|---|
| Text (`guardia-git.js`) | before the command runs | `reset --hard`, `push --force` (and variants), `--no-verify`, `commit -n`, `clean -f`, and attempts to remove the guard (`core.hooksPath`, `GIT_CONFIG_*` variables, writing `.git/config`) |
| Git (`guardia-commit.cjs`, through global `core.hooksPath`) | inside the real git process, with its index and its message | secrets in added lines (only type and `ruta:línea`, never the value), sensitive files, browser evidence and, depending on policy, Claude's credit or identity; it also applies with `--no-verify`, `cherry-pick`, `rebase` and `am` |

Each dispatcher in the git layer then chains the repository's own local hook. The commit policy lives in `uaeh.config.json`:

| Key | Values | Effect |
|---|---|---|
| `commits.credito` | `permitir` (default) \| `prohibir` | with `prohibir`, Claude credit in the message and Claude as author or committer are denied |
| `commits.firma` | text (empty by default) | final line required when credit is prohibited; empty = no signature |

Equivalent variables: `UAEH_COMMIT_CREDITO` and `UAEH_COMMIT_FIRMA`. Secrets, sensitive files and evidence are always checked, under any policy.

## Declared limits

- The text filters (`guardia-git.js`, `solo-lectura.js`) are **best effort**: a command crafted to evade them can get through. `solo-navegador.js` is narrower because it is a whitelist with a single grammar.
- **The guarantee is the seal**, which measures the result and not the command.
- The git layer does not see the plumbing (`commit-tree`, `update-ref`); a local `core.hooksPath` (for example, from husky) wins over the global one, a case the text layer detects in order to become strict. Real binaries and files over 20 MiB are not scanned by content.
- A user with the same account can rewrite the plugin or the mirror: this is the declared residual of this layer.

## How to get out of a block

| Situation | Way out |
|---|---|
| The closing guard flags a whitelist commit that was a false positive | `node "<plugin>/hooks/uaeh-guardia-cierre.js" directo "motivo"` |
| The reviewers were a re-verification of an already-logged task | `node "<plugin>/hooks/uaeh-guardia-cierre.js" descartar "motivo"` |
| The closing guard gets in the way in general | create the empty file `~/.claude/uaeh/guardia-cierre.apagada` |
| The git guard gets in the way | `node "<plugin>/scripts/instalar.cjs" git-guard --quitar --aplicar` |
| The git guard gets in the way and Node does not run | in the user's terminal: `git config --global --unset core.hooksPath` |
| All Bash is blocked because the hook fails | `/plugin disable uaeh-harness` |

Each `directo` and `descartar` leaves a trace in `excepciones.jsonl` (inside `UAEH_HOME`) that is presented at close. The closing guard warns only once per pending item and per session, and never blocks twice in a row.

## See also

- [seguridad.md](seguridad.md): the security gate that the circuit invokes for money and accounts.
- [visual.md](visual.md): `browser-verifier` and `design-auditor`.
- [configuracion.md](configuracion.md): all the keys of `uaeh.config.json`.
- [diagnostico.md](diagnostico.md): `doctor` and its self-tests.
- [desinstalar.md](desinstalar.md): full reversal.
