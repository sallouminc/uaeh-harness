<!-- UAEH:BEGIN v{{VERSION}} -->
## UAEH — modalidad de trabajo para Codex (arnés de verificación, capa 2)
Las mismas reglas que Claude Code. Si algo difiere, mandan las reglas del método UAEH que carga Claude Code.
Motivo (medido por el autor): el 71 % del tiempo se iba en esperar agentes que releían el repo; por eso construye quien ya
tiene el contexto y se revisa una sola vez.

### ¿Entra al protocolo? Lo decides tú, en línea, sin agentes
- **Lista blanca** (basta una): dinero (comisiones, cobros, suscripciones, pagos, precios que se cobran) · cuentas (login,
  sesiones, contraseñas, permisos, roles, tokens) · base de datos (esquema, migraciones, RLS, borrados masivos) ·
  publicar a producción algo con datos reales de personas o dinero. La lista vigente es la de `listaBlanca` en
  `uaeh.config.json`; estas cuatro categorías son las de fábrica.
- **Todo lo demás va DIRECTO** (visual, UI, textos, scripts, landings, sitios de clientes, bugs normales): cambio mínimo,
  pruebas del área tocada, relee el diff y muéstralo. Sin triage, sin builder, sin verificador, sin sello.
  Con duda → directo, y anota el supuesto.
- `uae_triage` solo si no puedes saber qué toca la tarea sin leer medio repo. `uae_architect` solo en `critical`
  (mueve dinero real, borra datos, toca datos de salud o es una migración destructiva).

### Dentro de la lista blanca
1. Anota `git status --short`, rama, commit base y hora de inicio. Meta ≤ 30 min; a los 60 min para y pide decisión.
2. Construyes tú, con al menos una prueba del comportamiento nuevo. `uae_builder` solo si hay 2+ piezas independientes
   en paralelo, el cambio pasa de ~300 líneas o es `critical`. Quien construye nunca se aprueba.
3. Commit de trabajo y UNA revisión: `uae_verifier` (y `uae_security` si toca dinero o cuentas), en paralelo, con mapa de
   lectura (comando del diff, ≤ 5 archivos de contexto, comandos de las pruebas del área, criterios) y tope de 15 min.
4. Sello solo alrededor de esa revisión: `node "{{UAEH_ESTABLE}}/scripts/uaeh-integridad.cjs" foto <repo>` → id; al
   terminar, `node "{{UAEH_ESTABLE}}/scripts/uaeh-integridad.cjs" comparar <id> <repo>`: INTACTO obligatorio; ROTA anula
   y se repite UNA vez; DESCONOCIDO = UNKNOWN. Nunca cambies HOME, XDG_CONFIG_HOME ni GIT_CONFIG_* para medir. Si te
   lanzan como revisor, no tomes ni compares el sello.
5. Pruebas: solo las del área. La batería completa del proyecto corre únicamente antes de publicar.
6. Si falla, NO hay bucle: reporta el hallazgo exacto (qué, dónde, qué prueba lo demuestra) con una recomendación, y
   el usuario decide. Si decide arreglar, se re-verifica solo el criterio que falló. Regresión → preserva el trabajo
   (nunca reset). Hallazgos fuera de lo pedido → lista en `tasks/todo.md`; nunca abren ciclos, versiones ni tareas solos.
7. **Registro OBLIGATORIO en cuanto llegan los veredictos**, con el estado de ese momento aunque sea
   PENDING_HUMAN_REVIEW, una línea por tarea:
   ```
   node "{{UAEH_ESTABLE}}/scripts/uaeh-registro.cjs" --proyecto <carpeta> --ruta <build|deep> --riesgo <alto|critico> --ciclos <n> --minutos <desde la hora de inicio> --escalamiento "<detalle>" --estado <ESTADO> --tarea "<resumen>"
   ```
   Sin esa línea la tarea NO está cerrada. Sello de un revisor en ROTA o sin foto del orquestador = veredicto UNKNOWN,
   nunca PASS. «Precios que se cobran» incluye app, servidor, landing, panel y tiendas; «publicar a producción con datos
   reales» (un push a la rama que despliega o un script de despliegue al servidor) se revisa ANTES del push.

### Relevo desde Claude Code (cuando a Claude se le acaba el límite)
- Trabaja en la MISMA carpeta y rama. No crees worktree ni copia del repo para relevar.
- Antes de editar: confirma que ninguna sesión de Claude sigue escribiendo ahí; lee la sección de estado del `CLAUDE.md`
  del proyecto, `tasks/todo.md` y `tasks/context-map.md`; corre `git status --short` y `git log --oneline -5`.
- No repitas lo ya hecho ni re-verifiques todo: solo el área que tocas. Cambiar de motor no baja el riesgo de la tarea.
- Al cerrar: actualiza el estado del `CLAUDE.md` del proyecto y `tasks/todo.md` (igual que Claude) y haz commit.
- Worktree solo si Claude y tú escriben en el mismo repo AL MISMO TIEMPO (trampas de Windows en la referencia
  `concurrencia.md` de la skill `uae-loop` de Claude Code). Va en `<carpeta-de-copias>/<proyecto>-<tarea>`, fuera del repo
  y fuera del escritorio; quien la crea la quita al cerrar la tarea (`git worktree remove`, sin `--force`).

### Siempre
- Estado final con evidencia (comando, código de salida, número de pruebas): PASS_TECHNICAL · PASS_RELEASE_READY ·
  PENDING_HUMAN_REVIEW · BLOCKED_SECURITY · FAIL · UNKNOWN. 0 pruebas o comando ausente = UNKNOWN, nunca PASS.
- Prohibido: editar pruebas para ocultar fallas, push, deploy, operar producción, reset --hard, push --force,
  --no-verify, commitear secretos. Los commits siguen la política de commits del usuario (`commits.credito` y
  `commits.firma` en `uaeh.config.json`).
- **Juntar pasos:** cada paso relee toda la conversación. Lo que no depende del resultado anterior va en un solo comando
  o script que imprima un resumen corto, no volcados. El mismo cambio en 3+ archivos = un script que corre una vez y se
  revisa con `git diff --stat` (respetando CRLF y UTF-8). Una revisión que se repite se guarda como script en el repo.
  Depurar, que depende del resultado anterior, sigue paso a paso.
- Web: la sesión nunca en localStorage; la autorización se valida en el servidor.
- Responde en español y en lenguaje simple: qué hiciste, evidencia, límites y estado final.
<!-- UAEH:END -->
