# Lista previa al lanzamiento (OWASP + STRIDE + filtro contra falsos positivos)

Referencia de `/uaeh-harness:uae-security`. La usan dos modos:

- **`lanzamiento`** (`lanzamiento.md`, condición 5): cada fase de abajo se revisa contra el código, con cita `archivo:línea`, antes de abrir al público un sistema con datos personales, salud o dinero.
- **Auditoría completa** (`quick` | `standard` | `deep`): el filtro de la segunda mitad es la fuente completa de `filtro-falsos-positivos.md`.

Es una revisión **manual y deliberada** que complementa a `/security-review` (la revisión automática rápida de un cambio) y a los escáneres de la pasada determinista; no los sustituye. Solo traza código: nunca lanza ataques reales ni hace peticiones a sistemas desplegados.

---

## Dos niveles de rigor

El nivel cambia solo el umbral de confianza para reportar:

- **Normal** (`quick`, `standard` y `lanzamiento`): cero ruido. **Compuerta de confianza 8/10.** Solo se reporta lo que con seguridad es real.
- **Exhaustivo** (`deep`): compuerta 2/10. Se filtra solo el ruido evidente (pruebas, documentación, ejemplos) y entra cualquier cosa que **pudiera** ser un problema, marcada `TENTATIVO` para distinguirla de lo confirmado.

---

## Las fases, en orden

### Fase 0 — Modelo mental y detección de tecnología
Antes de cazar fallos, entender la aplicación. Esto **cambia cómo se piensa** el resto de la auditoría.
- Detectar el stack (Node/TypeScript, Python, Ruby, Go, PHP, .NET…) y el framework (Next.js, Express, Django, Flask, Rails, Laravel…).
- Leer el README, los archivos de configuración y el código clave.
- Mapear la arquitectura: qué componentes hay, cómo se conectan, **dónde están las fronteras de confianza**.
- Trazar el flujo de datos: ¿por dónde **entra** lo que escribe el usuario?, ¿por dónde **sale**?, ¿qué transformaciones sufre?
- Es una fase de **razonamiento**, no una lista. El resultado es entendimiento, no hallazgos.
- **Regla suave, no dura:** la tecnología detectada define la PRIORIDAD del escaneo, no lo que se escanea. Se prioriza el lenguaje detectado, pero también se da una pasada de patrones de alto impacto (inyección SQL, inyección de comandos, secretos incrustados, SSRF) sobre TODOS los archivos, por si hay un servicio escondido en una subcarpeta.

### Fase 1 — Censo de la superficie de ataque
Mapear **lo que ve un atacante**, en el código y en la infraestructura. Se cuenta cada categoría:

**Superficie de código:**
- Endpoints públicos (sin autenticación)
- Endpoints autenticados (requieren sesión)
- Endpoints solo de administración (privilegios elevados)
- Endpoints de API (máquina a máquina)
- Puntos de subida de archivos
- Integraciones externas
- Trabajos en segundo plano (superficie asíncrona)
- Canales WebSocket

**Superficie de infraestructura:**
- Flujos de CI/CD
- Receptores de webhooks
- Configuraciones de contenedores (Docker)
- Configuración como código (Terraform, Kubernetes)
- Objetivos de despliegue
- Gestión de secretos (variables de entorno, KMS, vault, o desconocido)

> **La verdad incómoda:** la superficie de ataque real casi nunca es el código propio; son las **dependencias y el entorno**: variables de entorno expuestas en los registros de CI, llaves viejas en el historial de git, servidores de pruebas olvidados con acceso a la base de producción y webhooks de terceros que aceptan cualquier cosa. Se empieza ahí, no en el código.

### Fase 2 — Arqueología de secretos en el historial de git
El secreto peligroso no es solo el que está hoy en el código: es el que **quedó grabado en el historial**.
- Buscar en TODO el historial de git credenciales filtradas: prefijos conocidos de llaves reales (llaves de AWS tipo `AKIA`, tokens de GitHub `ghp_`/`gho_`/`github_pat_`, llaves tipo `sk-`/`sk_live_`, tokens de Slack `xoxb-`/`xoxp-`, bloques de llave privada en formato PEM) y palabras como `password`, `secret`, `token` o `api_key` en archivos `.env`, `.yml`, `.json` y `.conf`.
- Revisar si hay archivos `.env` **rastreados por git** (deberían estar en `.gitignore`). Confirmar que `.env` está ignorado.
- Revisar configuraciones de CI con secretos incrustados en texto plano (en vez de un almacén de secretos).
- **Gravedad:** CRÍTICO para un patrón de secreto activo en el historial. ALTO para un `.env` rastreado o un CI con credenciales en texto.
- **Regla contra falsos positivos:** los marcadores de posición (`your_`, `changeme`, `TODO`) se excluyen. Las fixtures de prueba se excluyen salvo que el mismo valor aparezca en código real. Un secreto **rotado sigue contando** (estuvo expuesto). Un secreto que se subió y se quitó en el MISMO commit inicial de preparación no cuenta.

