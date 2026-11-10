# Mapa de contexto — {NOMBRE DEL PROYECTO}

> Este archivo se inyecta automáticamente al arrancar una sesión en este proyecto (hook del kit UAEH).
> Objetivo: que el agente sepa QUÉ LEER y QUÉ NO, sin redescubrirlo cada vez. Corto y al día.

## Qué es y estado actual
{1 párrafo: qué hace el producto, para quién, en qué etapa está hoy.}

## Stack y cómo correrlo
- **Stack:** {lenguaje / framework / base de datos / hosting}
- **Correr local:** `{comando}`
- **Probar / verificar:** `{comando de pruebas o de QA}`
- **Publicar:** `{cómo se publica y quién lo autoriza}`

## Archivos que importan (leer estos primero)
- `{ruta/archivo}` — {qué hace}
- `{ruta/archivo}` — {qué hace}
- `{ruta/carpeta/}` — {qué contiene}
- *(5-10 máximo: los puntos de entrada y la lógica central)*

## NO leer (zonas ruidosas)
- `node_modules/`, `dist/`, `build/`, `.next/`, `vendor/`, generados, binarios, `*.lock`
- {cualquier carpeta grande que no aporte}

## Trampas conocidas
- {cosas que ya rompieron antes y cómo evitarlas}

## Credenciales: dónde viven (SIN valores aquí)
- {p. ej. «token de X en las variables de entorno del hosting»; nunca pegar el valor}

## Historial
- `tasks/bitacora.md`: crónica fechada (lo más nuevo arriba). Leer solo cuando haga falta buscar algo pasado.
