# La puerta de seguridad

Esta página describe la puerta de seguridad de la capa 3 (`/uaeh-harness:uae-security`): qué modos tiene, en qué orden trabaja, cómo filtra falsos positivos, dónde deja las evidencias y qué no cubre. La puerta nunca confirma un hallazgo sin reproducirlo y nunca declara aprobado lo que no pudo medir.

## Modos

| Modo | Para qué |
|---|---|
| `quick` \| `standard` \| `deep` | auditoría completa del repositorio. Perfil por defecto según el riesgo del proyecto: salud o dinero → `deep`, datos personales → `standard`, lo demás → `quick` |
| `diff <base>` | revisión de un cambio de riesgo alto (dinero o cuentas); la invoca `uae-loop` (ver [arnes.md](arnes.md)) |
| `incremental <categorías>` | auditoría acotada a lo que cambió desde el último sello del preflight (ver [preflight.md](preflight.md)) |
| `reprobar <id>` | re-prueba de un arreglo: la prueba de concepto exacta ya no debe reproducirse y la prueba de regresión debe fallar sin el arreglo y pasar con él |
| `lanzamiento` | puerta bloqueante antes de publicar al público algo con datos personales, salud o dinero |

La sintaxis completa es `[quick|standard|deep|diff <base>|incremental <categorías>|reprobar <id>|lanzamiento] [ruta-repo]`. **La auditoría completa nunca se dispara sola**: se corre a pedido o como paso bloqueante antes de un lanzamiento con datos sensibles.

## El orden de trabajo

1. **Pasada determinista** (sin modelo, cero tokens), siempre primero. Crea una copia limpia del repositorio (sin archivos `.env*`, salvo `.env.example`, `.env.sample` y `.env.template`, que no contienen valores reales; sin enlaces simbólicos, sin archivos de más de 5 MB y sin las configuraciones de escáner del propio repositorio, para que un repo no pueda apagar los escáneres) y corre:

   | Herramienta | Qué revisa | Cómo corre |
   |---|---|---|
   | gitleaks | secretos, en historial y en carpeta | siempre con `--redact`: nunca imprime el valor |
   | semgrep | patrones de código inseguro | reglas locales fijadas, con `--metrics=off` y `--disable-version-check` |
   | osv-scanner | dependencias con vulnerabilidades conocidas | requiere red; envía a OSV.dev los identificadores de los paquetes, no el código ([privacidad.md](privacidad.md)) |
   | `npm audit` / `pnpm audit` | dependencias, según el gestor | consulta el registro de npm: requiere red |
   | cyber-neo (vendorizado) | secretos y archivos de bloqueo, con el Python del equipo | solo si su copia está íntegra y con el parche que enmascara la evidencia |

   Salida: `0` = `OK`, `3` = `UNKNOWN` (una herramienta `FALLÓ` o `NO_INSTALADA`; el estado global no puede ser PASS), `2` = uso o entorno inválido.
2. **Auditor de otra familia de modelos** (Codex), a ciegas y en solo lectura, en segundo plano. Es opcional y requiere consentimiento: ver [codex.md](codex.md).
3. **Auditoría con modelos** siguiendo las fases del componente `security-audit` (libro de cobertura, cazadores, verificadores, crítico). Los hallazgos de escáneres y de Codex entran como candidatos; **nunca se confirman solos**.
4. **Confirmación con prueba de concepto** en la caja de arena (`uaeh-sandbox`): contenedor Docker sin red, raíz y código en solo lectura, usuario sin privilegios, sin capacidades, datos ficticios y nunca contra producción. Un hallazgo sin reproducción queda `needs_validation`.
5. **Informe** en `docs/harness/AUDIT_REPORT.md` con cada hallazgo (`SEC-NNN`, evidencia `archivo:línea`).

Cada agente `uae-security` corre bajo el sello de integridad; un sello `ROTA` anula su veredicto.

## Filtro de falsos positivos

Todo candidato pasa por este filtro antes de gastar un verificador: debe citar `archivo:línea` con el texto releído; confianza de 8 sobre 10 o más para pasar a validación; trazado sin atacar (por ejemplo, un secreto se comprueba por formato, nunca contra la API); segunda mirada independiente del verificador, que recibe solo la ubicación y las reglas, sin el razonamiento del cazador. Un hallazgo de un escáner es un candidato, no una vulnerabilidad.

**Límite declarado:** el filtro **descarta de entrada** la denegación de servicio y el agotamiento de recursos (límites de tasa, memoria, CPU). La excepción es el gasto ilimitado en modelos de lenguaje o en APIs de pago, que sí cuenta. También descarta la falta de endurecimiento genérico, la falta de registros, los hallazgos solo de pruebas y las dependencias con CVSS menor a 4 sin vía de explotación. Quien necesite medir resistencia a la denegación de servicio debe hacerlo por otro camino.

## Escala y estados

