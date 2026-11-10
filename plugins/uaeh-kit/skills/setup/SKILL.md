---
name: setup
description: Instala la capa 1 del método UAEH (bloque de reglas en CLAUDE.md, ajustes recomendados, barra de estado opcional, mapa de contexto del proyecto). En seco primero; escribe solo al confirmar. / Installs UAEH layer 1 (rules block, settings, optional status line, project context map). Dry-run first.
disable-model-invocation: true
argument-hint: "[todo | claude-md | settings | statusline | proyecto [carpeta]]"
---

# /uaeh-kit:setup — instalar la capa 1

Argumento opcional (`$ARGUMENTS`): `todo` (por defecto) · `claude-md` · `settings` · `statusline` · `proyecto [carpeta]`.
Cada paso corre primero EN SECO y muestra qué cambiaría; solo se escribe con `--aplicar` tras la confirmación del usuario. Todo lo que se pisa deja respaldo `*.uaeh-respaldo-<fecha>` junto al archivo.

## Pasos

1. **Plan en seco.** Ejecuta el subcomando pedido sin `--aplicar` y muestra al usuario, en lenguaje llano, qué archivos cambiarían y cómo:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" todo
   ```
   (o `claude-md`, `settings`, `statusline`, `proyecto <carpeta>`). Añade `--idioma en` si el usuario trabaja en inglés.
2. **Confirmación.** Pregunta una sola vez si aplica todo lo mostrado (o qué partes). No escribas nada sin esa respuesta.
3. **Aplicar.** Repite el mismo comando con `--aplicar`. Reporta cada línea `HECHO` / `RESPALDO` / `SIN CAMBIOS`. Si `settings.json` no parsea, el instalador imprime el bloque a pegar: muéstraselo al usuario completo, en un bloque de código, con la ruta exacta del archivo.
4. **Mapa de contexto (solo `proyecto` o `todo` dentro de un proyecto).** Tras crear `tasks/context-map.md` desde la plantilla, **complétalo con contenido real**: lee `README`, el manifiesto del proyecto (`package.json`, `pyproject.toml`, etc.) y la estructura de carpetas (delega la exploración a un subagente si el repo es grande) y llena cada sección: qué es, stack y comandos, 5-10 archivos que importan, qué NO leer, trampas. Máximo 7,500 caracteres: ese mapa se inyecta en cada sesión nueva.
5. **Comprobar.** Corre el doctor y resume lo que no esté en OK:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.cjs" --capa kit
   ```
6. **Cierre.** Di qué quedó instalado y qué requiere reiniciar Claude Code (los cambios en `settings.json` y la barra de estado se ven en la siguiente sesión). Recuérdale que, tras instalar o actualizar el plugin, hay que cerrar y volver a abrir TODAS las sesiones de Claude Code (cada terminal y la aplicación de escritorio): una sesión abierta antes no carga los hooks nuevos y `/clear` no lo corrige. Si el doctor reportó hooks duplicados con una instalación anterior del método, explica que `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.cjs" --proponer` deja una propuesta de `settings.json` sin los duplicados para que el usuario la revise; nunca edites `settings.json` por tu cuenta.

## Qué instala cada parte
- `claude-md`: el bloque `<!-- UAEH:BEGIN -->…<!-- UAEH:END -->` con las reglas del método al final del CLAUDE.md global (o del proyecto con `--proyecto`). Con el bloque presente, el hook deja de inyectar las reglas compactas: no se duplican.
- `settings`: `env.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet"` (subagentes en el modelo económico) y `autoCompactWindow = 700000` (tope de compactación medido por el autor con ventana de 1M). Solo añade claves que falten.
- `statusline`: copia la barra a una ruta fija (`UAEH_HOME/estable/`) y la registra en `settings.json` si no hay otra barra.
- `proyecto`: `CLAUDE.md` y `tasks/{context-map,todo,lessons}.md` desde plantillas, sin pisar lo que exista.
