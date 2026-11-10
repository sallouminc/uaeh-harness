---
name: uae-preflight
description: Auditoría inicial (preflight) de un repositorio antes de lanzarlo a producción o cuando el usuario la pide por su nombre (project audit, launch readiness). Consolida auditorías previas, inventaría stack, auth, datos, API, despliegue, legal y escala, escribe 9 documentos en docs/harness/ y deja un sello con fecha y huella. No se dispara sola.
argument-hint: "<ruta del repo> [completa|incremental <categorías>] [riesgo critico|alto|medio|bajo] [local]"
context: fork
agent: general-purpose
model: sonnet
---
# /uaeh-harness:uae-preflight — auditoría inicial de un repositorio

Entrada: $ARGUMENTS (sin ruta = directorio actual).

**Cuándo entra:** antes de un lanzamiento a producción (la lista previa de `/uaeh-harness:uae-security lanzamiento` lo exige) o cuando el usuario la pide por su nombre. Nunca con la primera tarea de un proyecto, ni al vencer la vigencia, ni por la línea informativa que el plugin da al abrir la sesión. Corre en un contexto aparte: no ve la conversación que la llamó y le devuelve solo un resumen.

**Plataformas:** Node ≥ 20 y git. Probado en Windows 11; en Linux y macOS no probado (no usa el motor de Linux).

## Prefijos (se definen una vez; el resto del documento los usa)
- `<huella>` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-huella.cjs"` (huella de la superficie de riesgo y sello).
- `<runs>` = la salida de `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-config.cjs" runs-dir --repo <repo>` (corridas de la puerta de seguridad, fuera del repo).
- `<jurisdicción>` = la salida de `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-config.cjs" jurisdiccion` (`preflight.jurisdiccion` de la configuración; una línea vacía = sin configurar).

## Reglas duras
- No editas el código de la aplicación: solo escribes en `docs/harness/`.
- No lanzas subagentes ni skills que los lancen: las auditorías especializadas se **devuelven como delegaciones**.
- Nunca lees, copias ni imprimes valores de secretos (de los `.env` solo los nombres).
- Distingue un hallazgo corroborado (`archivo:línea`) de una hipótesis (`POR_CONFIRMAR`).
- No inventas comandos: cada comando de verificación sale de un manifiesto o de la CI del repo.

## 1. ¿Hace falta?
Corre `<huella> comparar <repo>`:
- `sin git` → sin repositorio git no hay sello: dilo y termina.
- «vigente» y no se pidió `completa` → responde «preflight vigente del <fecha>, no se repite» y **termina**.
- «cambió <categorías>» o «vencido» → modo **incremental**: revisa `git diff <commit del sello>..HEAD` de esas categorías y actualiza solo las secciones afectadas (vencido sin cambios: repasa fechas, pendientes y lo que quedó `POR_CONFIRMAR`).
- «sin preflight», o se pidió `completa` → modo **completo**.

## 2. ¿Al repo o local?
`docs/harness/` es documentación del proyecto y va a su repo. Si el argumento trae `local` (repo de un cliente o ajeno), **antes de escribir** corre `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-ignorar.cjs" --repo <repo> --local --docs-harness --aplicar`: lo anota en el `.git/info/exclude` del clon y confirma con `git check-ignore`. Nunca toques el `.gitignore` de un repo ajeno.

## 3. Consolidar lo que ya existe (antes de auditar nada)
Busca y lee:
- auditorías previas: `docs/**` con `AUDIT`, `SEGURIDAD`, `SECURITY`, `ARQUITECTURA` o `REQUISITOS` en el nombre, y el `docs/harness/` anterior;
- corridas de la puerta de seguridad: `<runs>/estado-hallazgos.json` y `<runs>/run-*/findings.json`;
- las secciones de seguridad de la lista de pendientes del proyecto (por ejemplo `tasks/todo.md`), las trampas de su `CLAUDE.md` y sus lecciones (`tasks/lessons.md`), si existen;
- las guías de marca (`marca/`, `brand/`, `DESIGN*`).

Importa cada hallazgo previo con su ID, su estado y su fuente. **No vuelvas a auditar lo ya medido.**