### Fase 3 — Cadena de suministro de dependencias
Va más allá de un simple `npm audit`.
- Detectar el gestor de paquetes (npm/yarn/pnpm, pip, bundler, cargo, go…).
- Correr la herramienta de auditoría de vulnerabilidades que exista. Si no está instalada, se anota «OMITIDO — herramienta no instalada», no como hallazgo, y la revisión sigue con lo que sí hay (en la pasada determinista, la falta de una herramienta obligatoria deja la corrida en `UNKNOWN`).
- Revisar los **scripts de instalación** (`preinstall`, `postinstall`, `install`) de las dependencias de producción: son un vector clásico de ataque a la cadena de suministro.
- Revisar la **integridad del lockfile**: que exista y esté rastreado por git.
- **Contra falsos positivos:** las vulnerabilidades en dependencias de desarrollo son MEDIO como máximo. Los scripts de instalación de `node-gyp`/`cmake` son esperados. Las alertas sin parche disponible y sin exploit conocido se excluyen. La falta de lockfile en un repositorio de **librería** (no de una aplicación) no es hallazgo.

### Fase 4 — Seguridad de la tubería de CI/CD (si aplica)
Quién puede modificar los flujos de automatización y a qué secretos acceden.
- Acciones de terceros sin fijar a una versión exacta (sin SHA).
- Uso de `pull_request_target` (peligroso: da permisos de escritura y secretos a PR que vienen de forks); nunca descargar ni ejecutar el código del PR en ese contexto.
- Permisos del token del flujo: `permissions:` explícito y mínimo en cada flujo; sin `write-all` ni permisos de escritura que el trabajo no necesita.
- Inyección de scripts vía datos del evento (`${{ github.event.* }}`) dentro de pasos `run:`.
- Secretos expuestos como variables de entorno (pueden filtrarse en los registros).
- Protección de los archivos de flujo (CODEOWNERS).

### Fase 5 — Superficie de infraestructura oculta (si aplica)
- **Dockerfiles:** falta de directiva `USER` (corre como root), secretos pasados como `ARG`, archivos `.env` copiados a la imagen, puertos expuestos.
- **Configuraciones con credenciales de producción:** cadenas de conexión a base de datos (`postgres://`, `mysql://`, `mongodb://`, `redis://`) en archivos de configuración, excluyendo localhost y ejemplos.
- **Infraestructura como código:** permisos `"*"` en IAM, secretos incrustados en `.tf`/`.tfvars`, contenedores privilegiados en Kubernetes.
- **Endpoints temporales de mantenimiento** (diagnóstico, instalación, migración, utilidades sueltas subidas «solo un momento»): deben estar ELIMINADOS del código y del paquete de despliegue, y su URL debe responder 404. Los agentes lo revisan en el código y en la lista de archivos del paquete; el 404 en el despliegue real lo comprueba el responsable del proyecto.
- **Contra falsos positivos:** un `docker-compose.yml` de desarrollo local apuntando a localhost NO es hallazgo. Los manifiestos en carpetas `test/`, `dev/` o `local/` con red local se excluyen.

### Fase 6 — Webhooks e integraciones (si aplica)
Endpoints de entrada que aceptan cualquier cosa.
- Rutas de webhook/hook/callback que **NO verifican la firma** (buscar `signature`, `hmac`, `verify`, `x-hub-signature`, `stripe-signature`, etc.). Un webhook sin verificación de firma es un hallazgo.
- Verificación de TLS deshabilitada (`verify=false`, `VERIFY_NONE`, `InsecureSkipVerify`, `NODE_TLS_REJECT_UNAUTHORIZED=0`).
- Scopes de OAuth demasiado amplios.
- **Solo trazado de código, NUNCA peticiones reales:** verificar si la firma se valida en algún punto de la cadena (router padre, middleware, gateway). No se hacen peticiones HTTP reales al endpoint.

