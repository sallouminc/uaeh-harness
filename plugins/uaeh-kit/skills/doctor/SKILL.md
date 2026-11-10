---
name: doctor
description: Diagnostica la instalación de la capa 1 de UAEH (Node, hooks, duplicados en settings, config, tope de compactación, inyección real del contexto, tamaño de CLAUDE.md, barra de estado) y explica qué arreglar. / Diagnoses the UAEH layer-1 install and explains what to fix.
disable-model-invocation: true
---

# /uaeh-kit:doctor — diagnóstico de la capa 1

1. Ejecuta el doctor desde la carpeta del proyecto actual:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.cjs" --capa kit
   ```
2. Reporta al usuario solo lo que no esté en `OK`, en lenguaje llano, agrupado por estado:
   - `FALLÓ`: algo roto que impide trabajar (p. ej. Node viejo, hook que apunta a un script inexistente, ni bloque ni inyección de reglas). Da el arreglo concreto.
   - `AVISO`: funciona, pero no como recomienda el método (sin tope de compactación, CLAUDE.md por encima de 40,000 caracteres, bloque de reglas desactualizado, hooks duplicados con una instalación anterior, barra sin instalar). Di qué comando lo resuelve (`/uaeh-kit:setup <parte>`, `/uaeh-kit:dieta`).
   - `NO_INSTALADA`, `NO_APLICA`, `OMITIDA`: solo menciónalos si el usuario preguntó por esa pieza.
3. **Inyección real.** Si `inyeccion` no está en `OK`, explica que la marca `[uaeh-kit ctx v1]` todavía no aparece en ninguna transcripción reciente: el plugin debe estar cargado al abrir una sesión nueva; después se vuelve a correr el doctor. Un hook que «funciona» puede no estar inyectando nada: por eso se comprueba en el transcript y no en la salida del hook.
4. **Duplicados.** Si hay hooks duplicados en `settings.json` (una instalación anterior del método a mano), ofrece generar la propuesta:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.cjs" --capa kit --proponer
   ```
   Deja `settings.uaeh-propuesto.json` junto al archivo original sin tocarlo. El usuario decide si lo adopta; nunca edites `settings.json` por tu cuenta.
5. Con `--json` se obtiene la misma información para scripts: `{ comprobaciones: [{ id, estado, detalle }], resumen, codigo }`. Código de salida 0 sin `FALLÓ`, 1 con `FALLÓ`.
