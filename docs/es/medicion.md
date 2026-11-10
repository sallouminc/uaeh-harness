# Medición

Esta página explica qué mide cada script de UAEH, qué datos lee y cuáles no, cómo reproducir la tabla de evidencia del README de la raíz y qué cosas no están medidas.

Los scripts miden el uso propio: no hay servidor, no hay telemetría y nada sale de la máquina.

## Scripts del kit (capa 1)

Los cuatro están en `plugins/uaeh-kit/scripts/` y los ejecuta de una vez `/uaeh-kit:medir [días]`. Todos leen transcripciones locales `.jsonl` de Claude Code: las de la variable de entorno `USO_RAIZ` si está definida; si no, las de `<carpeta de Claude Code>/projects`. Los códigos de salida son 0 correcto (también sin datos) y 1 uso incorrecto, salvo donde se indica.

| Script | Argumentos | Qué imprime |
|---|---|---|
| `uso-tokens.cjs` | `[dias]` (por defecto 7) · `--json` | Tabla por modelo (los subagentes con prefijo `sub:`), con turnos, `leida-cache` (lo releído), `escrita-cache`, `entrada` y `salida`. Luego una tabla por proyecto (los 12 mayores) y las sesiones principales más pesadas con `1er turno` (el contexto con que arrancan). Cierra con la mediana y el p90 del contexto al arrancar |
| `uso-pasos.cjs` | `[dias]` (por defecto 7) | Sesiones principales, pasos, total releído y K por paso; porcentaje de pasos con herramientas en paralelo; cadenas de 4 o más comandos o lecturas sueltos; ediciones una por una (5 o más seguidas); comandos idénticos repetidos; y la referencia del autor de octubre de 2026 |
| `uso-herramientas.cjs` | `[dias]` (por defecto 30) | Agentes lanzados por tipo, modelo pedido al lanzar cada agente (`(hereda)` si no se pidió), skills invocadas y número de workflows |
| `uaeh-listado-skills.cjs` | `<archivo.jsonl>` o `--ultima [carpeta]` · `--nombres a,b,c` · `--json` | Caracteres totales del listado de skills que se inyecta al arrancar, cuántas llevan descripción, y presencia de las skills `uae-*` y de las pedidas. Con `--json` añade las 10 líneas más largas. Salida 2 si no hay ningún listado |

La razón de medir pasos: cada paso del modelo relee toda la conversación, así que lo que no depende del resultado anterior debe ir en el mismo mensaje.

## Scripts del arnés (capa 2)

Están en `plugins/uaeh-harness/scripts/` y trabajan sobre el registro de tareas `UAEH_HOME/registro.jsonl`.

| Script | Argumentos | Qué hace |
|---|---|---|
| `uaeh-registro.cjs` | `--proyecto` `--ruta quick\|build\|deep` `--riesgo bajo\|medio\|alto\|critico` `--ciclos <n>` `--estado <estado>`; opcionales `--minutos <n>` (0 a 9999), `--escalamiento <texto>`, `--visual <tipo>`, `--tarea <texto>` (máximo 120 caracteres) | Agrega una línea JSON al registro y imprime su ruta. Acepta los riesgos `low\|medium\|high\|critical` y los guarda en español. El estado es uno de `PASS_TECHNICAL`, `PASS_RELEASE_READY`, `PENDING_HUMAN_REVIEW`, `BLOCKED_SECURITY`, `FAIL`, `UNKNOWN`. Falla con salida 1 si falta un valor o es inválido |
| `uaeh-resumen.cjs` | `[dias]` (entero de 1 o más; por defecto 30) | Resume el registro: total de tareas, por ruta y por estado, tasa de PASS (técnico más listo para lanzar), porcentaje con escalamiento, cuántas quedaron en `UNKNOWN`, ciclos promedio por ruta y, si hay dato, minutos por tarea (promedio, máximo, cuántas pasan de 60 minutos y promedio por estado). Sin tareas imprime `sin tareas registradas` |

El registro es obligatorio para el arnés: ver [arnes.md](arnes.md).

## Qué datos leen y cuáles no

| Fuente | ¿Se lee? |
|---|---|
| Campos de uso de las transcripciones (`usage`), modelo, id del mensaje, marca de tiempo, bandera de subagente | Sí (`uso-tokens`) |
| Nombres de herramientas | Sí (`uso-pasos`, `uso-herramientas`) |
| Texto de los comandos | Sí, solo en `uso-pasos`, y únicamente para contar repetidos; nunca se imprime |
| Tipo de agente, modelo pedido y nombre de la skill | Sí (`uso-herramientas`) |
| Listado de skills inyectado | Sí, solo conteos y nombres (`uaeh-listado-skills`); nunca las descripciones |
| Prompts, argumentos de herramientas, contenido de conversaciones | No se imprimen. `uso-herramientas` no lee prompts ni argumentos |

`uso-tokens` y `uso-herramientas` no imprimen contenido de conversaciones; `uso-tokens` tampoco imprime nombres de archivo. El resto de la política de datos está en [privacidad.md](privacidad.md).

## Reproducir la tabla de evidencia

La tabla de `README.es.md` (sección «Evidencia») compara, sobre 1,213 transcripciones reales de una cuenta, los diez días previos al método (5 a 14 de octubre de 2026) con los quince posteriores (16 a 30 de octubre de 2026). Es el uso real del autor.

| Métrica de la tabla | Antes | Después | Cambio | Script relacionado |
|---|---|---|---|---|
| Tokens releídos por día | 1,149 M | 505 M | −56 % (2.3× menos) | `uso-tokens` (`leida-cache`) |
| Releído por turno principal | 541K | 278K | −49 % | `uso-pasos` (K por paso) |
| Turnos principales por día | 1,326 | 1,496 | +13 % | `uso-tokens` y `uso-pasos` (turnos y pasos) |
| Tokens de salida por día | 1.57 M | 2.12 M | +35 % | `uso-tokens` (`salida`) |

Pasos para medir el uso propio:

1. Ejecutar `node plugins/uaeh-kit/scripts/uso-tokens.cjs 15` y `node plugins/uaeh-kit/scripts/uso-pasos.cjs 15` (o `/uaeh-kit:medir 15`).
2. Dividir los totales entre los días de la ventana para obtener cifras por día.
3. Repetir tras aplicar el método y comparar.

Límites de la reproducción: los scripts cuentan «los últimos N días» desde hoy y no aceptan fechas de inicio y fin. Reproducir exactamente las dos ventanas de octubre exige disponer de las transcripciones de esos días y, si hay que separarlas, apuntar `USO_RAIZ` a una carpeta que contenga solo las de cada periodo.

## Qué no está medido

Los límites de la evidencia, tal como los declara el README de la raíz:

- No hay comparación A/B con tareas idénticas.
- No hay tasa de defectos escapados antes y después del método.
- El ahorro no se puede atribuir a cada componente por separado. El único experimento aislado: subir la ventana de compactación de 400K a 700K devolvió +73 % de consumo.

Las cifras del arnés (60 tareas de lista blanca en el mismo periodo, 68 % PASS, mediana de 26 minutos, y 57 % de las tareas posteriores al ajuste que citan un hallazgo real atrapado por un revisor) son también las de un autor, no una promesa.

## Ver también

- [kit.md](kit.md)
- [arnes.md](arnes.md)
- [privacidad.md](privacidad.md)
- [configuracion.md](configuracion.md)