### Fase 7 — Seguridad propia de IA / LLM (si la aplicación usa modelos de lenguaje)
Es una clase de ataque nueva. Se busca:
- **Inyección de prompts:** entrada del usuario que fluye hacia el **prompt de sistema** o hacia los esquemas de herramientas (interpolación de cadenas cerca de donde se construye el prompt de sistema).
- **Salida del LLM sin sanear:** respuestas del modelo pintadas como HTML crudo (`dangerouslySetInnerHTML`, `v-html`, `innerHTML`, `.html()`).
- **Llamadas a herramientas o funciones sin validación** antes de ejecutarlas.
- **Llaves de API de IA en el código** (no en variables de entorno).
- **`eval()`/`exec()` sobre la salida del LLM.**
- **Envenenamiento de RAG:** ¿documentos externos pueden influir en el comportamiento del modelo vía la recuperación?
- **Ataques de costo:** ¿un usuario puede disparar llamadas ilimitadas al LLM? Debe existir un tope de gasto (por usuario y global). Esto es **riesgo financiero**, no denegación de servicio: no se descarta.
- **Clave contra falsos positivos:** el contenido del usuario en la **posición de mensaje de usuario** de una conversación NO es inyección de prompts. Solo es hallazgo cuando la entrada del usuario entra al prompt de **sistema**, a los esquemas de herramientas o al contexto de llamada de funciones.

### Fase 8 — OWASP Top 10 (el corazón de la lista)
Para cada categoría, análisis dirigido. Qué buscar en cada una:

- **A01 — Control de acceso roto:** rutas o controladores sin autenticación; referencias directas a objetos (¿el usuario A puede leer los recursos del usuario B cambiando un ID en la URL?); escalamiento horizontal o vertical de privilegios.
- **A02 — Fallas criptográficas:** criptografía débil (MD5, SHA1, DES, ECB); secretos incrustados; ¿los datos sensibles se cifran en reposo y en tránsito?; ¿las llaves viven en variables de entorno y no en el código?
- **A03 — Inyección:** SQL (consultas crudas, interpolación de cadenas en SQL); comandos (`system()`, `exec()`, `spawn()`, `popen`); plantillas (`render` con parámetros, `eval()`, `html_safe`, `raw()`); inyección de prompts (ver la Fase 7).
- **A04 — Diseño inseguro:** ¿hay límite de intentos en el inicio de sesión?; ¿bloqueo de cuenta tras varios fallos?; ¿la lógica de negocio se valida en el **servidor** (no solo en el navegador)?
- **A05 — Configuración de seguridad incorrecta:** CORS con orígenes comodín (`*`) en producción; ¿hay encabezados CSP?; ¿modo de depuración o errores detallados activos en producción?
- **A06 — Componentes vulnerables y desactualizados:** ver la Fase 3 (dependencias).
- **A07 — Fallas de identificación y autenticación:** manejo de sesión (creación, almacenamiento, invalidación); política de contraseñas (complejidad, revisión contra filtraciones); ¿hay MFA?, ¿se exige para administración?; manejo de tokens (expiración de JWT, rotación del token de refresco).
- **A08 — Fallas de integridad de software y datos:** ¿se validan las entradas de deserialización?; ¿se verifica la integridad de los datos externos? (ver también la Fase 4).
- **A09 — Fallas de registro y monitoreo:** ¿se registran los inicios de sesión?; ¿los fallos de autorización?; ¿las acciones de administración dejan rastro de auditoría?; ¿los registros están protegidos contra manipulación?
- **A10 — Falsificación de peticiones del lado del servidor (SSRF):** ¿se construyen URL a partir de entrada del usuario?; ¿una URL controlada por el usuario puede alcanzar un servicio interno?; ¿hay lista blanca o negra en las peticiones salientes?

### Fase 9 — Modelo de amenazas STRIDE
Para **cada componente importante** de la Fase 0, las seis amenazas (STRIDE es un acrónimo en inglés; aquí en llano):

- **S — Suplantación (Spoofing):** ¿puede un atacante hacerse pasar por un usuario o servicio legítimo?
- **T — Manipulación (Tampering):** ¿se pueden modificar los datos en tránsito o en reposo?
- **R — Repudio (Repudiation):** ¿puede alguien negar que hizo una acción? ¿hay un rastro de auditoría que lo desmienta?
- **I — Divulgación de información (Information Disclosure):** ¿pueden filtrarse datos sensibles?
- **D — Denegación de servicio (Denial of Service):** ¿se puede saturar el componente hasta tumbarlo?
- **E — Elevación de privilegios (Elevation of Privilege):** ¿puede un usuario común obtener un acceso que no le corresponde?

