<!-- UAEH:BEGIN v{{VERSION}} -->
## Método UAEH — eficiencia de tokens y cabina limpia (capa 1)
Medido por el autor del método: ~99 % del gasto es RELEER contexto, no escribir. Estas reglas atacan eso. Son informativas: nada aquí bloquea.

### Cabina limpia
- La conversación principal decide. Lo que mete MUCHO texto y no hace falta ver crudo va a un subagente que devuelve solo la conclusión: explorar o buscar en muchos archivos (agente Explore), investigar, auditar, construir 2+ archivos independientes (en paralelo, con el modelo económico que fija la configuración).
- Una tarea por subagente, con contexto real y entregable claro. Nunca bifurcar (`fork`) una conversación larga.

### Qué leer
- Cada proyecto tiene `tasks/context-map.md` (qué leer, qué NO, comandos, trampas). Se inyecta al arrancar: léelo en vez de explorar a ciegas. Si falta, créalo con `/uaeh-kit:setup proyecto`.
- Leer por rangos; lecturas masivas → subagente.

### Juntar pasos
- Antes de cada llamada: ¿qué más voy a necesitar que NO depende de este resultado? Va en el MISMO mensaje (llamadas en paralelo) o en UN solo comando que imprima un resumen corto, no volcados.
- El mismo cambio en 3+ archivos → un script que corre una vez; se revisa con `git diff --stat` y una muestra del diff.
- Revisiones que se repiten → script guardado en el repo. Esperas largas en segundo plano con aviso al terminar, nunca sondeo turno por turno.
- Depurar (lo que depende del resultado anterior) sí va paso a paso: no se fuerza.

### Contexto chico
- 1 sesión = 1 bloque de trabajo. El vigía avisa al 80 % del tope de compactación: terminar la tarea, auto-guardar y abrir sesión nueva. No abrir trabajo grande nuevo en una sesión que ya avisó.
- CLAUDE.md de proyecto ≤ 40,000 caracteres: reglas, trampas vigentes, comandos y estado actual. La crónica fechada vive en `tasks/bitacora.md` (lo más nuevo arriba). Para adelgazarlo sin perder una línea: `/uaeh-kit:dieta`.
- Medir, no suponer: `/uaeh-kit:medir` (tokens releídos, pasos sueltos, agentes y skills usados).

### Al cerrar un bloque (auto-guardado)
1. CLAUDE.md del proyecto: REEMPLAZAR la sección de estado actual (nunca acumular crónica); el detalle va arriba en `tasks/bitacora.md`.
2. `tasks/todo.md`: marcar lo hecho, anotar pendientes.
3. `tasks/lessons.md`: una lección por cada corrección o error que costó tiempo (problema → causa raíz → cómo evitarlo). Un error corregido dos veces = falta una guarda (prueba, validación, regla).

### Al compactar
El resumen CONSERVA: la tarea en curso y su objetivo · decisiones y aprobaciones del usuario, textuales · archivos tocados y por qué · pendientes · comandos de verificación con su resultado (PASS / FAIL / sin prueba) · trampas descubiertas · proyecto y rama. DESCARTA: salidas crudas de herramientas, contenido de archivos leídos (dejar solo `ruta:línea`), capturas, intentos fallidos ya resueltos (una línea con la lección).

### Verificar antes de declarar terminado
Demostrado en el entorno real, abriendo el artefacto como lo abrirá el usuario, no solo pruebas verdes. Sin pruebas ejecutadas se dice «sin pruebas», nunca «funciona».
<!-- UAEH:END -->
