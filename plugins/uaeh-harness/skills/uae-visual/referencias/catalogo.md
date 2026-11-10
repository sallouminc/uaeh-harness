# Catálogo de la puerta visual — UNA skill de ejecución por ruta

Este es el catálogo **genérico**: dice qué **tipo** de skill usar en cada ruta (por rol), no qué skills tienes instaladas. Si existe tu catálogo propio, ese manda: `<catálogo>` de SKILL.md devuelve la ruta del vigente (el tuyo vive en la carpeta de estado de UAEH como `catalogo-visual.md`, o donde diga `visual.catalogo` en `uaeh.config.json`). Para crearlo a partir de las skills que tienes instaladas, ver «Cómo registrar tu catálogo» al final.

**Regla:** se carga **una** skill de ejecución por ruta, más las de apoyo que la ruta pida. No se apilan presets.

## Reglas que ganan siempre (orden de precedencia)
1. **Formato explícito del usuario:** si pidió un formato, ese gana.
2. **`DESIGN.md` del producto:** manda en tokens, tipografía, estilo y movimiento. La fuente que sugiera un preset es una opción, no una regla. Prohibidas como fuente principal Inter, Arial y Roboto (las pruebas visuales lo comprueban); los respaldos del sistema no cuentan.
3. **Assets del dueño tal cual:** logo, fotos y modelos 3D se usan sin redibujar ni «mejorar».
4. **UX primero:** flujos, arquitectura de información y estados antes de pintar pantallas nuevas.
5. **Con o sin estado:** una página estática se construye con la skill de diseño frontend; algo con estado (una app, un artefacto interactivo) con la de construcción de artefactos o la del framework del proyecto.
6. **Verificación siempre al final:** primero los chequeos deterministas, luego `browser-verifier` y `design-auditor`. Quien construyó no se aprueba.

## Movimiento: dos modos, siempre habilitados (sin modo por defecto)
El modo sale del `DESIGN.md` (`movimiento: con-proposito | constante-premium | por-seccion`) o del pedido. Si no está definido, la skill pregunta UNA vez y lo anota. Con `por-seccion`, el `DESIGN.md` dice qué sección usa cada modo.

| Modo | Para qué | Qué tipo de skill |
|---|---|---|
| `con-proposito` | El movimiento explica algo: entrada, cambio de estado, jerarquía o continuidad. | Una de principios de movimiento (curvas, duración, propósito) y otra para construir la animación de interfaz; para gestos, arrastre y resortes, una de interacción física. |
| `constante-premium` | Micro-animaciones perpetuas que dan vida y lujo a la pieza. | La capa de movimiento del preset de estilo del `DESIGN.md`. |
| Ambos | Técnica | La librería que use el proyecto (GSAP, Lottie, Motion…) con su skill, si la tienes. |

Los dos modos respetan siempre `prefers-reduced-motion` (accesibilidad, no negociable).

## Rutas

