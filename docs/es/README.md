# Documentación de UAEH

Este índice reúne las páginas de la documentación de usuario de UAEH (versión 1.0) y indica cuál leer según lo que se necesite. Cada página explica un tema completo y enlaza a las vecinas.

UAEH es un método de trabajo para programar con agentes de IA, empaquetado como dos plugins de Claude Code: `uaeh-kit` (capa 1, solo informa) y `uaeh-harness` (capas 2 y 3, con hooks que pueden bloquear una acción). Un hook es un pequeño programa que Claude Code ejecuta automáticamente en ciertos momentos de la sesión.

[English](../en/README.md)

## Si se busca X, ir a la página Y

| Si se busca… | Página |
|---|---|
| Instalar, actualizar o comprobar que todo funciona | [instalacion.md](instalacion.md) |
| Las reglas del método, el vigía de contexto, la barra de estado, la dieta de CLAUDE.md | [kit.md](kit.md) |
| El circuito de verificación: revisores independientes, sello de integridad, registro de tareas, guardia de cierre, guarda de git | [arnes.md](arnes.md) |
| La puerta de seguridad (escáneres, auditor Codex, caja de arena) | [seguridad.md](seguridad.md) |
| La auditoría visual en navegador y de diseño | [visual.md](visual.md) |
| El preflight de lanzamiento y sus nueve documentos y su sello con vigencia | [preflight.md](preflight.md) |
| Usar Codex como segundo motor y qué se envía a OpenAI | [codex.md](codex.md) |
| Todas las claves de `uaeh.config.json` y las variables de entorno | [configuracion.md](configuracion.md) |
| Qué sistema operativo está soportado, probado o sin probar | [plataforma.md](plataforma.md) |
| Diagnosticar un problema o interpretar un veredicto de los doctores | [diagnostico.md](diagnostico.md) |
| Retirar UAEH sin dejar la máquina a medias | [desinstalar.md](desinstalar.md) |
| Qué lee y qué escribe UAEH, y qué sale de la máquina | [privacidad.md](privacidad.md) |
| Medir el uso propio y reproducir la tabla de evidencia | [medicion.md](medicion.md) |

## Orden de lectura recomendado

1. [instalacion.md](instalacion.md): requisitos, instalación de los dos plugins y comprobación con los doctores.
2. [kit.md](kit.md): la capa 1. Es la que produce el ahorro medido y la única que no bloquea nada.
3. [arnes.md](arnes.md): la capa 2. Añade control sobre cambios de riesgo alto (dinero, cuentas, base de datos, producción con datos reales).
4. Las puertas de la capa 3, según la necesidad: [seguridad.md](seguridad.md), [visual.md](visual.md), [preflight.md](preflight.md) y, si se desea un segundo motor, [codex.md](codex.md).
5. Consulta cuando haga falta: [configuracion.md](configuracion.md), [plataforma.md](plataforma.md), [diagnostico.md](diagnostico.md), [privacidad.md](privacidad.md), [medicion.md](medicion.md) y [desinstalar.md](desinstalar.md).

## Las tres capas, en una tabla

| Capa | Plugin | Qué aporta | Bloquea |
|---|---|---|---|
| 1. Método y kit de eficiencia | `uaeh-kit` | Reglas, mapa de contexto, vigía de la ventana de contexto, dieta de CLAUDE.md, mediciones, barra de estado | No |
| 2. Arnés de verificación | `uaeh-harness` | Revisores independientes, sello de integridad, registro, guardia de cierre, guarda de git | Sí |
| 3. Puertas | `uaeh-harness` | Seguridad, visual y preflight | Sí, en la parte de revisores |

## Convenciones de esta documentación

- Los comandos de terminal van en bloques de código. `<plugin>` es la carpeta donde Claude Code instaló el plugin; `<carpeta del proyecto>` es el repositorio de trabajo.
- `UAEH_HOME` es la carpeta de estado de UAEH: por defecto `~/.claude/uaeh`.
- Los estados de las comprobaciones (`OK`, `AVISO`, `FALLÓ`, `OMITIDA`, `NO_INSTALADA`, `NO_APLICA`) y los veredictos de las puertas (`LISTA`, `NO_INSTALADA`, `NO_LISTA`, `APAGADA`) se escriben tal cual los imprime el software.
- Los instaladores trabajan en seco por defecto: solo `--aplicar` escribe, y deja respaldo de lo que pisa.

## Ver también

- [instalacion.md](instalacion.md)
- [kit.md](kit.md)
- [plataforma.md](plataforma.md)