### Fase 10 — Clasificación de datos
Clasificar todos los datos que maneja la aplicación, para saber qué duele si se filtra:
- **RESTRINGIDO (una fuga = responsabilidad legal):** contraseñas y credenciales, datos de pago, datos personales (PII), datos de salud. Se anota dónde se guardan y cómo se protegen.
- **CONFIDENCIAL (una fuga = daño al negocio):** llaves de API, lógica de negocio o secretos comerciales en el código, datos de comportamiento del usuario.
- **INTERNO (una fuga = vergüenza):** registros del sistema, configuración expuesta en mensajes de error.
- **PÚBLICO:** contenido comercial, documentación, API públicas.
- **Datos reales fuera del repositorio:** exportaciones, PDF, hojas de cálculo y respaldos con datos RESTRINGIDOS de personas reales no están en git (ni en el historial) ni en los paquetes de despliegue; se comprueba con la lista de archivos rastreados y la del paquete.

---

## El filtro contra falsos positivos (lo más importante)

Antes de reportar **cualquier** hallazgo, pasa por este filtro. Un informe que «grita lobo» se ignora: la credibilidad de toda la auditoría depende de esto.

### 1. Releer el código para confirmarlo (compuerta de «cita la línea»)
Un hallazgo no sube al informe hasta que se puede **citar la línea exacta** (`archivo:línea` + el texto literal) que lo motiva.
- Si el hallazgo es «el campo X no existe en el modelo Y», se citan las líneas de la clase Y donde viviría ese campo.
- Si es «esto podría devolver nulo», se cita dónde se inicializa la variable.
- Si es «condición de carrera entre A y B», se citan A y B.
- **Sin la línea que lo motiva, el hallazgo NO está verificado.** Su confianza baja a 4-5 (queda fuera del informe principal, solo en un apéndice). Inflar la confianza a 7 o más para saltarse esta regla es trampa.
- **Ojo con los símbolos que genera el framework** (relaciones de ORM, migraciones, decoradores, clases Meta de Django, `has_many` de Rails, `relationship`/`Column` de SQLAlchemy, el cliente generado de Prisma): no basta con «busqué el nombre y no apareció». Se cita la construcción que **crea** ese símbolo (la migración, el decorador, el esquema). La verificación es «leí el código que crea esto», no «no lo vi en el cuerpo de la clase».

### 2. Exigir confianza mínima de 8/10 (compuerta de confianza)
Cada hallazgo lleva un puntaje de confianza de 1 a 10:

| Puntaje | Significado | Qué hacer |
|---|---|---|
| 9-10 | Verificado leyendo el código concreto. Fallo o exploit concreto demostrado. | Reportar normal |
| 7-8 | Alta confianza. Muy probablemente correcto. | Reportar normal |
| 5-6 | Moderado. Podría ser un falso positivo. | Reportar con advertencia: «confianza media, verificar» |
| 3-4 | Baja. Sospechoso, pero puede estar bien. | Fuera del informe principal; solo apéndice |
| 1-2 | Especulación. | Reportar solo si la gravedad fuera catastrófica |

**En el nivel normal la compuerta es absoluta: por debajo de 8/10 no se reporta.** (En el exhaustivo el umbral baja a 2/10, pero esos hallazgos se marcan `TENTATIVO`.)

### 3. Verificación activa: intentar PROBAR el hallazgo (sin atacar de verdad)
Cada hallazgo que pasa la compuerta se intenta **demostrar** de forma segura, **solo trazando código, nunca lanzando ataques reales**:
- **Secretos:** confirmar que el patrón tiene formato de llave real (largo y prefijo correctos). NUNCA probarlo contra la API en vivo.
- **Webhooks:** rastrear el código para ver si la firma se valida en algún punto. Sin peticiones HTTP.
- **SSRF:** rastrear el camino para ver si una URL construida con entrada del usuario alcanza un servicio interno. Sin peticiones.
- **CI/CD:** leer el YAML para confirmar si `pull_request_target` de verdad descarga el código del PR.
- **Dependencias:** revisar si la función vulnerable se importa y se llama de verdad. Si se llama → VERIFICADO. Si no → NO VERIFICADO, con nota.
- **IA/LLM:** rastrear el flujo de datos para confirmar que la entrada del usuario **de verdad** llega al prompt de sistema.

Cada hallazgo se marca como:
- **VERIFICADO** — confirmado activamente trazando código.
- **NO VERIFICADO** — solo coincidencia de patrón; no se pudo confirmar.
- **TENTATIVO** — hallazgo del nivel exhaustivo por debajo de 8/10.

Estos marcadores describen el trabajo previo a la validación. El estado final de un hallazgo lo da la escala única de `escala-y-estados.md` (allí `confirmado` exige reproducción en la caja de arena); ningún marcador de esta lista lo sustituye.

