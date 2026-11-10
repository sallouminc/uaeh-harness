# La puerta visual

Esta página describe `/uaeh-harness:uae-visual`, la puerta que audita la interfaz de un sitio o una app: abre las pantallas en un navegador real, mide accesibilidad y desborde, y deja una lista corta de hallazgos para que el responsable decida. Cubre cuándo se usa, qué hace cada pieza, cómo preparar un proyecto y cómo probar la puerta en la propia máquina.

## Cuándo se usa

La puerta es **bajo pedido**: entra solo cuando se solicita una auditoría visual o de accesibilidad (por ejemplo, «pásale el verificador») o antes de lanzar un sitio público nuevo. No se dispara sola por hacer trabajo visual. El trabajo del día a día se hace directo en la conversación, con el `DESIGN.md` del proyecto, una revisión de desborde a 360 px y una captura que el responsable aprueba.

Cuando la puerta entra, corre **una sola ronda**: chequeos deterministas, luego `browser-verifier` y luego `design-auditor`. Los hallazgos se presentan como lista; nunca abren ciclos por su cuenta. Si la pantalla toca login, datos personales, pagos o salud, la puerta se combina con `/uaeh-harness:uae-security`: la aprobación visual no sustituye a la de seguridad.

## Las dos piezas

| Pieza | Qué hace | Qué no puede hacer |
|---|---|---|
| `browser-verifier` | Abre las pantallas cambiadas en 360 y 1440 px, recoge snapshot, consola, red y capturas en `reports/visual-audit/<AAAAMMDD-HHMM>/`, y corre las pruebas visuales deterministas. | Editar código, pruebas o baselines. Navegar fuera de `localhost`, `127.0.0.1` o `[::1]`. |
| `design-auditor` | Juzga en solo lectura las capturas y el YAML del verificador contra el `DESIGN.md`, el brief, las guías de interfaz de Vercel fijadas en el plugin y WCAG. Separa lo verificable del gusto. | Escribir, ejecutar comandos o aprobar seguridad y marca. |

Los dos agentes no ven la conversación que construyó el cambio: quien construye no se audita a sí mismo.

### Candados

- `browser-verifier` trabaja bajo dos candados del plugin: el de solo lectura y una lista blanca de navegador (`hooks/solo-navegador.js`). La lista blanca solo admite `playwright-cli` con una sesión propia `uaeh-…` y subcomandos que no interactúan con la página, `npx --no-install playwright test`, Lighthouse fijado, `git` de lectura y una petición de cabecera con `curl` a una URL local. Solo usa Bash; PowerShell está desactivado.
- `design-auditor` solo tiene las herramientas `Read`, `Grep` y `Glob`.
- Mientras corren, el sello de integridad vigila el repo: si algo cambia durante la revisión, el sello queda `ROTA` y el resultado es `UNKNOWN`, nunca PASS.
- Los candados de texto son de mejor esfuerzo; la garantía real es el sello, que mide el resultado y no el comando.

## Estados y hallazgos

| Estado | Significa |
|---|---|
| `PASS` | Todos los chequeos aplicables se ejecutaron y aprobaron, con evidencia. |
| `FAIL` | Incumplimiento demostrado (axe, desborde, fuente, consola o red, diferencia de píxeles, hallazgo con evidencia). |
| `BLOCKED` | El entorno impide verificar: la app no arranca, falta la herramienta o el navegador no abre. Nunca se convierte en PASS. |
| `NOT_CHECKED` | El control no se pudo comprobar: falta la baseline aprobada o el proyecto no tiene `@playwright/test` ni axe. |

Hacia `/uaeh-harness:uae-loop`, un `BLOCKED` o `NOT_CHECKED` en un chequeo exigido cuenta como `UNKNOWN`. Un cambio de marca o identidad queda en `PENDING_HUMAN_REVIEW` hasta que el responsable lo apruebe, una captura a la vez.

Los hallazgos del auditor llevan identificador `VIS-NNN` (los del verificador, `NAV-NNN`) y una gravedad: **crítico** y **alto** bloquean publicar; **medio** lo decide el dueño; **bajo** va al backlog. Lo que es solo gusto va a `notas_de_gusto` y nunca bloquea. El formato completo de ambos YAML está en `plugins/uaeh-harness/skills/uae-visual/referencias/estados-y-formato.md`.

## Qué mide el chequeo determinista

Las plantillas de Playwright y axe revisan, por cada pantalla crítica: consola y red, desborde horizontal a 360 px, fuente principal (nunca Inter, Arial ni Roboto), accesibilidad WCAG 2.1 AA y captura contra una baseline aprobada. Lighthouse es informativo y solo se corre en páginas públicas, salvo CLS mayor a 0.25, que cuenta como hallazgo alto. Una baseline nueva o cambiada se crea solo con el OK del responsable, una por una.

## Preparar un proyecto

```
node "<plugin>/scripts/instalar.cjs" visual --proyecto <carpeta del proyecto>
```

En seco por defecto: solo muestra qué haría. Con `--aplicar` copia `playwright.visual.config.ts` y `tests/visual/visual.spec.ts`, crea un `DESIGN.md` desde la plantilla si falta y agrega las exclusiones de evidencia (las mismas de `uaeh-ignorar.cjs`). **Nunca pisa un archivo existente del proyecto**: si difiere de la plantilla, lo avisa. Con `--local` las exclusiones van al `.git/info/exclude` del clon, útil en repos ajenos.

