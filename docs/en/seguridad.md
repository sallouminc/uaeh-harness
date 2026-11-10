# The security gate

This page describes the layer 3 security gate (`/uaeh-harness:uae-security`): which modes it has, in what order it works, how it filters false positives, where it leaves evidence, and what it does not cover. The gate never confirms a finding without reproducing it and never declares approved what it could not measure.

## Modes

| Mode | Purpose |
|---|---|
| `quick` \| `standard` \| `deep` | full audit of the repository. Default profile according to project risk: health or money → `deep`, personal data → `standard`, everything else → `quick` |
| `diff <base>` | review of a high-risk change (money or accounts); invoked by `uae-loop` (see [arnes.md](arnes.md)) |
| `incremental <categorías>` | audit limited to what changed since the last preflight seal (see [preflight.md](preflight.md)) |
| `reprobar <id>` | re-test of a fix (`reprobar` = re-prove): the exact proof of concept must no longer reproduce and the regression test must fail without the fix and pass with it |
| `lanzamiento` | blocking gate (`lanzamiento` = release) before publicly releasing something with personal data, health or money |

The full syntax is `[quick|standard|deep|diff <base>|incremental <categorías>|reprobar <id>|lanzamiento] [ruta-repo]`. **The full audit is never triggered on its own**: it runs on request or as a blocking step before a release with sensitive data.

## The order of work

