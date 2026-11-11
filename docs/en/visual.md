# The visual gate

This page describes `/uaeh-harness:uae-visual`, the gate that audits the interface of a site or app: it opens the screens in a real browser, measures accessibility and overflow, and leaves a short list of findings for the owner to decide on. It covers when it is used, what each piece does, how to prepare a project, and how to test the gate on the machine itself.

## When it is used

The gate is **on request**: it enters only when a visual or accessibility audit is requested (for example, "run the verifier on it") or before launching a new public site. It does not trigger on its own just because visual work is being done. Day-to-day work is done directly in the conversation, with the project's `DESIGN.md`, an overflow check at 360 px, and a screenshot that the owner approves.

When the gate enters, it runs **a single round**: deterministic checks, then `browser-verifier`, then `design-auditor`. Findings are presented as a list; they never open cycles on their own. If the screen touches login, personal data, payments or health, the gate is combined with `/uaeh-harness:uae-security`: visual approval does not replace security approval.

## The two pieces

| Piece | What it does | What it cannot do |
|---|---|---|
| `browser-verifier` | Opens the changed screens at 360 and 1440 px, collects snapshot, console, network and screenshots in `reports/visual-audit/<AAAAMMDD-HHMM>/`, and runs the deterministic visual tests. | Edit code, tests or baselines. Navigate outside `localhost`, `127.0.0.1` or `[::1]`. |
| `design-auditor` | Judges, read-only, the screenshots and the verifier's YAML against `DESIGN.md`, the brief, the Vercel interface guidelines pinned in the plugin, and WCAG. Separates what is verifiable from taste. | Write, run commands, or approve security and brand. |

The two agents do not see the conversation that built the change: whoever builds does not audit themselves.

### Locks

- `browser-verifier` works under two plugin locks: the read-only lock and a browser whitelist (`hooks/solo-navegador.js`). The whitelist admits only `playwright-cli` with its own `uaeh-…` session and subcommands that do not interact with the page, `npx --no-install playwright test`, pinned Lighthouse, read-only `git`, and a header request with `curl` to a local URL. It uses only Bash; PowerShell is disabled.
- `design-auditor` has only the tools `Read`, `Grep` and `Glob`.
- While they run, the integrity seal watches the repo: if anything changes during the review, the seal is `ROTA` (broken) and the result is `UNKNOWN`, never PASS.
- The text locks are best effort; the real guarantee is the seal, which measures the result and not the command.

## States and findings

| State | Means |
|---|---|
| `PASS` | All applicable checks ran and passed, with evidence. |
| `FAIL` | Demonstrated non-compliance (axe, overflow, font, console or network, pixel difference, finding with evidence). |
| `BLOCKED` | The environment prevents verification: the app does not start, the tool is missing, or the browser does not open. Never converted into PASS. |
| `NOT_CHECKED` | The control could not be checked: the approved baseline is missing or the project has neither `@playwright/test` nor axe. |

Toward `/uaeh-harness:uae-loop`, a `BLOCKED` or `NOT_CHECKED` on a required check counts as `UNKNOWN`. A brand or identity change stays in `PENDING_HUMAN_REVIEW` until the owner approves it, one screenshot at a time.

The auditor's findings carry a `VIS-NNN` identifier (the verifier's carry `NAV-NNN`) and a severity: **critical** and **high** block publishing; **medium** is up to the owner; **low** goes to the backlog. What is only taste goes to `notas_de_gusto` and never blocks. The full format of both YAML files is in `plugins/uaeh-harness/skills/uae-visual/referencias/estados-y-formato.md`.

## What the deterministic check measures

The Playwright and axe templates check, for each critical screen: console and network, horizontal overflow at 360 px, main font (never Inter, Arial or Roboto), WCAG 2.1 AA accessibility, and a screenshot against an approved baseline. Lighthouse is informational and runs only on public pages, except CLS above 0.25, which counts as a high finding. A new or changed baseline is created only with the owner's OK, one at a time.

## Prepare a project

```
node "<plugin>/scripts/instalar.cjs" visual --proyecto <carpeta del proyecto>
```

Dry run by default: it only shows what it would do. With `--aplicar` it copies `playwright.visual.config.ts` and `tests/visual/visual.spec.ts`, creates a `DESIGN.md` from the template if missing, and adds the evidence exclusions (the same ones as `uaeh-ignorar.cjs`). **It never overwrites an existing project file**: if it differs from the template, it says so. With `--local` the exclusions go to the clone's `.git/info/exclude`, useful on repos that are not your own.

