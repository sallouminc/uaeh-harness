# Dieta de un CLAUDE.md de proyecto — instrucciones de trabajo

## Por qué
El CLAUDE.md de un proyecto se relee completo en CADA turno de CADA sesión y de CADA subagente.
Medido por el autor del método: algunos pesaban 79K–277K tokens, casi todo bitácora de sesiones
pasadas. La regla del método: **CLAUDE.md = reglas, trampas vigentes, comandos y estado actual
(≤ 40,000 caracteres); la crónica fechada vive en `tasks/bitacora.md`** y se consulta solo cuando
hace falta.

## Regla de oro: NO SE PIERDE NI SE REESCRIBE NADA DEL ORIGINAL
- Toda línea del CLAUDE.md original tiene que terminar, **textual y completa**, en el CLAUDE.md nuevo
  o en `tasks/bitacora.md`. Se MUEVE, no se resume ni se parafrasea, no se corrige ortografía, no
  se cambian tildes. El verificador lo comprueba línea por línea.
- SÍ se permite AGREGAR texto nuevo en el CLAUDE.md nuevo (resúmenes, punteros, índices).
- Si dudas si algo es regla vigente o historia: déjalo en CLAUDE.md si cabe; si no cabe, muévelo
  a la bitácora y agrega en CLAUDE.md una línea nueva que lo resuma y diga la fecha para buscarlo.

## Qué se queda en CLAUDE.md (en este orden)
1. Qué es el proyecto (identidad, stack, dónde vive, URLs): breve.
2. **Reglas permanentes / inviolables / decisiones de negocio vigentes** (tal cual, textuales).
3. Cómo se trabaja: comandos (dev, pruebas, build), cómo se publica, ramas, política de commits,
   seguridad, qué NO hacer.
4. **Trampas vigentes** (gotchas que siguen aplicando hoy).
5. **Estado actual**: un bloque NUEVO de ≤ 40 líneas, escrito por ti, que resuma dónde va el
   proyecto según las entradas más recientes (qué está publicado, qué está en curso, qué espera de
   quién). Fechas absolutas.
6. Una línea: «Historial detallado por fecha: `tasks/bitacora.md` (buscar con Grep por fecha,
   número de incidencia o tema). Al cerrar un bloque se REEMPLAZA el Estado actual y el detalle se
   agrega ARRIBA en la bitácora.»

## Qué se va a `tasks/bitacora.md`
- Las secciones de crónica/historial fechadas («Estado al …», bloques de sesión, registros de fases
  ya cerradas, verificaciones de despliegues pasados, listas de commits), en el MISMO orden en que
  estaban (normalmente lo más nuevo arriba).
- Encabezado del archivo: `# Bitácora — <proyecto>` + una línea: «Movida desde CLAUDE.md el
  <fecha> (método de eficiencia de tokens). Textual. Lo más nuevo arriba.»
- Si `tasks/bitacora.md` ya existe, inserta lo movido sin borrar lo que ya tenía.

## Pasos
1. Lee el CLAUDE.md completo antes de decidir (por partes si es muy grande).
2. Escribe `tasks/bitacora.md` y el CLAUDE.md nuevo.
3. Si existe `tasks/context-map.md`, agrega una línea que mencione `tasks/bitacora.md` (qué es y
   cuándo leerla). No toques nada más de ese archivo.
4. Corre el verificador desde la carpeta del CLAUDE.md (el comando exacto está en el cuerpo de la
   skill `dieta`; si te dan una ruta `--original`, agrégala). Tiene que decir `RESULTADO: PASS`. Si
   dice FAIL, corrige y repite. Nunca edites el verificador.
5. Lee tu CLAUDE.md nuevo de corrido como si fueras una sesión nueva: ¿están todas las reglas
   duras y la forma de publicar? Si falta algo, agrégalo.
6. Git (solo si te lo indican): `git add` SOLO de `CLAUDE.md`, `tasks/bitacora.md` y
   `tasks/context-map.md` (si lo tocaste). Mensaje en español:
   `docs: CLAUDE.md a dieta — la bitácora pasa a tasks/bitacora.md`, más la firma que exija la
   política de commits del proyecto. NUNCA `push`. NUNCA `--no-verify`. NUNCA `git add -A`.
   Antes de commitear, `git status --short` y confirma que solo van esos archivos.
7. No toques ningún otro archivo del proyecto.

## Reporte final (corto)
- Tamaños: original → CLAUDE.md nuevo → bitácora (caracteres).
- Salida final del verificador (las líneas OK/FAIL/RESULTADO).
- Lista de las secciones que dejaste en CLAUDE.md (solo títulos).
- Hash del commit, si hubo.
- Cualquier duda de clasificación que convenga que el usuario revise.
