---
name: dieta
description: Adelgaza un CLAUDE.md de proyecto por encima de 40,000 caracteres moviendo la crónica fechada a tasks/bitacora.md sin perder ni reescribir una sola línea; un verificador lo demuestra. Úsala cuando el vigía avise de un CLAUDE.md gordo. / Slims a project CLAUDE.md into tasks/bitacora.md without losing a line; verified.
---

# /uaeh-kit:dieta — CLAUDE.md a dieta, sin perder nada

Por qué: el CLAUDE.md del proyecto se relee completo en cada turno de cada sesión y de cada subagente. El método lo limita a **40,000 caracteres**: reglas, trampas vigentes, comandos y estado actual. La crónica fechada vive en `tasks/bitacora.md`.

Instrucciones completas (qué se queda, qué se mueve, reporte final): lee `${CLAUDE_PLUGIN_ROOT}/skills/dieta/referencias/dieta.md` antes de empezar.

## Regla de oro
Toda línea del original termina **textual y completa** en el CLAUDE.md nuevo o en la bitácora. Se mueve, no se resume ni se parafrasea. Sí se puede AGREGAR texto nuevo (estado actual, punteros).

## Pasos
1. Lee el CLAUDE.md completo (por partes si es grande). Clasifica: regla vigente / comando / trampa → se queda; crónica fechada → bitácora.
2. Escribe `tasks/bitacora.md` (lo movido, en el mismo orden, lo más nuevo arriba; si ya existe, inserta sin borrar) y el CLAUDE.md nuevo con una sección «Estado actual» de ≤ 40 líneas escrita por ti y una línea que apunte a la bitácora.
3. Verifica desde la carpeta del CLAUDE.md:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/verificar-dieta-claudemd.cjs" CLAUDE.md tasks/bitacora.md
   ```
   Compara contra la versión en git (`HEAD`); si el archivo no está en git, pasa la copia original con `--original <ruta>`. Tiene que decir `RESULTADO: PASS`; si dice `FAIL`, lista las líneas perdidas: corrige y repite. Nunca edites el verificador.
4. Relee el CLAUDE.md nuevo como si fueras una sesión nueva: ¿están todas las reglas duras y la forma de publicar? Si existe `tasks/context-map.md`, añade una línea que mencione la bitácora.
5. Reporta: tamaños (original → nuevo → bitácora), salida del verificador, títulos de las secciones que quedaron, y cualquier duda de clasificación para que el usuario decida. Commit solo si te lo piden, con `git add` de esos archivos únicamente.
