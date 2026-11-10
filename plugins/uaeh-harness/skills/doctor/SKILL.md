---
name: doctor
description: Diagnostica el arnés UAEH sin cambiar nada. Capa 2 (guarda de git, espejo, candado, sello) y puertas de la capa 3 (seguridad, visual, Codex, preflight) con un veredicto por puerta y el comando que arregla cada falla. Úsala tras instalar o actualizar el plugin, o cuando una puerta da UNKNOWN.
argument-hint: "[arnes | puertas [--puerta seguridad|visual|codex|preflight] [--rapido | --vivo]]"
disable-model-invocation: true
---
# UAEH · doctor del arnés

Argumentos: $ARGUMENTS (sin argumentos: las dos partes, en modo normal)

Solo diagnostica: nada de lo que corre aquí cambia la máquina. Las autopruebas trabajan en carpetas temporales que se borran.

1. **Capa 2** (`arnes`):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.cjs"
   ```
   Revisa git, la guarda global de git (`core.hooksPath` → el espejo), que el espejo sea igual al plugin, duplicados en `settings.json`, copias personales de agentes o skills con el mismo nombre que las del plugin, y tres autopruebas: humo de la guarda en un repo temporal, candado de los revisores (niega un borrado a `uae-verifier`, deja pasar a la sesión principal) y sello (`INTACTO` y luego `ROTA`). `--rapido` salta las autopruebas.

2. **Puertas** (`puertas`):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor-puertas.cjs" [--puerta <p>] [--rapido | --vivo]
   ```
   Estado por puerta: `LISTA` · `NO_INSTALADA` (falta una pieza) · `NO_LISTA` (algo falló) · `APAGADA` (Codex sin consentimiento: es opcional y no impide el veredicto). Veredicto `LISTA` si todas las pedidas están `LISTA` o `APAGADA`.
   - `--vivo` gasta: corre la prueba de aislamiento de Codex (consume cuota de Codex, ~2 min) y la autoprueba visual con un navegador real (~2 min). **Pide el OK del usuario antes de usarlo.**

## Después
- Muestra el resultado tal cual, primero el veredicto y luego solo lo que no está en `OK` (con su comando de arreglo). Una `OMITIDA` no se midió: nunca la presentes como bien.
- Para instalar o reparar lo que falta: `/uaeh-harness:setup puertas <puerta>` (en seco primero). Lo que pide administrador o contraseña (instalar WSL, `sudo`, `wsl --terminate`, `codex login`) lo corre el usuario en su terminal: dale el comando exacto.
