# UAEH — Universal Agentic Engineering Harness

**[Leer en español → README.es.md](README.es.md)**

> **Status: version 1.0 in preparation.** All three layers are built and in daily use by their author. What remains before 1.0 is the last round of installation checks and an independent review of the repository. This README describes what the repository contains and the evidence behind it; the full documentation is in [`docs/en/`](docs/en/README.md).

UAEH is a **working method for coding with AI agents** (Claude Code first, Codex as an optional second engine), packaged as **Claude Code plugins**. It grew out of one practical problem: an account whose spend was going almost entirely to *re-reading* context, and a review process that could report "done" without proof.

It has three layers. The first one is where the measured savings come from. The other two buy control, not savings.

| Layer | Plugin | What it is | Needs |
|---|---|---|---|
| **1. Method + token-efficiency kit** | `uaeh-kit` | The rules of the method, a context-window watchdog, a per-project context map, a CLAUDE.md "diet" with a checker, measurement scripts, a status line with a context bar, and a rules block you paste into your CLAUDE.md. Informative only: it never blocks anything. | Node ≥ 20 |
| **2. Verification harness** | `uaeh-harness` | A whitelist-gated loop where *whoever builds never verifies*: independent verifier and security reviewer agents, a read-only lock for reviewers, an integrity seal (snapshot of repo and harness before and after each reviewer), a task ledger, a closing guard, and a two-layer git guard. Six final states; **UNKNOWN is never PASS**. | Node ≥ 20, Git ≥ 2.31 (Codex optional) |
| **3. Gates** | `uaeh-harness` | Security gate (gitleaks, semgrep, osv-scanner, a read-only Codex auditor from a different model family, proof-of-concept in a network-less Docker sandbox), visual gate (Playwright, axe, a browser verifier and a design auditor), and a preflight that writes the launch documents and seals them with an expiry. | Windows 11 + WSL2, Docker, Python, Playwright, Chrome; Codex optional |

## The rules, in one screen

- **Direct by default.** Only four kinds of change enter the heavy loop: money, accounts, database, and production deploys that touch real people's data. Everything else is done directly and shown to the human.
- **Whoever builds never verifies.** The main conversation builds; an independent verifier and, for money or accounts, an independent security reviewer judge. Both run in parallel, once, with a 15-minute cap. No loops: a failure goes back to the human.
- **UNKNOWN ≠ PASS.** No tests executed, a broken seal, or a missing snapshot means UNKNOWN, never success.
- **A second opinion from another model family** for security, read-only and blind to the first reviewer's conclusions.
- **Clean cockpit.** Anything that pulls a lot of text into the main conversation and is not needed raw goes to a subagent that returns only its conclusion. Subagents default to a cheaper model.
- **Batch your steps.** Independent calls go in one message or one command; a change repeated across many files is a script, not a chain of edits. Debugging stays step by step.
- **Findings outside the brief** go to a list for the human. They never open new cycles, versions or tasks on their own.
- **Proportional verification.** A best-effort text filter does not get maximum rigor; a time budget per phase; measure your premises before you build on them.

## Evidence (the author's own usage, reproducible with the included scripts)

Measured on 1,213 real session transcripts of one account, comparing the ten days before the method (5–14 Oct 2026) with the fifteen days after (16–30 Oct 2026):

| Metric | Before | After | Change |
|---|---|---|---|
| Tokens re-read per day | 1,149 M | 505 M | **−56 % (2.3× less)** |
| Re-read per main turn | 541K | 278K | −49 % |
| Main turns per day | 1,326 | 1,496 | +13 % |
| Output tokens per day | 1.57 M | 2.12 M | +35 % |

The verification harness logged 60 whitelist tasks in the same period: 68 % PASS, median 26 minutes, 57 % of post-tuning tasks citing a real finding caught by a reviewer.

**What is not measured, and we say so:** there is no A/B on identical tasks; there is no before/after rate of escaped defects; the savings cannot be attributed to each component separately (the only isolated experiment: raising the compaction window from 400K to 700K gave back +73 % of consumption). These are one author's numbers, not a promise.

## Installation

```
/plugin marketplace add sallouminc/uaeh-harness
/plugin install uaeh-kit@uaeh
/plugin install uaeh-harness@uaeh
```

Requires Claude Code 2.1.295 or later and Node 20 or later. Then `/uaeh-kit:setup` and `/uaeh-harness:setup` guide the rest, always as a dry run first (rules block, settings, optional status line, per-project context map, git guard), and `/uaeh-kit:doctor` and `/uaeh-harness:doctor` report what is missing. Plugin hooks run as `node` scripts and do not require Git Bash. Each plugin's README lists every hook with the exact command it runs: [`plugins/uaeh-kit`](plugins/uaeh-kit/README.md) · [`plugins/uaeh-harness`](plugins/uaeh-harness/README.md).

**After installing or updating, close and reopen every Claude Code session** (each terminal and the standalone Claude app). A session that was already open does not load the new hooks or agents, and `/clear` does not fix it.

Full guide: [installation](docs/en/instalacion.md) · [configuration](docs/en/configuracion.md) · [troubleshooting](docs/en/diagnostico.md) · [uninstalling](docs/en/desinstalar.md) · [privacy](docs/en/privacidad.md).

## Platform

- **Windows 11 + WSL2 (Ubuntu 24.04):** where the author uses it every day. The unit tests also run in continuous integration.
- **Linux (Ubuntu 24.04 x86_64):** tested natively in continuous integration: unit tests on Node 20 and 24, and the complete layer 3 security gate (installers, scanners and sandbox). Not in daily use by the author.
- **macOS:** layers 1–2 should work but are untested; layer 3 is not supported in v1.
- The visual gate has been tested on Windows 11 only. Per-layer detail: [platform](docs/en/plataforma.md).

## Honest limits

- Every hook that blocks is listed in the plugin README with the exact command it runs; read it before installing. A plugin runs with your user's privileges.
- The read-only lock on reviewers is best effort; the integrity seal is the actual guarantee.
- The security gate sends a *clean copy* of your repository (no ignored files, no `.env`) to OpenAI when the Codex auditor is enabled. It is off by default and asks for consent.
- Agent prompts and hook messages are in Spanish in the first version; the machine contracts (JSON keys, states) are stable and documented in both languages.

## License and third parties

MIT © 2026 Salloum Inc. Bundled third-party components keep their own licenses and are listed in `THIRD_PARTY_NOTICES.md`: Cloudflare's `security-audit-skill` (MIT), `cyber-neo` (MIT, with a small patch that redacts secrets from evidence), and Vercel Labs' web interface guidelines (MIT). Scanners, Docker, Playwright and Codex are installed on your machine, never redistributed.