| Ruta | Método | Skill de ejecución (una) | Apoyo | Chequeos exigidos |
|---|---|---|---|---|
| `create-public-ui` (landing, sitio, página pública nueva) | Referencias y concepto maestro (SKILL.md §2). Las decisiones creativas son del responsable. | El preset de `estilo` del `DESIGN.md` (una skill de dirección visual). Sin `DESIGN.md`: la de diseño frontend general (por ejemplo `frontend-design`). | UX, imágenes de referencia, el modo de movimiento | Deterministas (5) · navegador 360 y 1440 · `design-auditor` en **opus** · Lighthouse informativo |
| `product-ui` (pantallas de una app o panel) | — | El `estilo` del `DESIGN.md`; por defecto, un preset minimalista de producto. Si el producto tiene su propia skill de frontend (su framework y sus componentes), esa. | UX | Deterministas · navegador · `design-auditor` sonnet |
| `redesign-existing` | Referencias y concepto maestro si cambia la identidad. | Una skill de rediseño de proyectos existentes. | Antes/después: mismas pantallas y viewports en el commit base y en el cambio | Deterministas + diferencia contra la baseline aprobada · `design-auditor` en opus si cambia la marca · Lighthouse si la página es pública |
| `reference-to-code` (igualar una captura o un sitio) | Extraer principios, no copiar marca ajena. | Extracción de ADN visual (perfil de la referencia) **y luego** imagen a código. | Imágenes de referencia | Deterministas · comparación lado a lado en el navegador |
| `audit-only` (revisar sin tocar código) | — | Las guías de interfaz fijadas del plugin (las aplica `design-auditor`). | `browser-verifier` + `design-auditor` · una revisión de accesibilidad o una crítica de diseño como segunda lectura, si las tienes | No modifica código. Hallazgos al `AUDIT_REPORT.md`. |
| `motion-3d` | Honestidad 3D: no replicar renders offline; el techo realista del medio. | Movimiento: el modo de la tabla de arriba. 3D: una skill de entrada de three.js y sus específicas (geometría, materiales, luces, cargadores GLTF, shaders, posproceso, interacción). | Asset 3D real (`.blend`/GLB) del dueño | Deterministas con `animations: disabled` · navegador con `set-reduced-motion reduce` · Lighthouse (TBT) informativo |
| `video` | Ley de movimiento primero. | Un framework de video por composición (HTML o React) y sus skills. | Subtítulos, medios, uniones entre tomas | Sin Playwright ni axe. **Se aprueba viéndolo reproducirse**, solo lo nuevo. |

## Imágenes, marca y piezas sueltas (dentro de cualquier ruta)
Las skills oficiales de Anthropic cubren varias, si las tienes: `canvas-design` (póster o pieza estática), `algorithmic-art` (arte generativo con p5.js), `theme-factory` (tema para documentos o artefactos), `slack-gif-creator` (GIF animado) y `brand-guidelines` (solo para la marca de Anthropic). Para un sistema de marca o mockups de referencia antes de construir, usa la que tengas registrada.

## QA funcional (no visual)
`webapp-testing` (oficial de Anthropic): scripts de Playwright para flujos locales. La verificación visual de esta puerta es `browser-verifier` con `playwright-cli` más las plantillas de `@playwright/test`.

## Skills que solo invoca el usuario
Las que llevan `disable-model-invocation: true` en su frontmatter: se le sugieren al usuario; Claude no puede invocarlas. En el índice van con anuncio `manual`.

## Cómo registrar tu catálogo
1. **Borrador:** el subcomando `visual --registrar-skills` del instalador del plugin (en seco; con `--aplicar` lo escribe) recorre tus skills, propone un rol para cada una por su nombre y su descripción, y deja el índice de abajo con tus nombres. Lo revisas y lo corriges: el rol que propone es un punto de partida.
2. **Comprobación:** `comprobar-catalogo.cjs` (en `scripts/` de esta skill) confirma que cada skill local del índice existe, que `manual` lleva `disable-model-invocation: true` y, si silencias skills con `skillOverrides` en `settings.json`, que el silenciado y el índice dicen lo mismo.

**Formato del índice** (bloque de código bajo «## Índice de skills»; `#` abre un comentario):
- una skill por línea: `nombre | origen | anuncio`, con origen `local` (en tu carpeta de skills), `plugin` o `sistema`, y anuncio `on` (se anuncia en cada sesión), `name-only` (silenciada: se invoca por nombre) o `manual`;
- directivas opcionales, una por línea: `familias-on = a, b` (skills de entrada que deben quedar siempre anunciadas) · `silenciado = completo` (toda skill en `name-only` de `settings.json` debe estar en el índice) · `ajenas = x, y` (silenciadas a propósito que no son visuales; la comprobación las salta).

## Índice de skills

```text
# la puerta visual de este plugin
uaeh-harness:uae-visual | plugin | on
```
