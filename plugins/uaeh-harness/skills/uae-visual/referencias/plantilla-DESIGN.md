---
# Frontmatter que leen las pruebas visuales (plantillas/visual.spec.ts). Claves simples, una por línea.
producto: "<NOMBRE DEL PRODUCTO>"
version: "1.0"
fuente_display: "<familia exacta de títulos, p. ej. Archivo>"
fuente_texto: "<familia exacta del cuerpo>"
estilo: "<design-taste-frontend | high-end-visual-design | minimalist-ui | industrial-brutalist-ui | stitch-design-taste | gpt-taste>"
movimiento: "<con-proposito | constante-premium | por-seccion>"
viewports:
  - 360x800
  - 1440x900
pantallas_criticas:
  - /
aprobado_por: "<RESPONSABLE DE LA MARCA>"
aprobado_el: "<AAAA-MM-DD>"
---

# DESIGN.md — <NOMBRE DEL PRODUCTO>

> Fuente de verdad visual del producto. **Consolida sin copiar:** los valores viven en las guías de abajo y aquí solo se indexan o se resumen. Si el `DESIGN.md` y una guía se contradicen, se resuelve con el responsable de la marca y se corrige el que esté mal. Nunca se deja la contradicción.

## 0. Fuentes de verdad (no se copian)
| Qué | Archivo | Versión o fecha |
|---|---|---|
| Guía de marca | `<ruta a marca/ o brand/>` | |
| Tokens (colores, tipografía, espaciado) | `<ruta a tokens.css / .json / tailwind.config>` | |
| Logos y assets del dueño (se usan tal cual) | `<ruta>` | |

## 1. Identidad
- Propósito y público:
- Rasgos de marca (3-5 adjetivos):
- Referencias permitidas (qué principio se toma de cada una):
- Referencias prohibidas o que no se imitan:

## 2. Tokens
- Colores: primary, accent, bg, surface, border, text, muted, danger, success (valor y token o archivo de origen).
- Tipografía: display, body y mono, con pesos y escala. **Nunca Inter, Arial ni Roboto como fuente principal.**
- Espaciado, bordes y radios, sombras, iconografía.

## 3. Componentes
- Botones: estados default, hover, focus visible, disabled y loading.
- Inputs, cards, modales, navegación, tablas, gráficas, notificaciones.
- Patrones prohibidos en este producto:

## 4. Responsive y accesibilidad
- Viewports y breakpoints (los del frontmatter, más los que el producto exija).
- Contraste mínimo WCAG AA (4.5:1 en texto y 3:1 en texto grande y en componentes).
- Foco visible, tamaños táctiles de 44×44 px o más, `lang` del documento.
- `prefers-reduced-motion`: qué se apaga o se simplifica.

## 5. Movimiento
- Modo: `<con-proposito | constante-premium | por-seccion>`. Con `por-seccion`, la tabla de qué sección usa cada modo.
- Qué se anima, con qué duración, curva y propósito.
- Alternativa con reduced-motion (obligatoria en los dos modos).

## 6. Criterios de aceptación
- Pantallas y flujos críticos (los del frontmatter).
- Estados obligatorios: loading, empty, error y success.
- **Baselines:** viven en `tests/visual/**/*-snapshots/` y van al repo. Se crean o actualizan **solo** tras el OK del responsable viendo la captura, una por una, con `npx playwright test <prueba> --update-snapshots`. Nunca automáticamente.
- Exclusiones (lo que no se verifica y por qué):

## 7. Gobierno
- Responsable de la marca: `<nombre>`. Aprobado el: `<fecha>`. Versión: `<x.y>`.
- Cómo proponer cambios: un cambio de identidad o marca se muestra al responsable **una captura a la vez**. El PASS del auditor no reemplaza su aprobación.
- Historial:

| Fecha | Versión | Cambio | Aprobó |
|---|---|---|---|