### 4. Verificación independiente (segunda mirada sin sesgo)
Cada hallazgo candidato se revisa con **ojos frescos**: alguien que solo ve el `archivo:línea` y las reglas del filtro, SIN el razonamiento del primer escaneo (para no contaminarlo). Consigna: «Lee el código en esta ubicación. Evalúa de forma independiente: ¿hay una vulnerabilidad real? Puntúa de 1 a 10. Por debajo de 8, explica por qué NO es real.» **Se descarta todo hallazgo que la segunda mirada puntúe por debajo de 8.** En la auditoría completa esta mirada la dan los verificadores frescos (`roles-y-presupuesto.md`). Si no hay un segundo revisor, se relee con mentalidad escéptica y se anota «auto-verificado».

### 5. Descartar de entrada lo que no se puede reproducir o no es un problema real
Se descartan los hallazgos que caen en estas categorías de ruido (salvo las excepciones anotadas):
- Denegación de servicio, agotamiento de recursos, límites de tasa. **Excepción:** el gasto ilimitado en llamadas a un LLM o a una API de pago SÍ cuenta (es riesgo financiero, no denegación de servicio).
- Secretos en disco que ya están protegidos (cifrados, con permisos).
- Consumo de memoria o CPU, fugas de descriptores.
- Validación de entrada en campos no críticos sin impacto probado.
- Problemas de seguridad de memoria en lenguajes seguros de memoria (Rust, Go, Java, C#).
- Archivos que son solo pruebas o fixtures y que el código real no usa.
- «Log spoofing» (sacar entrada sin sanear a los registros): no es vulnerabilidad.
- SSRF donde el atacante solo controla la ruta, no el host ni el protocolo.
- Contenido del usuario en la posición de mensaje de usuario de una conversación de IA (NO es inyección de prompts).
- Complejidad de expresiones regulares en código que no procesa entrada no confiable.
- Falta de endurecimiento (hardening): se reportan vulnerabilidades concretas, no la ausencia de buenas prácticas.
- Falta de registros de auditoría: la ausencia de registros no es una vulnerabilidad en sí.
- Aleatoriedad insegura en contextos ajenos a la seguridad (por ejemplo, ID de elementos de la interfaz).
- Vulnerabilidades de dependencias con gravedad muy baja (CVSS < 4.0) y sin exploit conocido.

**Precedentes útiles:** registrar un secreto en texto plano SÍ es vulnerabilidad; registrar URL, no. Los UUID son inadivinables (no se exige validarlos). Las variables de entorno y las opciones de línea de comandos son entrada confiable. React y Angular escapan el HTML por defecto (solo se marcan las «escotillas» tipo `dangerouslySetInnerHTML`). El JS del navegador no autentica (esa tarea es del servidor). Los contenedores que corren como root en un `docker-compose.yml` de desarrollo local NO son hallazgo; en un Dockerfile o un manifiesto de Kubernetes de producción, SÍ.

### 6. Análisis de variantes
Cuando un hallazgo queda **VERIFICADO**, se busca el **mismo patrón** en todo el código: un SSRF confirmado suele significar que hay cinco más. Se extrae el patrón central, se busca en todos los archivos relevantes y las variantes se reportan ligadas al original.

---

## El informe final

- **Cada hallazgo DEBE incluir un escenario de explotación concreto:** el paso a paso que seguiría un atacante. «Este patrón es inseguro» NO es un hallazgo.
- Cada hallazgo lleva gravedad, confianza (N/10), marcador (VERIFICADO / NO VERIFICADO / TENTATIVO), categoría, `archivo:línea`, escenario de explotación y remediación. En `AUDIT_REPORT.md`, la gravedad y el estado siguen `escala-y-estados.md`.
- Se ordena por gravedad (crítico primero) y prioridad.
- Si nada sobrevive al filtro, el informe honesto es «no se encontraron hallazgos que superen la compuerta». Es un resultado válido, no una falla.

**Calibración:** un hallazgo reportado con confianza baja (< 7) que resultó real deja anotado su patrón en las lecciones del proyecto, para cazarlo con más confianza la próxima vez. Y al revés: lo que se «gritó» y resultó falso ajusta el filtro.

---

## Resumen de la disciplina
1. Entender la aplicación (Fase 0) y censar la superficie de ataque (Fase 1).
2. Recorrer las fases en orden: secretos en git → dependencias → CI/CD e infraestructura → webhooks → IA → OWASP Top 10 → STRIDE → clasificación de datos.
3. Antes de reportar CUALQUIER cosa: **citar la línea, exigir 8/10, probarlo trazando código, pasarlo por una segunda mirada y descartar lo irreproducible**.
4. Todo hallazgo lleva un escenario de explotación real. Cero ruido.
