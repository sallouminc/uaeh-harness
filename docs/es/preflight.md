# El preflight

Esta página describe `/uaeh-harness:uae-preflight`, la auditoría inicial de un repositorio antes de lanzarlo a producción. Explica cuándo se pide, qué documentos escribe, cómo funciona el sello con vigencia, qué revisa según el tipo de proyecto y qué plantillas de verificación trae el plugin.

## Cuándo se usa

El preflight es **bajo pedido**: antes de un lanzamiento a producción (la lista previa de `/uaeh-harness:uae-security lanzamiento` lo exige) o cuando el usuario lo pide por su nombre. Nunca se dispara solo: ni con la primera tarea de un proyecto, ni al vencer la vigencia, ni por la línea informativa que el plugin muestra al abrir la sesión.

Corre en un **subagente aparte** (`context: fork`, modelo Sonnet): no ve la conversación que lo llamó y le devuelve solo un resumen de 40 líneas como máximo. No edita el código de la aplicación (solo escribe en `docs/harness/`), no lanza otros subagentes y nunca lee ni imprime valores de secretos (de los `.env` solo los nombres).

```
/uaeh-harness:uae-preflight <ruta del repo> [completa|incremental <categorías>] [riesgo critico|alto|medio|bajo] [local]
```

Sin ruta usa el directorio actual. Sin repositorio git no hay sello y la corrida termina.

## Qué escribe

Los documentos van a `docs/harness/` del proyecto y forman parte de su repo:

| Documento | Contenido |
|---|---|
| `PROJECT_PROFILE.md` | Descripción, stack, dependencias y los comandos de verificación reales del proyecto. |
| `ASSET_DATA_MAP.md` | Activos, datos, transferencias y responsables. |
| `THREAT_MODEL.md` | Superficies y amenazas priorizadas. |
| `SECURITY_BASELINE.md` | Requisitos de seguridad aplicables y su evidencia. |
| `LEGAL_MATRIX.md` | Requisitos legales aplicables o por validar. |
| `SCALE_PLAN.md` | Arquitectura, cuellos de botella y umbrales. |
| `ACCEPTANCE_MATRIX.md` | Requisito, prueba y evidencia. |
| `AUDIT_REPORT.md` | Hallazgos, impacto, prioridad y responsable; incluye el historial de corridas. |
| `ROUTING_LESSONS.md` | Fallos y reglas aprendidas (solo el encabezado si no existía). |

Antes de auditar, la skill consolida lo que ya existe: auditorías previas, corridas de la puerta de seguridad, pendientes y lecciones del proyecto, y guías de marca. Cada hallazgo previo se importa con su ID y estado; no se vuelve a medir lo ya medido. Cada hallazgo nuevo lleva diez campos (ID `SEC-`, `LEG-`, `ESC-` o `DAT-` más número, evidencia, amenaza, severidad, probabilidad e impacto, acción, prueba, responsable, estado y decisión). Cada control se clasifica como `APLICA`, `NO_APLICA`, `POR_CONFIRMAR` o `REQUIERE_ABOGADO`; un hallazgo corroborado cita `archivo:línea` y una hipótesis queda `POR_CONFIRMAR`.

### Repos ajenos

Con el argumento `local`, antes de escribir se ejecuta `uaeh-ignorar.cjs --repo <repo> --local --docs-harness --aplicar`, que deja `docs/harness/` en el `.git/info/exclude` del clon y nunca toca el `.gitignore` de un repo ajeno.

## El sello y su vigencia

Al terminar, el preflight sella el resultado en `docs/harness/.preflight.json` con la huella de la superficie de riesgo del repo. El riesgo sale del proyecto (salud o dinero: `critico`; datos personales: `alto`; lo demás: `medio` o `bajo`; el argumento `riesgo` manda) y fija la vigencia:

| Riesgo | Vigencia |
|---|---|
| `critico` | 30 días |
| `alto` | 60 días |
| `medio`, `bajo` | 90 días |

Si el sello no se pudo correr, la primera línea de la respuesta lo dice con el comando para terminarlo: sin sello no hay preflight vigente.

La huella cubre siete categorías: `manifiestos`, `esquema`, `auth`, `env`, `despliegue`, `rutas` y `visual`. En la siguiente corrida:

- **Vigente y sin cambios:** responde «preflight vigente, no se repite» y termina (salvo que se pida `completa`).
- **Cambió una categoría, o venció:** corrida **incremental**: revisa el `git diff` desde el commit del sello solo de esas categorías.
- **Sin sello:** corrida completa.

La skill devuelve **delegaciones** a la conversación principal, que es la que puede lanzar subagentes: `/uaeh-harness:uae-security` (`deep` en riesgo crítico, `standard` en alto, `quick` en medio o bajo), una auditoría de base de datos o de cumplimiento con las skills que el usuario tenga, y `/uaeh-harness:uae-visual design-md` o `audit-only` si hay interfaz. Si el usuario no tiene esas skills, el punto queda como brecha en `AUDIT_REPORT.md` o como `REQUIERE_ABOGADO`.

