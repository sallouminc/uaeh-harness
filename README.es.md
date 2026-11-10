# UAEH — Universal Agentic Engineering Harness

**[Read in English → README.md](README.md)**

> **Estado: versión 1.0 en preparación.** Las tres capas están construidas y su autor las usa a diario. Antes de la 1.0 quedan las últimas comprobaciones de instalación y una revisión independiente del repositorio. Este documento describe lo que contiene el repositorio y la evidencia que lo respalda; la documentación completa está en [`docs/es/`](docs/es/README.md).

UAEH es un **método de trabajo para programar con agentes de IA** (Claude Code primero; Codex como segundo motor opcional), empaquetado como **plugins de Claude Code**. Nació de un problema concreto: una cuenta cuyo gasto se iba casi entero en *releer* contexto, y un proceso de revisión que podía reportar «listo» sin prueba.

Tiene tres capas. De la primera sale el ahorro medido. Las otras dos compran control, no ahorro.

| Capa | Plugin | Qué es | Requiere |
|---|---|---|---|
| **1. Método + kit de eficiencia de tokens** | `uaeh-kit` | Las reglas del método, un vigía de la ventana de contexto, un mapa de contexto por proyecto, una «dieta» de CLAUDE.md con verificador, scripts de medición, una barra de estado con el contexto consumido y un bloque de reglas para pegar en tu CLAUDE.md. Solo informa: nunca bloquea nada. | Node ≥ 20 |
| **2. Arnés de verificación** | `uaeh-harness` | Un circuito acotado por lista blanca donde *quien construye nunca verifica*: agentes verificador y revisor de seguridad independientes, candado de solo lectura para los revisores, sello de integridad (foto del repo y del arnés antes y después de cada revisor), registro de tareas, guardia de cierre y guarda de git en dos capas. Seis estados finales; **UNKNOWN nunca es PASS**. | Node ≥ 20, Git ≥ 2.31 (Codex opcional) |
| **3. Puertas** | `uaeh-harness` | Puerta de seguridad (gitleaks, semgrep, osv-scanner, un auditor Codex de solo lectura de otra familia de modelos, prueba de concepto en una caja de arena Docker sin red), puerta visual (Playwright, axe, un verificador en navegador y un auditor de diseño) y un preflight que escribe los documentos de lanzamiento y los sella con vigencia. | Windows 11 + WSL2, Docker, Python, Playwright, Chrome; Codex opcional |

## Las reglas, en una pantalla

- **Directo por defecto.** Solo cuatro tipos de cambio entran al circuito pesado: dinero, cuentas, base de datos y publicaciones a producción que tocan datos reales de personas. Todo lo demás se hace directo y se muestra a la persona.
- **Quien construye nunca verifica.** La conversación principal construye; un verificador independiente y, en dinero o cuentas, un revisor de seguridad independiente juzgan. Los dos corren en paralelo, una sola vez, con tope de 15 minutos. Sin bucles: un fallo vuelve a la persona.
- **UNKNOWN ≠ PASS.** Sin pruebas ejecutadas, con el sello roto o sin foto, el resultado es UNKNOWN, nunca éxito.
- **Segunda opinión de otra familia de modelos** en seguridad, en solo lectura y a ciegas de las conclusiones del primer revisor.
- **Cabina limpia.** Todo lo que mete mucho texto a la conversación principal y no hace falta en crudo va a un subagente que devuelve solo su conclusión. Los subagentes usan por defecto un modelo más barato.
- **Juntar pasos.** Las llamadas independientes van en un mismo mensaje o en un solo comando; un cambio repetido en muchos archivos es un script, no una cadena de ediciones. Depurar se queda paso a paso.
- **Los hallazgos fuera de lo pedido** van a una lista para la persona. Nunca abren ciclos, versiones ni tareas por sí solos.
- **Verificación proporcional.** Un filtro de texto de mejor esfuerzo no recibe rigor máximo; hay un presupuesto de tiempo por fase; las premisas se miden antes de construir sobre ellas.

## Evidencia (uso real del autor, reproducible con los scripts incluidos)

Medido sobre 1,213 transcripciones reales de una cuenta, comparando los diez días previos al método (5–14 oct 2026) con los quince posteriores (16–30 oct 2026):