Las dependencias del proyecto se instalan aparte y con el visto bueno del responsable: `npm i -D @playwright/test@1.63.0 @axe-core/playwright@4.13.0` y `npx playwright install chromium`. Sin ellas el resultado es `NOT_CHECKED`.

### La plantilla de DESIGN.md

El `DESIGN.md` es la fuente de verdad visual del producto. La plantilla (`referencias/plantilla-DESIGN.md`) trae un encabezado con claves simples. Las pruebas leen solo `fuente_display`, `fuente_texto` y `pantallas_criticas`; el resto (`producto`, `version`, `estilo`, `movimiento`, `viewports`, `aprobado_por`, `aprobado_el`) documenta la decisión, y los anchos reales (360 y 1440) están fijados en `playwright.visual.config.ts`. Trae además ocho secciones: fuentes de verdad, identidad, tokens, componentes, responsive y accesibilidad, movimiento, criterios de aceptación y gobierno. Consolida sin copiar: indexa las guías de marca existentes. El modo de movimiento es `con-proposito`, `constante-premium` o `por-seccion`; si no está fijado, la puerta pregunta una vez. Un `DESIGN.md` nuevo queda en `PENDING_HUMAN_REVIEW` hasta su aprobación.

## El catálogo visual propio

La puerta trae un catálogo genérico que dice qué **tipo** de skill usar en cada ruta (landing, UI de producto, rediseño, auditoría, movimiento 3D, video). Cada usuario puede tener el suyo, con los nombres de sus skills instaladas.

| Qué | Cómo |
|---|---|
| Ver cuál está vigente | `node "<plugin>/scripts/uaeh-config.cjs" catalogo-visual` imprime la ruta: `visual.catalogo` si está fijada; si no, `catalogo-visual.md` en `UAEH_HOME` si existe; si no, el genérico del plugin. |
| Generar un borrador | `node "<plugin>/scripts/instalar.cjs" visual --registrar-skills` (en seco; con `--aplicar` lo escribe). Propone un rol para cada skill por su nombre y descripción: es un punto de partida que se revisa. `--reemplazar` sobrescribe un catálogo existente. |
| Comprobarlo | `node "<plugin>/skills/uae-visual/scripts/comprobar-catalogo.cjs"` confirma que cada skill local del índice existe y que el silenciado coincide. Salida 0 sin errores, 1 con errores, 2 uso incorrecto. |

La clave `visual.catalogo` debe ser una ruta absoluta; una ruta relativa o con `~` se ignora con un aviso.

## Autoprueba de la puerta

La autoprueba ejercita las plantillas reales contra un sitio de juguete malo y uno bueno. Comprueba que el malo se detecte y el bueno se apruebe. Es un paso **local**: el CI no la corre porque no descarga Chromium.

```
node "<plugin>/skills/uae-visual/pruebas/probar-visual.cjs" --instalar
```

| Bandera | Efecto |
|---|---|
| `--instalar` | Si faltan, instala las dependencias de `pruebas/package.json` en `UAEH_HOME/cache/visual-fixture` con `npm ci --ignore-scripts`, y descarga el Chromium de Playwright. |
| `--modulos <carpeta>` | Usa esa carpeta `node_modules` (ya instalada, mismas versiones). Con `--instalar` solo se instala el navegador si falta. |
| `--sin-lighthouse` | Omite Lighthouse, que necesita red la primera vez. |
| `--conservar` | No borra la copia temporal, para mirar la evidencia. |

| Salida | Significa |
|---|---|
| 0 | Todos los controles pasaron. |
| 1 | Algún control falló. |
| 2 | Uso incorrecto. |
| 3 | Sin dependencias o sin navegador. |

**La salida 3 (`SIN DEPENDENCIAS` o `SIN NAVEGADOR`) significa que no se probó nada**: es `UNKNOWN`, nunca un éxito. Hace falta el Chromium exacto de la versión de Playwright fijada; si falta, volver a correr con `--instalar`. La autoprueba nunca escribe en la carpeta del plugin: trabaja en una copia temporal con su propio repo git.

`/uaeh-harness:doctor` revisa la puerta visual (Node, `playwright-cli`, Chrome, configuración global, candado del navegador, guías fijadas, catálogo y autoprueba); con `--vivo` corre la autoprueba con un navegador real. Ver [diagnostico.md](diagnostico.md).

## Plataforma y límites

Probada solo en Windows 11 (navegador real, Lighthouse incluido). En Linux y macOS no está probada. Los candados de texto son de mejor esfuerzo. La puerta no juzga el gusto: lo verificable lleva gravedad; lo demás es nota.

## Ver también

- [seguridad.md](seguridad.md) — la puerta que acompaña a la visual cuando hay login, datos o pagos.
- [preflight.md](preflight.md) — pide una auditoría visual incremental dentro del preflight.
- [configuracion.md](configuracion.md) — clave `visual.catalogo`.
- [diagnostico.md](diagnostico.md) — doctor de puertas y solución de problemas.
- [plataforma.md](plataforma.md) — sistemas probados.