1. **Deterministic pass** (no model, zero tokens), always first. It creates a clean copy of the repository (without `.env*` files, except `.env.example`, `.env.sample` and `.env.template`, which hold no real values; without symbolic links, without files over 5 MB and without the repository's own scanner configurations, so that a repo cannot switch the scanners off) and runs:

   | Tool | What it checks | How it runs |
   |---|---|---|
   | gitleaks | secrets, in history and in the folder | always with `--redact`: never prints the value |
   | semgrep | insecure code patterns | pinned local rules, with `--metrics=off` and `--disable-version-check` |
   | osv-scanner | dependencies with known vulnerabilities | requires network; sends package identifiers to OSV.dev, not the code ([privacidad.md](privacidad.md)) |
   | `npm audit` / `pnpm audit` | dependencies, depending on the manager | queries the npm registry: requires network |
   | cyber-neo (vendored) | secrets and lock files, with the machine's Python | only if its copy is intact and has the patch that masks evidence |

   Output: `0` = `OK`, `3` = `UNKNOWN` (a tool `FALLÓ` or `NO_INSTALADA`; the overall state cannot be PASS), `2` = invalid usage or environment.
2. **Auditor from another model family** (Codex), blind and read-only, in the background. It is optional and requires consent: see [codex.md](codex.md).
3. **Model-based audit** following the phases of the `security-audit` component (coverage ledger, hunters, verifiers, critic). Findings from scanners and from Codex enter as candidates; **they are never confirmed on their own**.
4. **Proof-of-concept confirmation** in the sandbox (`uaeh-sandbox`): Docker container with no network, read-only root and code, unprivileged user, no capabilities, fictitious data and never against production. A finding without reproduction stays `needs_validation`.
5. **Report** in `docs/harness/AUDIT_REPORT.md` with each finding (`SEC-NNN`, `archivo:línea` evidence).

Each `uae-security` agent runs under the integrity seal; a `ROTA` seal voids its verdict.

## False-positive filter

Every candidate goes through this filter before a verifier is spent on it: it must cite `archivo:línea` with the re-read text; confidence of 8 out of 10 or higher to move on to validation; traced without attacking (for example, a secret is checked by format, never against the API); a second independent look by the verifier, which receives only the location and the rules, without the hunter's reasoning. A scanner finding is a candidate, not a vulnerability.

**Declared limit:** the filter **discards outright** denial of service and resource exhaustion (rate limits, memory, CPU). The exception is unlimited spending on language models or paid APIs, which does count. It also discards generic missing hardening, missing logs, test-only findings and dependencies with CVSS below 4 and no exploitation path. Anyone who needs to measure resistance to denial of service must do so by another route.

## Scale and states

| Severity (confirmed findings only) | CVSS band |
|---|---|
| critical | 9.0 to 10.0 |
| high | 7.0 to 8.9 |
| medium | 4.0 to 6.9 |
| low | 0.1 to 3.9 |

| Finding state | Meaning |
|---|---|
| `confirmado` | reproduced in the sandbox, with command, input and limits recorded |
| `por_validar` | hypothesis with a chain in the code, blocked by a fact out of scope; no severity |
| `rechazado` | refuted with evidence |
| `corregido-verificado` | the exact proof no longer reproduces and the regression fails without the fix and passes with it |
| `aceptado` | risk accepted by the owner, with justification and date |

The overall state is `BLOCKED_SECURITY` if a confirmed, open critical or high remains; `UNKNOWN` if a mandatory tool, the sandbox or Codex was missing, or the run was left incomplete; and `PASS` otherwise. `UNKNOWN` is not `PASS`. The `lanzamiento` mode additionally requires zero open criticals or highs, no critical `por_validar` without a plan, the day's deterministic pass at `OK`, a current preflight (it is run before releasing; if something changed since the seal, an incremental one first), the pre-release checklist reviewed, the minimum legal material in place (real terms and privacy policy), the Codex audit unless the owner explicitly waives it (the waiver is written in the report) and, for health or money, the recommendation of an external human penetration test. It ends in `PASS_RELEASE_READY`, `BLOCKED_SECURITY` or `PENDING_HUMAN_REVIEW`.

## Where the evidence stays

Each run lives in `<runs>/run-N/`, outside the repository. The base folder is `datos.runs` from `uaeh.config.json` or, if empty, `~/.claude/uaeh/runs`. It contains the clean copy of the code (`fuente/`), `deterministico.json`, the findings and the report. Memory between runs is `estado-hallazgos.json`.

These folders grow without limit and **keep copies of the audited code**. Retention is managed with `uaeh-runs.cjs` (dry run by default; `--aplicar` executes):

```
node "<plugin>/scripts/uaeh-runs.cjs" listar
node "<plugin>/scripts/uaeh-runs.cjs" tamano
node "<plugin>/scripts/uaeh-runs.cjs" limpiar --aplicar
```

By default (`datos.retencion`) it compacts at 30 days (deletes only the code copies and keeps findings and reports), deletes at 365, and always keeps the 3 most recent runs of each repository complete.

## Linux engine and platform

The scanners and the sandbox run in a Linux engine installed in `/opt/uaeh` (Ubuntu 24.04 x86_64): WSL2 with systemd on Windows 11, or direct Linux. Everything is owned by root, out of the agents' reach, and each download is verified against versions and fingerprints pinned in `wsl/herramientas.json`. Without that layer, anything that depends on it is `UNKNOWN`. On macOS the sandbox is not supported. Installation is in [instalacion.md](instalacion.md) and the state is checked with `/uaeh-harness:doctor puertas` ([diagnostico.md](diagnostico.md)).

## Limits

- The reviewers' read-only lock is best effort; the hard boundary is the container and the reviewer's guarantee is the seal.
- The sandbox does not test deployment, provider, distribution network, production headers or real identity; those stay `por_validar` with a safe plan. It does not include a browser: an XSS is confirmed with the rendered response or stays `por_validar`.
- Dependency preparation is the only stage with network and uses `--ignore-scripts`; if a package needs install scripts, the test that requires it stays `por_validar`.

## Third-party components

The gate includes, with their licenses, `security-audit` (Cloudflare), `cyber-neo` (with a patch that masks secrets in the evidence) and the web interface guidelines from Vercel Labs; it also uses gitleaks, semgrep and osv-scanner installed separately. The Semgrep rules are downloaded to the user's machine under the "Semgrep Rules License v. 1.0", which does not allow offering them to third parties as a service: anyone who audits third-party code as a service must review it ([privacidad.md](privacidad.md)). Details and licenses are in `THIRD_PARTY_NOTICES.md`, at the root of the repository.

## See also

- [codex.md](codex.md): the auditor from another model family.
- [privacidad.md](privacidad.md): what leaves the machine at each step.
- [arnes.md](arnes.md): the `uae-loop` circuit and the seal.
- [preflight.md](preflight.md): the `incremental` mode and the validity seal.
- [diagnostico.md](diagnostico.md): checking that the gate is `LISTA`.
