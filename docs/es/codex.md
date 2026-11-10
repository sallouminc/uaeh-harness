# Codex como segundo motor (opcional)

Esta página explica para qué sirve Codex dentro de UAEH, cómo instalarlo, cómo se da y se retira el consentimiento para enviarle código, qué se le envía y qué límites tiene. Codex está **apagado por defecto**: el arnés y la puerta de seguridad funcionan completos sin él.

## Para qué sirve

Quien construyó el código no debe calificarse a sí mismo, y un modelo de otra familia suele ver cosas distintas. Codex (de OpenAI) actúa como auditor de seguridad **de solo lectura y a ciegas**: recibe el código, el alcance y el modelo de amenazas, nunca los hallazgos de Claude. Sus hallazgos entran a la puerta de seguridad como candidatos: pasan el mismo filtro y la misma confirmación en la caja de arena que los demás. Una coincidencia entre Claude y Codex sube la prioridad, no el estado. Ver [seguridad.md](seguridad.md).

## Instalar

| Paso | Quién | Comando |
|---|---|---|
| 1. Instalar la CLI | usuario | `npm i -g @openai/codex` |
| 2. Iniciar sesión | usuario, en su terminal | `codex login` |
| 3. Dar el consentimiento | usuario (ver abajo) | `instalar.cjs puertas codex --consiento --aplicar` |

Versión mínima: **0.163.0** (constante `CODEX_MINIMO` de `plugins/uaeh-harness/scripts/doctor-puertas.cjs`). Con una versión anterior el doctor emite `AVISO`, porque el aislamiento se midió con esa versión o una superior. El estado se revisa con `node "<plugin>/scripts/doctor-puertas.cjs" --puerta codex`; si Codex está apagado, el veredicto es `APAGADA` y no impide el veredicto global.

## Consentimiento

Usar Codex como auditor **envía a OpenAI una copia limpia del repositorio auditado**. Por eso:

- `codex.habilitado` vale `false` por defecto. Con ese valor, `auditor-codex.cjs` sale con código 3 (`NO_HABILITADO`) sin lanzar Codex ni enviar nada.
- Habilitar (escribe `codex.habilitado=true` y la fecha en `codex.consentimiento`, con respaldo):

  ```
  node "<plugin>/scripts/instalar.cjs" puertas codex --consiento --aplicar
  ```
- Retirar el consentimiento (vuelve a apagarlo):

  ```
  node "<plugin>/scripts/instalar.cjs" puertas codex --retirar --aplicar
  ```

Sin `--aplicar` el instalador solo muestra lo que haría. Aun habilitado, no debe usarse con código que no pueda compartirse con ese proveedor, ni en un repositorio ajeno sin el visto bueno de su responsable. Sin Codex, la puerta de seguridad sigue funcionando; solo la pieza de la segunda familia queda sin correr y se reporta como tal (el modo `lanzamiento` la exige salvo descarte explícito del responsable).

## Qué se envía

Se envía el contenido de la copia limpia `<run>/fuente/` (ver [privacidad.md](privacidad.md)): sin archivos `.env*` (salvo `.env.example`, `.env.sample` y `.env.template`, que no contienen valores reales), sin archivos ignorados por git y sin las configuraciones de escáner del repositorio. En el modo `diff` se añade el parche de lo cambiado (también sin `.env`, con la misma salvedad). Nunca se usa `codex exec review --uncommitted`, porque incluiría archivos no rastreados.

## Niveles y modelos

El auditor acepta `--modelo profundo|equilibrado|rapido`. El modelo y el esfuerzo de cada nivel salen de `codex.modelos` en `uaeh.config.json`, no de la configuración propia de Codex:

| Nivel | Modelo por defecto | Esfuerzo | Uso típico |
|---|---|---|---|
| `profundo` | `gpt-6-astra` | `high` | auditorías estándar o profundas y diffs de dinero o cuentas |
| `equilibrado` (defecto) | `gpt-6-sol` | `medium` | auditorías rápidas e incrementales |
| `rapido` | `gpt-6-luna` | `medium` | tareas ligeras |

El esfuerzo admite `low`, `medium`, `high` o `xhigh`. Los alias antiguos `astra` y `sol` equivalen a `profundo` y `equilibrado`. El nivel profundo suele tener una cuota corta por ventana de tiempo: conviene reservarlo para lo que lo merece.

## Tiempos

