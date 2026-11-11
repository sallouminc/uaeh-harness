# Measurement

This page explains what each UAEH script measures, which data it reads and which it does not, how to reproduce the evidence table of the root README, and what is not measured.

The scripts measure your own usage: there is no server, no telemetry, and nothing leaves the machine.

## Kit scripts (layer 1)

All four are in `plugins/uaeh-kit/scripts/` and `/uaeh-kit:medir [días]` runs them in one go. All read local Claude Code `.jsonl` transcripts: those from the `USO_RAIZ` environment variable if defined; otherwise, those from `<Claude Code folder>/projects`. Exit codes are 0 for correct (also with no data) and 1 for incorrect usage, except where indicated.

| Script | Arguments | What it prints |
|---|---|---|
| `uso-tokens.cjs` | `[dias]` (default 7) · `--json` | Table per model (subagents with the `sub:` prefix), with turns, `leida-cache` (what was re-read), `escrita-cache`, `entrada` (input), and `salida` (output). Then a table per project (the 12 largest) and the heaviest main sessions with `1er turno` (first turn, the context they start with). Ends with the median and p90 of the context at startup |
| `uso-pasos.cjs` | `[dias]` (default 7) | Main sessions, steps, total re-read, and K per step; percentage of steps with tools in parallel; chains of 4 or more loose commands or reads; edits one by one (5 or more in a row); repeated identical commands; and the author's October 2026 reference |
| `uso-herramientas.cjs` | `[dias]` (default 30) | Agents launched by type, model requested when launching each agent (`(hereda)` (inherits) if none was requested), skills invoked, and number of workflows |
| `uaeh-listado-skills.cjs` | `<archivo.jsonl>` or `--ultima [carpeta]` · `--nombres a,b,c` · `--json` | Total characters of the skills listing injected at startup, how many carry a description, and presence of the `uae-*` skills and the requested ones. With `--json` it adds the 10 longest lines. Exit 2 if there is no listing |

The reason for measuring steps: each model step re-reads the whole conversation, so whatever does not depend on the previous result must go in the same message.

## Harness scripts (layer 2)

They are in `plugins/uaeh-harness/scripts/` and work on the task log `UAEH_HOME/registro.jsonl`.

| Script | Arguments | What it does |
|---|---|---|
| `uaeh-registro.cjs` | `--proyecto` `--ruta quick\|build\|deep` `--riesgo bajo\|medio\|alto\|critico` `--ciclos <n>` `--estado <estado>`; optional `--minutos <n>` (0 to 9999), `--escalamiento <texto>`, `--visual <tipo>`, `--tarea <texto>` (maximum 120 characters) | Appends a JSON line to the log and prints its path. Accepts the risks `low\|medium\|high\|critical` and stores them in Spanish. The status is one of `PASS_TECHNICAL`, `PASS_RELEASE_READY`, `PENDING_HUMAN_REVIEW`, `BLOCKED_SECURITY`, `FAIL`, `UNKNOWN`. Fails with exit 1 if a value is missing or invalid |
| `uaeh-resumen.cjs` | `[dias]` (integer of 1 or more; default 30) | Summarizes the log: total tasks, by route and by status, PASS rate (technical plus release-ready), percentage with escalation, how many ended in `UNKNOWN`, average cycles per route and, if data exists, minutes per task (average, maximum, how many exceed 60 minutes, and average per status). With no tasks it prints `sin tareas registradas` (no tasks recorded) |

The log is mandatory for the harness: see [arnes.md](arnes.md).

## Which data they read and which they do not

| Source | Read? |
|---|---|
| Usage fields of the transcripts (`usage`), model, message id, timestamp, subagent flag | Yes (`uso-tokens`) |
| Tool names | Yes (`uso-pasos`, `uso-herramientas`) |
| Command text | Yes, only in `uso-pasos`, and only to count repeats; never printed |
| Agent type, requested model, and skill name | Yes (`uso-herramientas`) |
| Injected skills listing | Yes, only counts and names (`uaeh-listado-skills`); never the descriptions |
| Prompts, tool arguments, conversation content | Not printed. `uso-herramientas` does not read prompts or arguments |

`uso-tokens` and `uso-herramientas` do not print conversation content; `uso-tokens` does not print file names either. The rest of the data policy is in [privacidad.md](privacidad.md).

## Reproducing the evidence table

The table in `README.md` (section "Evidence") compares, over 1,213 real transcripts from one account, the ten days before the method (October 5 to 14, 2026) with the fifteen after (October 16 to 30, 2026). It is the author's real usage.

| Table metric | Before | After | Change | Related script |
|---|---|---|---|---|
| Tokens re-read per day | 1,149 M | 505 M | −56% (2.3× less) | `uso-tokens` (`leida-cache`) |
| Re-read per main turn | 541K | 278K | −49% | `uso-pasos` (K per step) |
| Main turns per day | 1,326 | 1,496 | +13% | `uso-tokens` and `uso-pasos` (turns and steps) |
| Output tokens per day | 1.57 M | 2.12 M | +35% | `uso-tokens` (`salida`) |

Steps to measure your own usage:

1. Run `node plugins/uaeh-kit/scripts/uso-tokens.cjs 15` and `node plugins/uaeh-kit/scripts/uso-pasos.cjs 15` (or `/uaeh-kit:medir 15`).
2. Divide the totals by the days in the window to get per-day figures.
3. Repeat after applying the method and compare.

Limits of the reproduction: the scripts count "the last N days" from today and do not accept start and end dates. Reproducing the two October windows exactly requires having the transcripts of those days and, if they must be separated, pointing `USO_RAIZ` at a folder containing only those of each period.

## What is not measured

The limits of the evidence, as declared by the root README:

- There is no A/B comparison with identical tasks.
- There is no escaped-defect rate before and after the method.
- The savings cannot be attributed to each component separately. The only isolated experiment: raising the compaction window from 400K to 700K brought back +73% consumption.

The harness figures (60 whitelist tasks in the same period, 68% PASS, median of 26 minutes, and 57% of the tasks after the adjustment citing a real finding caught by a reviewer) are also those of one author, not a promise.

## See also

- [kit.md](kit.md)
- [arnes.md](arnes.md)
- [privacidad.md](privacidad.md)
- [configuracion.md](configuracion.md)