| Gravedad (solo para lo confirmado) | Banda CVSS |
|---|---|
| crítico | 9.0 a 10.0 |
| alto | 7.0 a 8.9 |
| medio | 4.0 a 6.9 |
| bajo | 0.1 a 3.9 |

| Estado de un hallazgo | Significado |
|---|---|
| `confirmado` | reproducido en la caja de arena, con comando, entrada y límites registrados |
| `por_validar` | hipótesis con cadena en el código, bloqueada por un hecho fuera de alcance; sin gravedad |
| `rechazado` | refutado con evidencia |
| `corregido-verificado` | la prueba exacta ya no se reproduce y la regresión falla sin el arreglo y pasa con él |
| `aceptado` | riesgo aceptado por el responsable, con justificación y fecha |

El estado global es `BLOCKED_SECURITY` si queda un crítico o alto confirmado y abierto; `UNKNOWN` si faltó una herramienta obligatoria, la caja de arena o Codex, o la corrida quedó incompleta; y `PASS` en otro caso. `UNKNOWN` no es `PASS`. El modo `lanzamiento` exige además cero críticos o altos abiertos, ningún `por_validar` crítico sin plan, la pasada determinista del día en `OK`, un preflight vigente (se corre antes de lanzar; si algo cambió desde el sello, primero uno incremental), la lista previa revisada, el legal mínimo presente (términos y privacidad reales), la auditoría de Codex salvo descarte explícito del responsable (que queda escrito en el informe) y, en salud o dinero, la recomendación de una prueba de penetración humana externa. Termina en `PASS_RELEASE_READY`, `BLOCKED_SECURITY` o `PENDING_HUMAN_REVIEW`.

## Dónde quedan las evidencias

Cada corrida vive en `<runs>/run-N/`, fuera del repositorio. La carpeta base es `datos.runs` de `uaeh.config.json` o, si está vacía, `~/.claude/uaeh/runs`. Contiene la copia limpia del código (`fuente/`), `deterministico.json`, los hallazgos y el informe. La memoria entre corridas es `estado-hallazgos.json`.

Estas carpetas crecen sin límite y **guardan copias del código auditado**. La retención se gestiona con `uaeh-runs.cjs` (en seco por defecto; `--aplicar` ejecuta):

```
node "<plugin>/scripts/uaeh-runs.cjs" listar
node "<plugin>/scripts/uaeh-runs.cjs" tamano
node "<plugin>/scripts/uaeh-runs.cjs" limpiar --aplicar
```

Por defecto (`datos.retencion`) compacta a los 30 días (borra solo las copias del código y conserva hallazgos e informes), borra a los 365 y conserva siempre completas las 3 corridas más recientes de cada repositorio.

## Motor de Linux y plataforma

Los escáneres y la caja de arena corren en un motor de Linux instalado en `/opt/uaeh` (Ubuntu 24.04 x86_64): WSL2 con systemd en Windows 11, o Linux directo. Todo queda a nombre de root, fuera del alcance de los agentes, y cada descarga se verifica contra versiones y huellas fijadas en `wsl/herramientas.json`. Sin esa capa, lo que dependa de ella queda `UNKNOWN`. En macOS la caja de arena no está soportada. La instalación está en [instalacion.md](instalacion.md) y el estado se comprueba con `/uaeh-harness:doctor puertas` ([diagnostico.md](diagnostico.md)).

## Límites

- El candado de solo lectura de los revisores es de mejor esfuerzo; la frontera dura es el contenedor y la garantía del revisor es el sello.
- La caja de arena no prueba despliegue, proveedor, red de distribución, cabeceras de producción ni identidad real; eso queda `por_validar` con un plan seguro. No incluye navegador: un XSS se confirma con la respuesta renderizada o queda `por_validar`.
- La preparación de dependencias es la única etapa con red y usa `--ignore-scripts`; si un paquete necesita scripts de instalación, la prueba que lo requiera queda `por_validar`.

## Componentes de terceros

La puerta incluye, con su licencia, `security-audit` (Cloudflare), `cyber-neo` (con un parche que enmascara secretos en la evidencia) y las guías de interfaz web de Vercel Labs; usa además gitleaks, semgrep y osv-scanner instalados por separado. Las reglas de Semgrep se descargan a la máquina del usuario bajo la «Semgrep Rules License v. 1.0», que no permite ofrecerlas a terceros como servicio: quien audite código ajeno como servicio debe revisarla ([privacidad.md](privacidad.md)). El detalle y las licencias están en `THIRD_PARTY_NOTICES.md`, en la raíz del repositorio.

## Ver también

- [codex.md](codex.md): el auditor de otra familia de modelos.
- [privacidad.md](privacidad.md): qué sale de la máquina en cada paso.
- [arnes.md](arnes.md): el circuito `uae-loop` y el sello.
- [preflight.md](preflight.md): el modo `incremental` y el sello de vigencia.
- [diagnostico.md](diagnostico.md): comprobar que la puerta está `LISTA`.
