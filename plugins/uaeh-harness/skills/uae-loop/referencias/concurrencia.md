# Varias terminales en el mismo repo

El riesgo es que dos sesiones escriban los mismos archivos o que un revisor mida un cambio que no es el suyo.

1. **Worktree solo si otra terminal está escribiendo en el mismo repo ahora mismo.** Nunca para repartir una sola tarea
   entre agentes.
2. Un archivo compartido tiene **un solo dueño de escritura** a la vez.
3. Los revisores evalúan el **commit exacto** de la tarea (paso 5 de la skill `uae-loop`), no una carpeta que cambia mientras
   revisan; el sello lo comprueba.
4. No correr migraciones contra la misma base de desarrollo desde dos terminales sin coordinar.
5. Nada con efectos globales en paralelo: instalar dependencias en la misma carpeta, limpiar compilados, cambiar
   configuración global.
6. Las pruebas pesadas (Playwright, compilaciones) van de una en una; si el proyecto tiene un candado de pruebas pesadas,
   se usa.
7. Un worktree **no** aísla secretos ni infraestructura.

```
git status --short
git worktree add <carpeta-de-copias>/<proyecto>-<tarea> -b uae/tarea
```
Si la rama ya existe, ajustar el comando; nunca crear un worktree sobre cambios sin guardar sin plan.

**Dónde y hasta cuándo:** la copia va en `<carpeta-de-copias>/<proyecto>-<tarea>`, una carpeta **fuera del repo y fuera
del escritorio** (medido por el autor: ocho carpetas de copias y respaldos quedaron sueltas en el escritorio). Al cerrar
la tarea, con `git -C <copia> status --short` vacío y los commits ya en su rama, la sesión que la creó la quita con
`git worktree remove <ruta>` (sin `--force`); lo útil de `output/` (ignorado por git) se pasa antes a la carpeta
principal. Las ramas no se borran sin autorización.

## Relevo Claude → Codex (cuando a Claude se le acaba el límite de uso)
Misma carpeta y misma rama, **sin** worktree: Codex lee el `CLAUDE.md` del proyecto si se configura
`project_doc_fallback_filenames` (está en el fragmento `config.snippet.toml` del plugin, que se pega a mano) y su
`AGENTS.md` global trae el bloque «Relevo desde Claude Code» (lo inserta el instalador de Codex del plugin). Basta con que
el estado del `CLAUDE.md` y `tasks/todo.md` estén al día (el auto-guardado de siempre). Worktree solo si los dos escriben
a la vez.

## Trampas de Windows ya medidas (aplican a cualquier worktree)
- **Rutas largas:** `git worktree add` falla → `git -c core.longpaths=true worktree add …` (medido en un proyecto con
  rutas profundas).
- **Mover una copia con pnpm la rompe:** sus `node_modules` son enlaces con la ruta absoluta de la ubicación vieja
  (medido al sacar una copia de una carpeta a otra). Nunca mover una copia: quitarla y crear otra.
- **`node_modules` no viaja.** Si se enlaza al principal con una unión, se quita con `cmd /c rmdir <ruta>`; **nunca**
  `Remove-Item -Recurse` (borra el original; medido en una tarea real).
- **Capacitor:** `cap sync` escribe rutas absolutas en `android/capacitor.settings.gradle` → `git restore` de ese archivo
  antes de cada commit, o rompe el checkout principal al unir. Los archivos de Android cambiados a media revisión
  dejaron el sello ROTA dos veces.
