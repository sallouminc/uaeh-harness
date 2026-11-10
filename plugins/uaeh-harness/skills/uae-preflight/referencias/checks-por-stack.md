# Comprobaciones por stack — preflight (uae-preflight)

Fuente de verdad: este archivo (origen: el Playbook UAEH del autor, no publicado).

## Tabla de comprobaciones según el stack

| Stack | Pruebas | Tipo/análisis | Estilo | Complementos |
|---|---|---|---|---|
| Node/TS | `npm test` / `pnpm test` | `tsc --noEmit` o script real | `eslint` / script real | Playwright, audit deps, SAST |
| Next.js | Scripts reales de `package.json` | Typecheck | Lint | E2E cookies, roles, admin, API |
| Angular/Ionic | Test configurado | `tsc`, compilación Angular | Lint | Seguridad navegador/móvil diferenciada |
| PHP/CodeIgniter | PHPUnit si existe | PHPStan si existe | PHPCS si existe | Tests auth/RBAC/migraciones |
| Python/Flask/Django | `pytest` | `mypy`/`pyright` si existe | `ruff` si existe | Tests API + DB + bandit/pip-audit |
| Flutter/Dart | `flutter test` | `flutter analyze` | Incluido en analyzer | Integración móvil + secure storage |
| Rust | `cargo test` | `cargo check` | `cargo clippy` | Audit dependencias si aplica |

**Nunca copiar comandos sin validar su existencia** en `package.json`, `composer.json`, `pyproject.toml`, `pubspec.yaml`, `Makefile` y la CI. Si no hay pruebas, marcar la brecha y crear criterios o una prueba mínima antes de declarar aptitud para producción. Un `build` exitoso no equivale a una prueba funcional.

**`node --test` cuenta de más** (medido con Node 24): un archivo `.test.js` sin pruebas cuenta como «1 prueba que pasa» (su nombre es la ruta del archivo), y una carpeta como argumento (`node --test test/`) se corre como módulo y falla. **Node 20 no expande un glob** pasado como argumento (`node --test "test/**/*.test.js"` → «Could not find»; los globs llegaron en Node 21). La forma que sirve desde Node 20: `node --test --test-reporter=tap` sin ruta (descubre `*.test.js`, `test/` y similares). Contar solo las pruebas reales y tratar «0 pruebas» como desconocido, nunca como verde.

## Script de verificación (plantillas del plugin)

El plugin trae dos plantillas probadas: `templates/verify.ps1` (Windows; probada en PowerShell 5.1, en 7 sin probar) y `templates/verify.sh` (bash: Linux, macOS, Git Bash). La ruta completa está en SKILL.md. El proyecto copia una a `scripts/` y **adapta solo el bloque de comprobaciones** con sus comandos reales.

- Corren todas las comprobaciones aunque una falle e imprimen un resumen por comprobación.
- Código de salida: `0` todo pasó · `1` alguna comprobación falló · `3` ninguna falló, pero una comprobación de pruebas no demostró al menos una prueba real (desconocido: sin pruebas no hay verde).
- El conteo de pruebas es opcional por comprobación: modo `node-tap` para `node --test` (descuenta los archivos sin pruebas) o una expresión con un grupo que capture el número de pruebas de otros ejecutores (pytest, jest, vitest, PHPUnit, cargo).

**Precauciones:**
- Los comandos de la lista son **estáticos y revisados por un humano**, nunca entrada arbitraria de un prompt o de un archivo externo.
- En Windows los comandos se ejecutan con `cmd.exe` por compatibilidad con `npm.cmd`; para Python, PHP o Flutter conviene la invocación directa con argumentos bien definidos.
- Ningún comando escribe datos sensibles ni destruye entornos.
- `npm test -- --run` es propio de algunos ejecutores y puede ser incorrecto para otros.

Si una prueba falta, **no borrarla en silencio**: clasificar la ausencia como brecha y planear su implementación. En un proyecto puramente documental, `N/A` puede ser legítimo con justificación.