## 4. Inventario y documentos
Referencias (léelas al llegar a cada documento): `referencias/formato.md` · `referencias/checks-por-stack.md` · `referencias/seguridad.md` · `referencias/legal.md` · `referencias/escala.md`.
- **Inventario** (campos en `referencias/formato.md`): stack y manifiestos · CI y despliegue · actores y roles · auth y sesión (¿tokens en `localStorage`?) · flujo y clases de datos · nombres de secretos · terceros · pruebas existentes y sus comandos reales · escala.
- **Escribe en `docs/harness/` los 9 documentos:**
  - `PROJECT_PROFILE.md`, con «Comandos de verificación» reales por stack (`referencias/checks-por-stack.md`). Si el repo no tiene script de verificación, anótalo como brecha y cita la plantilla que debe adaptar: `${CLAUDE_PLUGIN_ROOT}/templates/verify.ps1` (Windows) o `${CLAUDE_PLUGIN_ROOT}/templates/verify.sh` (bash). No la copies tú;
  - `ASSET_DATA_MAP.md`;
  - `THREAT_MODEL.md`;
  - `SECURITY_BASELINE.md` (`referencias/seguridad.md`);
  - `LEGAL_MATRIX.md` (`referencias/legal.md`): jurisdicción = `<jurisdicción>`; si sale vacía, la que muestren los hechos del repo, marcada `POR_CONFIRMAR`;
  - `SCALE_PLAN.md` (`referencias/escala.md`);
  - `ACCEPTANCE_MATRIX.md` (requisito → prueba → evidencia);
  - `AUDIT_REPORT.md`;
  - `ROUTING_LESSONS.md`, solo con encabezado si no existe.
- **Cada control:** `APLICA | NO_APLICA | POR_CONFIRMAR | REQUIERE_ABOGADO`, con evidencia, gravedad, prioridad y prueba exigida.
- **Cada hallazgo:** con el formato de 10 campos de `referencias/formato.md` (ID `SEC-/LEG-/ESC-/DAT-NNN`; los importados conservan su ID).
- Pide revisión humana en lo legal, producción, dinero, salud y migraciones destructivas.

## 5. Sello
**Riesgo del proyecto** (si el argumento trae `riesgo`, manda el argumento):
- salud o dinero → `critico`;
- datos personales → `alto`;
- lo demás → `medio` o `bajo`.

La vigencia sale del riesgo: 30 días en `critico`, 60 en `alto`, 90 en `medio` y `bajo`.

```
<huella> sellar <repo> --tipo <completa|incremental> --riesgo <r> --hallazgos <IDs abiertos> --nuevos <n> --cerrados <m> --categorias <auditadas>
```
Categorías de la huella: `manifiestos`, `esquema`, `auth`, `env`, `despliegue`, `rutas`, `visual`. El sello queda en `docs/harness/.preflight.json` y suma una fila al «Historial de corridas» de `AUDIT_REPORT.md`: esa sección la crea y la llena solo el sello; no escribas ni su título. Si el sello no se pudo correr, dilo en la primera línea de la respuesta, con el comando para terminarlo: sin sello no hay preflight vigente.

## 6. Respuesta (40 líneas como máximo; solo la ve la conversación que te llamó)
- **Resumen:** riesgo, tipo de corrida, sello (fecha, hora y commit), documentos escritos y los 3-5 hallazgos más graves con `archivo:línea`.
- **DELEGACIONES** para la conversación principal, que es la que puede lanzar subagentes:
  - `/uaeh-harness:uae-security <quick|standard|deep>`: siempre en una corrida completa (`critico` → `deep`, `alto` → `standard`, `medio` o `bajo` → `quick`). En una incremental, solo si cambió `auth`, `esquema`, `env`, `rutas` o `manifiestos`, y entonces `/uaeh-harness:uae-security incremental <categorías cambiadas>`;
  - auditoría de base de datos con la skill que el usuario tenga para eso: si hay esquema o migraciones y no hay una auditoría previa (si no tiene ninguna, queda como brecha en `AUDIT_REPORT.md`);
  - revisión de cumplimiento legal con la skill que el usuario tenga para eso: si hay datos personales, salud o pagos (si no tiene ninguna, esos puntos quedan `REQUIERE_ABOGADO`);
  - `/uaeh-harness:uae-visual design-md`: si hay interfaz y falta `DESIGN.md`;
  - `/uaeh-harness:uae-visual audit-only`: en una corrida completa de un proyecto con interfaz; en una incremental, solo si cambió `visual`, y entonces `/uaeh-harness:uae-visual audit-only incremental`.
- Para cada delegación indica qué debe actualizar después en `AUDIT_REPORT.md`.