## Revisiones por tipo de proyecto

La referencia `checks-por-stack.md` fija qué comprobaciones esperar según el stack. Los comandos nunca se copian sin validar que existen en `package.json`, `composer.json`, `pyproject.toml`, `pubspec.yaml`, `Makefile` o la CI.

| Stack | Pruebas | Tipos o análisis |
|---|---|---|
| Node / TypeScript, Next.js | `npm test` o `pnpm test`, o los scripts reales | `tsc --noEmit` o script real; lint |
| Angular / Ionic | Test configurado | `tsc` y compilación Angular |
| PHP / CodeIgniter | PHPUnit si existe | PHPStan y PHPCS si existen |
| Python / Flask / Django | `pytest` | `mypy` o `pyright`, `ruff` si existen |
| Flutter / Dart | `flutter test` | `flutter analyze` |
| Rust | `cargo test` | `cargo check`, `cargo clippy` |

Un `build` exitoso no equivale a una prueba funcional. Si no hay pruebas, se marca la brecha. Nota medida con Node 24: `node --test` cuenta un archivo de prueba vacío como «1 prueba que pasa», y Node 20 no expande un glob; la forma que sirve desde Node 20 es `node --test --test-reporter=tap` sin ruta.

## Seguridad, matriz legal y escala

- **Seguridad** (`seguridad.md` de la skill): controles de identidad y sesiones, autorización en el servidor, API y datos, migraciones y respaldos, infraestructura, con tres niveles (básico, alto, crítico) según la superficie real.
- **Matriz legal** (`legal.md`): la jurisdicción sale de `preflight.jurisdiccion` en `uaeh.config.json` (`uaeh-config.cjs jurisdiccion`); si está vacía, la deducen los hechos del repo y queda `POR_CONFIRMAR`. **No es asesoría legal**: el preflight identifica requisitos y genera una lista de verificación, no emite un dictamen ni reemplaza la asesoría jurídica de la jurisdicción que aplique.
- **Escala** (`escala.md`): mil usuarios registrados no son mil simultáneos. Pide cifras de usuarios activos, concurrencia, latencias objetivo y presupuesto; lo que no se puede medir queda `POR_CONFIRMAR`. No recomienda microservicios ni infraestructura mayor solo por llegar a cierta cifra de usuarios.

## Plantillas de verificación

El plugin trae dos plantillas para que el proyecto tenga un único comando de verificación: `plugins/uaeh-harness/templates/verify.ps1` (Windows, probada en PowerShell 5.1; en 7, sin probar) y `plugins/uaeh-harness/templates/verify.sh` (bash). El proyecto copia una a `scripts/` y adapta solo el bloque entre las marcas «comprobaciones». El preflight no la copia por su cuenta.

Contrato de salida: corren todas las comprobaciones aunque una falle e imprimen un resumen.

| Código | Significa |
|---|---|
| 0 | Todo pasó. |
| 1 | Alguna comprobación falló. |
| 3 | Nada falló, pero una comprobación de pruebas no demostró al menos una prueba real: desconocido, nunca verde. |

El conteo de pruebas es opcional por comprobación: modo `node-tap` para `node --test`, o una expresión con un grupo que capture el número (pytest, jest, vitest, PHPUnit, cargo). Los comandos son texto fijo revisado por una persona, nunca construidos desde un prompt o un archivo externo.

## uaeh-ignorar.cjs

`plugins/uaeh-harness/scripts/uaeh-ignorar.cjs` evita que la evidencia local de las puertas (capturas, reportes, estados de sesión del navegador) entre a git por descuido.

```
node "<plugin>/scripts/uaeh-ignorar.cjs" [--repo <carpeta>] [--local] [--docs-harness] [--aplicar]
```

| Bandera | Efecto |
|---|---|
| `--repo` | Repositorio a revisar. |
| `--local` | Usa el archivo privado del clon (`.git/info/exclude`) en lugar del `.gitignore`. |
| `--docs-harness` | Suma `docs/harness/`; se usa con `--local` en repos ajenos. |
| `--aplicar` | Agrega las líneas que faltan, una sola vez, y confirma con `git check-ignore`. Sin ella, solo informa. |

Códigos de salida: 0 todo ignorado · 1 falta algo · 2 error (no es un repo git, no se pudo leer o escribir) · 64 uso incorrecto.

## Plataforma

La huella, el sello y las plantillas de verificación se prueban en CI (Windows y Linux; `verify.ps1` solo en Windows PowerShell 5.1). La skill completa está probada en Windows 11.

## Ver también

- [seguridad.md](seguridad.md) — la puerta que el preflight delega.
- [visual.md](visual.md) — auditoría visual incremental y `design-md`.
- [configuracion.md](configuracion.md) — `preflight.jurisdiccion`.
- [diagnostico.md](diagnostico.md) — comprobaciones del doctor para la puerta de preflight.
- [arnes.md](arnes.md) — cómo se relaciona con el sello de integridad y el registro.