Codex corre en segundo plano. En diffs reales, el autor midió de 1.5 a 2 minutos por corrida. El tope de una corrida sale de la configuración: `codex.timeoutDiffMin` (**10 minutos** por defecto) en el modo `diff` y `codex.timeoutCompletaMin` (**40 minutos** por defecto) en el modo `completa`. Si el auditor se lanza con `--timeout-min N`, ese valor manda. Al vencer el tope se mata el árbol de procesos, y el tope usado queda en `codex/resumen.json` (`tope_min`). Detalle de las claves en [configuracion.md](configuracion.md).

## Prueba de aislamiento

Antes de confiar en el auditor, y tras cada actualización de Codex:

```
node "<plugin>/skills/uae-security/scripts/auditor-codex.cjs" --probar-sandbox
```

Debe responder `SANDBOX_OK` (lee y no escribe), usando una carpeta de juguete: no envía código del usuario. Si no responde así, el auditor Codex queda `UNKNOWN` y se reporta. `doctor-puertas.cjs --puerta codex --vivo` la corre y recuerda el resultado; esa prueba gasta cuota de Codex. Sin `--vivo`, el doctor avisa si Codex cambió de versión desde la última prueba.

## Límites conocidos

- **Windows:** el sandbox de solo lectura **no restringe la lectura a la copia limpia**. El prompt le indica leer solo la copia, pero un modelo que desobedezca podría leer otras rutas del disco. Por eso la copia limpia es la defensa principal y nunca se le entrega una ruta del repositorio real. En Windows el auditor usa `windows.sandbox="elevated"` (sin él, el modo de solo lectura bloquea hasta la lectura); medido por el autor con las versiones 0.157.0 y 0.163.0.
- **Linux:** se usa `-s read-only` sin argumentos extra. **No está probado por el autor**; `--probar-sandbox` lo comprueba en cada máquina.
- El campo `sandbox_mode` de los agentes de Codex no es una garantía (medido por el autor). La garantía es el sello de integridad ([arnes.md](arnes.md)).
- **Lo medido:** Windows 11 con Codex CLI 0.163.0 y sesión iniciada con `codex login`; allí `--probar-sandbox` responde `SANDBOX_OK`.
- **Lo que el autor no midió:**
  - Codex en Linux con `-s read-only`.
  - La autenticación por clave de API en lugar de `codex login`.
  - La disponibilidad de los modelos por defecto (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`) en otras cuentas o planes. Si un modelo no está disponible, se cambia en `codex.modelos`.
  - En toda máquina, `--probar-sandbox` es la comprobación.

## Plantillas de Codex

`instalar.cjs codex` (o `/uaeh-harness:setup codex`) funciona aunque Codex esté apagado (avisa con una nota); `instalar.cjs todo` solo lo incluye si `codex.habilitado` es `true`. Deja Codex trabajando con las mismas reglas que Claude Code, por ejemplo para relevarlo cuando se le acaba el límite de uso. Es en seco por defecto; con `--aplicar` escribe y respalda lo que pisa:

| Qué | Dónde | Cómo |
|---|---|---|
| Bloque UAEH | `~/.codex/AGENTS.md`, entre los marcadores `UAEH:BEGIN` y `UAEH:END` | se reemplaza en su sitio sin tocar el resto del archivo |
| Cinco agentes `uae_architect`, `uae_builder`, `uae_security`, `uae_triage`, `uae_verifier` | `~/.codex/agents/` | modelo y esfuerzo salen de `codex.modelos` |
| Fragmento de `config.toml` | solo se imprime | **el usuario lo pega a mano** en `~/.codex/config.toml` |

El fragmento trae cuatro claves: `project_doc_fallback_filenames`, `project_doc_max_bytes`, `max_concurrent_threads_per_session` y `sandbox` de Windows. El plugin nunca edita `config.toml` por su cuenta. En Windows, el sandbox `elevated` puede pedir permiso de administrador la primera vez.

Para retirarlas, `instalar.cjs codex --quitar --aplicar` (ver [desinstalar.md](desinstalar.md)); el fragmento pegado en `config.toml` se quita a mano.

## Ver también

- [seguridad.md](seguridad.md): dónde entra Codex en el orden de trabajo.
- [privacidad.md](privacidad.md): qué sale de la máquina y con qué permiso.
- [configuracion.md](configuracion.md): el bloque `codex` de `uaeh.config.json`.
- [diagnostico.md](diagnostico.md): la puerta `codex` del doctor.