| Métrica | Antes | Después | Cambio |
|---|---|---|---|
| Tokens releídos por día | 1,149 M | 505 M | **−56 % (2.3× menos)** |
| Releído por turno principal | 541K | 278K | −49 % |
| Turnos principales por día | 1,326 | 1,496 | +13 % |
| Tokens de salida por día | 1.57 M | 2.12 M | +35 % |

El arnés de verificación registró 60 tareas de lista blanca en el mismo periodo: 68 % PASS, mediana de 26 minutos, y el 57 % de las tareas posteriores al ajuste citan un hallazgo real atrapado por un revisor.

**Lo que no está medido, y lo decimos:** no hay A/B con tareas idénticas; no hay tasa de defectos escapados antes y después; el ahorro no se puede atribuir a cada componente por separado (el único experimento aislado: subir la ventana de compactación de 400K a 700K devolvió +73 % de consumo). Son las cifras de un autor, no una promesa.

## Instalación

```
/plugin marketplace add sallouminc/uaeh-harness
/plugin install uaeh-kit@uaeh
/plugin install uaeh-harness@uaeh
```

Requiere Claude Code 2.1.295 o posterior y Node 20 o posterior. Después, `/uaeh-kit:setup` y `/uaeh-harness:setup` guían el resto, siempre primero en seco (bloque de reglas, ajustes, barra de estado opcional, mapa de contexto por proyecto, guarda de git), y `/uaeh-kit:doctor` y `/uaeh-harness:doctor` dicen qué falta. Los hooks del plugin corren como scripts de `node` y no requieren Git Bash. El README de cada plugin lista cada hook con el comando exacto que ejecuta: [`plugins/uaeh-kit`](plugins/uaeh-kit/README.es.md) · [`plugins/uaeh-harness`](plugins/uaeh-harness/README.es.md).

**Tras instalar o actualizar, cerrar y volver a abrir todas las sesiones de Claude Code** (cada terminal y la aplicación de escritorio). Una sesión abierta antes no carga los hooks ni los agentes nuevos, y `/clear` no lo corrige.

Guía completa: [instalación](docs/es/instalacion.md) · [configuración](docs/es/configuracion.md) · [diagnóstico](docs/es/diagnostico.md) · [desinstalar](docs/es/desinstalar.md) · [privacidad](docs/es/privacidad.md).

## Plataforma

- **Windows 11 + WSL2 (Ubuntu 24.04):** es donde el autor lo usa a diario. Las pruebas unitarias corren además en la integración continua.
- **Linux (Ubuntu 24.04 x86_64):** probado en la integración continua de forma nativa: pruebas unitarias con Node 20 y 24, y la capa 3 de seguridad completa (instaladores, escáneres y caja de arena). Sin uso diario del autor.
- **macOS:** las capas 1–2 deberían funcionar, pero no están probadas; la capa 3 no está soportada en v1.
- La puerta visual se ha probado solo en Windows 11. Detalle por capa: [plataforma](docs/es/plataforma.md).

## Límites, con honestidad

- Cada hook que bloquea está listado en el README del plugin con el comando exacto que ejecuta; léelo antes de instalar. Un plugin corre con los privilegios de tu usuario.
- El candado de solo lectura de los revisores es de mejor esfuerzo; el sello de integridad es la garantía real.
- La puerta de seguridad envía una *copia limpia* de tu repositorio (sin archivos ignorados ni `.env`) a OpenAI cuando el auditor Codex está habilitado. Viene apagado y pide consentimiento.
- Los textos de los agentes y los mensajes de los hooks están en español en la primera versión; los contratos de máquina (claves JSON, estados) son estables y están documentados en los dos idiomas.

## Licencia y terceros

MIT © 2026 Salloum Inc. Los componentes de terceros incluidos conservan su licencia y se listan en `THIRD_PARTY_NOTICES.md`: `security-audit-skill` de Cloudflare (MIT), `cyber-neo` (MIT, con un parche pequeño que enmascara secretos en la evidencia) y las guías de interfaz web de Vercel Labs (MIT). Los escáneres, Docker, Playwright y Codex se instalan en tu máquina; nunca se redistribuyen.
