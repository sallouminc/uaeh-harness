---
name: medir
description: Mide el uso real de Claude Code en los últimos N días a partir de las transcripciones locales (tokens releídos por modelo y proyecto, pasos uno por uno vs en paralelo, agentes y skills usados, peso del listado de skills) y recomienda. / Measures real local usage and recommends.
disable-model-invocation: true
argument-hint: "[días]"
---

# /uaeh-kit:medir — medir, no suponer

Argumento opcional (`$ARGUMENTS`): número de días (por defecto 7). Los cuatro scripts leen SOLO las transcripciones locales de Claude Code (campos de uso, nombres de herramientas, agentes y skills); nunca imprimen contenido de conversaciones ni comandos, y nada sale de la máquina.

1. Corre las cuatro mediciones en UN solo comando (no una por turno: cada paso relee toda la conversación):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/uso-tokens.cjs" 7 && echo ---- && node "${CLAUDE_PLUGIN_ROOT}/scripts/uso-pasos.cjs" 7 && echo ---- && node "${CLAUDE_PLUGIN_ROOT}/scripts/uso-herramientas.cjs" 30 && echo ---- && node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-listado-skills.cjs" --ultima
   ```
   (sustituye `7` por los días pedidos).
2. Interpreta para el usuario, en lenguaje llano y con los números de la salida:
   - **Dónde se va el gasto:** la columna `leida-cache` es lo RELEÍDO; compárala con `salida` (lo escrito). Si lo releído es decenas de veces lo escrito, el problema es contexto, no verbosidad. Sesiones con `1er turno` alto arrancan pesadas: suele ser un CLAUDE.md gordo o un listado de skills largo.
   - **Pasos:** % de pasos con herramientas en paralelo (meta: subir), cadenas de 4+ lecturas o comandos sueltos y comandos idénticos repetidos (meta: bajar). Referencia del autor del método: cadenas ≈ 34 % de lo releído, paralelo ≈ 30 %, ≈ 289K releídos por paso, antes de aplicar la regla de juntar pasos.
   - **Agentes y skills:** qué subagentes se lanzan y con qué modelo (si casi todo «hereda» el modelo caro, falta `CLAUDE_CODE_SUBAGENT_MODEL`); qué skills se usan de verdad.
   - **Listado de skills:** caracteres que se inyectan en CADA sesión por descripciones de skills; las más largas son candidatas a acortar. Claude Code recorta cada descripción a 1,536 caracteres y reserva al listado el 1 % de la ventana; en `settings.json`, `skillListingMaxDescChars` y `skillListingBudgetFraction` acotan ese presupuesto.
3. Termina con 3 recomendaciones concretas como máximo, ordenadas por ahorro esperado, cada una con el comando o la acción (`/uaeh-kit:dieta` para un CLAUDE.md gordo, `/uaeh-kit:setup settings` si falta el tope o el modelo de subagentes, acortar descripciones de skills, cerrar sesiones largas).
