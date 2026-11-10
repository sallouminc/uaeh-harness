<!-- UAEH:BEGIN v{{VERSION}} -->
## UAEH method — token efficiency and a clean cockpit (layer 1)
Measured by the method's author: ~99 % of spend is RE-READING context, not writing. These rules attack that. They are informative: nothing here blocks.

### Clean cockpit
- The main conversation decides. Anything that pulls a LOT of text you don't need to see raw goes to a subagent that returns only its conclusion: exploring or searching many files (the Explore agent), researching, auditing, building 2+ independent files (in parallel, on the cheaper model set in the configuration).
- One task per subagent, with real context and a clear deliverable. Never fork a long conversation.

### What to read
- Every project has `tasks/context-map.md` (what to read, what NOT to, commands, traps). It is injected at startup: read it instead of exploring blindly. If it is missing, create it with `/uaeh-kit:setup proyecto`.
- Read by ranges; bulk reads → subagent.

### Batch your steps
- Before every call: what else will I need that does NOT depend on this result? It goes in the SAME message (parallel calls) or in ONE command that prints a short summary, not dumps.
- The same change in 3+ files → one script that runs once; review with `git diff --stat` plus a sample of the diff.
- Checks that repeat → a script saved in the repo. Long waits run in the background with a notification, never polled turn by turn.
- Debugging (what depends on the previous result) stays step by step: don't force it.

### Small context
- 1 session = 1 block of work. The watchdog warns at 80 % of the compaction cap: finish the task, auto-save and open a new session. Don't start big new work in a session that already warned.
- Project CLAUDE.md ≤ 40,000 characters: rules, live traps, commands and current state. The dated chronicle lives in `tasks/bitacora.md` (newest first). To slim it down without losing a line: `/uaeh-kit:dieta`.
- Measure, don't guess: `/uaeh-kit:medir` (re-read tokens, loose steps, agents and skills used).

### When closing a block (auto-save)
1. Project CLAUDE.md: REPLACE the current-state section (never pile up chronicle); details go at the top of `tasks/bitacora.md`.
2. `tasks/todo.md`: mark what is done, note what is pending.
3. `tasks/lessons.md`: one lesson per correction or costly mistake (problem → root cause → how to avoid it). The same mistake fixed twice = a missing guard (test, validation, rule).

### When compacting
The summary KEEPS: the task in progress and its goal · the user's decisions and approvals, verbatim · files touched and why · pending items · verification commands with their result (PASS / FAIL / untested) · traps discovered · project and branch. It DROPS: raw tool output, contents of files read (keep only `path:line`), screenshots, failed attempts already resolved (one line with the lesson).

### Verify before declaring done
Demonstrated in the real environment, opening the artifact the way the user will, not just green tests. With no tests executed, say "untested", never "works".
<!-- UAEH:END -->