The project's dependencies are installed separately and with the owner's approval: `npm i -D @playwright/test@1.63.0 @axe-core/playwright@4.13.0` and `npx playwright install chromium`. Without them the result is `NOT_CHECKED`.

### The DESIGN.md template

`DESIGN.md` is the product's visual source of truth. The template (`referencias/plantilla-DESIGN.md`) carries a header with simple keys. The tests read only `fuente_display`, `fuente_texto` and `pantallas_criticas`; the rest (`producto`, `version`, `estilo`, `movimiento`, `viewports`, `aprobado_por`, `aprobado_el`) documents the decision, and the real widths (360 and 1440) are fixed in `playwright.visual.config.ts`. It also carries eight sections: sources of truth, identity, tokens, components, responsive and accessibility, motion, acceptance criteria, and governance. It consolidates without copying: it indexes the existing brand guidelines. The motion mode is `con-proposito`, `constante-premium` or `por-seccion`; if it is not set, the gate asks once. A new `DESIGN.md` stays in `PENDING_HUMAN_REVIEW` until it is approved.

## The own visual catalog

The gate ships a generic catalog that says which **type** of skill to use on each route (landing, product UI, redesign, audit, 3D motion, video). Each user can have their own, with the names of their installed skills.

| What | How |
|---|---|
| See which one is in force | `node "<plugin>/scripts/uaeh-config.cjs" catalogo-visual` prints the path: `visual.catalogo` if set; otherwise `catalogo-visual.md` in `UAEH_HOME` if it exists; otherwise the plugin's generic one. |
| Generate a draft | `node "<plugin>/scripts/instalar.cjs" visual --registrar-skills` (dry run; with `--aplicar` it writes it). It proposes a role for each skill from its name and description: it is a starting point to be reviewed. `--reemplazar` overwrites an existing catalog. |
| Check it | `node "<plugin>/skills/uae-visual/scripts/comprobar-catalogo.cjs"` confirms that each local skill in the index exists and that the muting matches. Exit 0 with no errors, 1 with errors, 2 incorrect usage. |

The `visual.catalogo` key must be an absolute path; a relative path or one with `~` is ignored with a warning.

## Gate self-test

The self-test exercises the real templates against a bad toy site and a good one. It checks that the bad one is detected and the good one passes. It is a **local** step: CI does not run it because it does not download Chromium.

```
node "<plugin>/skills/uae-visual/pruebas/probar-visual.cjs" --instalar
```

| Flag | Effect |
|---|---|
| `--instalar` | If missing, installs the dependencies from `pruebas/package.json` into `UAEH_HOME/cache/visual-fixture` with `npm ci --ignore-scripts`, and downloads Playwright's Chromium. |
| `--modulos <carpeta>` | Uses that `node_modules` folder (already installed, same versions). With `--instalar` only the browser is installed if missing. |
| `--sin-lighthouse` | Skips Lighthouse, which needs network the first time. |
| `--conservar` | Does not delete the temporary copy, so the evidence can be inspected. |

| Output | Means |
|---|---|
| 0 | All controls passed. |
| 1 | Some control failed. |
| 2 | Incorrect usage. |
| 3 | No dependencies or no browser. |

**Exit 3 (`SIN DEPENDENCIAS` or `SIN NAVEGADOR`, i.e. no dependencies or no browser) means nothing was tested**: it is `UNKNOWN`, never a success. The exact Chromium for the pinned Playwright version is required; if it is missing, run again with `--instalar`. The self-test never writes to the plugin folder: it works in a temporary copy with its own git repo.

`/uaeh-harness:doctor` checks the visual gate (Node, `playwright-cli`, Chrome, global configuration, browser lock, pinned guidelines, catalog and self-test); with `--vivo` it runs the self-test with a real browser. See [diagnostico.md](diagnostico.md).

## Platform and limits

Tested only on Windows 11 (real browser, Lighthouse included). On Linux and macOS it is not tested. The text locks are best effort. The gate does not judge taste: what is verifiable carries severity; the rest is a note.

## See also

- [seguridad.md](seguridad.md) — the gate that accompanies the visual one when there is login, data or payments.
- [preflight.md](preflight.md) — requests an incremental visual audit within the preflight.
- [configuracion.md](configuracion.md) — key `visual.catalogo`.
- [diagnostico.md](diagnostico.md) — gates doctor and troubleshooting.
- [plataforma.md](plataforma.md) — tested systems.
