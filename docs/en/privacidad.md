# What leaves the machine, when, and with what permission

This page gathers, in one place, everything the `uaeh-kit` and `uaeh-harness` plugins can send or download over the network, what they store on disk, and what they do not do. There is no telemetry. Every data output has a switch or happens only during an installation that the user runs.

## Summary

| Component | What is sent or downloaded | To whom | When | How it is controlled |
|---|---|---|---|---|
| Telemetry | nothing | no one | never | no telemetry code exists |
| Status line | a `GET` request to `https://status.claude.com/api/v2/summary.json`, without credentials (only a `User-Agent` header with the kit's name) | status.claude.com | only with `statusline.estadoClaude=true`; at most every 90 s | off by default; without that key the kit makes no network request |
| Codex auditor | a clean copy of the audited repository (without `.env*` or git-ignored files) | OpenAI | only with `codex.habilitado=true`, when running the security gate | explicit consent: `instalar.cjs puertas codex --consiento --aplicar`; withdrawn with `--retirar --aplicar` ([codex.md](codex.md)) |
| osv-scanner | invoked as `osv-scanner scan source -r` on the clean copy; it sends the identifiers of the dependencies it finds in manifests and lock files: ecosystem, name and version of each package (and, for dependencies pinned by commit, the commit hash). It does not send source code or the contents of files; the tool's documentation has the detail | OSV.dev, a public vulnerability service (run by Google) | in the deterministic pass of each audit | requires network; without network it ends up `FALLÓ` and the run `UNKNOWN` |
| `npm audit` / `pnpm audit` | whatever each manager sends to its registry to query security advisories | npm registry | in the deterministic pass, if the repository has a lock file | requires network; without network it ends up `FALLÓ` |
| Semgrep | nothing: runs with `--metrics=off` and `--disable-version-check`, with pinned local rules | no one | the rules are downloaded only once, when installing layer 3 | the rules live in `/opt/uaeh/reglas`; they are not requested on every run |
| gitleaks | nothing: runs locally, always with `--redact` | no one | in the deterministic pass | never prints the value of a secret |
| Layer 3 installation | downloads of tools, rules, and images (see next table) | the sites of each project | only when running `instalar.sh` or `instalar.cjs puertas … --aplicar` | each download is compared against a pinned fingerprint; by default the installers run as a dry run |
| Visual gate | dependency installation with `npm ci`, download of the Playwright browser and Lighthouse with `npx` | npm registry and browser repository | when preparing the gate or running its self-test; Lighthouse in every audit that uses it | `--sin-lighthouse` in the self-test avoids the Lighthouse download; the sites tested are local (`localhost`) |
| Sandbox | nothing: containers with `--network none` | no one | during proof-of-concept confirmation | the only stage with network is preparing the project's dependencies (`preparar-deps`, with `--ignore-scripts`) |

## Downloads when installing layer 3

`plugins/uaeh-harness/wsl/instalar.sh` downloads and verifies against the versions and fingerprints pinned in `wsl/herramientas.json`:

| Piece | From where |
|---|---|
| System packages (`ca-certificates`, `curl`, `gnupg`, `pipx`, `python3`) | Ubuntu repositories (`apt-get`) |
| Docker Engine | official Docker repository (`download.docker.com`), with the fingerprint of its key pinned |
| gitleaks and its default configuration | the project's GitHub releases, with a pinned `sha256` fingerprint |
| osv-scanner | the project's GitHub releases, with a pinned `sha256` fingerprint |
| Semgrep | `pipx` at a pinned version |
| Semgrep rules | `https://semgrep.dev/c/p/<paquete>`; stored with checksums and reused |
| Sandbox images (`node`, `postgres`) | `docker pull` by pinned digest |

The Semgrep rules are not in the repository: `instalar.sh` downloads them from `semgrep.dev` to the user's machine. They are under the "Semgrep Rules License v. 1.0" (https://semgrep.dev/legal/rules-license/), which allows using them for one's own internal purposes and does not allow distributing them or offering them to third parties as a service. Anyone who uses the security gate to audit third-party code as a service must review that license. The Semgrep engine itself is LGPL-2.1.

## What is stored on disk

All state lives under `UAEH_HOME` (by default `~/.claude/uaeh`):

| Item | Content |
|---|---|
| `uaeh.config.json` | the user's single configuration |
| `registro.jsonl` | one line per task: project, route, risk, minutes, status, and a summary of up to 120 characters |
| `integridad/` | the seal snapshots (cryptographic digests of files, not their content) |
| `sesiones/` | per-session state of the closing guard |
| `excepciones.jsonl` | the `directo` and `descartar` exceptions, with their reason |
| `runs/` | security gate runs (folder configurable with `datos.runs`) |
| `cache/` | caches, such as the Claude status, usage limits (only with `statusline.guardarLimites`), and the visual self-test |
| `estable/` | fixed-path mirrors of the status line and the git guard; inside the guard's mirror, `git-guard.estado.json` records the state of its installation |

**The audit evidence in `runs/` may contain fragments of the audited code**: each run stores a clean copy of the code and the findings cite lines. They are managed with `uaeh-runs.cjs` ([seguridad.md](seguridad.md)). In addition, the git guard's messages cite only the type and `ruta:línea` (path:line) of a secret, never its value.

## What it does not do

- It does not send transcripts or conversations to any server. The measurement scripts read Claude Code's `.jsonl` transcripts locally and only extract usage numbers and the names of tools, agents, and skills.
- It does not install telemetry or analytics of any kind.
- It does not touch `~/.codex/config.toml`: the snippet is printed for the user to paste.
- It does not run code from the audited project outside the sandbox.

## How to work offline

| Works offline | Ends up `FALLÓ`, `OMITIDA`, or `UNKNOWN` |
|---|---|
| complete layer 1 (kit, doctor, usage line) | osv-scanner and `npm audit`/`pnpm audit`: `FALLÓ`, and the overall status of the deterministic pass becomes `UNKNOWN` |
| complete layer 2: hooks, seal, log, git guard | Codex auditor: without network it cannot run and is reported as not run |
| gitleaks, Semgrep (rules already installed), and cyber-neo | dependency preparation for the proofs of concept: those proofs are left as `needs_validation` |
| sandbox with images already downloaded | installing or updating layer 3 and the visual gate |
| visual gate against local sites | Lighthouse, the first time it is downloaded with `npx` |

## See also

- [codex.md](codex.md): the only component that sends code to a third party.
- [seguridad.md](seguridad.md): runs, evidence, and retention.
- [kit.md](kit.md): the status line and its keys.
- [visual.md](visual.md): the visual gate.
- [configuracion.md](configuracion.md): the keys that control each switch.
