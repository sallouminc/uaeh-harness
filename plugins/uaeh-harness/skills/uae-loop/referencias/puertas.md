# Puertas dentro de la lista blanca

## Qué puerta corre (y nada más)
| La tarea toca | Puerta | Cuándo |
|---|---|---|
| Cualquier cosa de la lista blanca | `uaeh-harness:uae-verifier` (pruebas del área + diff contra criterios) | siempre, una vez |
| Dinero o cuentas | la puerta de seguridad (capa 3), modo `diff <base>`, con sello; sin la capa 3, `uaeh-harness:uae-security` sobre el diff, con sello y sin caja de arena | en paralelo con el verificador |
| Arreglo de un `SEC-NNN` | la puerta de seguridad (capa 3), modo `reprobar SEC-NNN` | tras el PASS del arreglo |
| Base de datos / migraciones | revisión del diff por el verificador; `claude-db:audit` (si está instalado) | `claude-db:audit` solo en `critical` |
| Qué datos personales se recogen o para qué | `legal:compliance-check` (si está instalado) | en línea, mientras revisan |
| Publicar al público | batería completa + la puerta de seguridad (capa 3), modo `lanzamiento` | solo antes de publicar |
| Pantallas | captura al usuario | la puerta visual (capa 3) solo si el usuario la pide |

## Qué revisa seguridad según el nivel
- **Alto (datos personales, pagos, API pública):** autorización en el servidor, pruebas BOLA/IDOR del endpoint tocado,
  validación de entrada, secretos, dependencias nuevas, migraciones y aislamiento entre usuarios.
- **Crítico (salud, dinero real, borrados, grandes conjuntos de datos sensibles):** lo anterior + plan del arquitecto con
  rollback, aprobación del usuario y, antes de escalar usuarios, recomendar un pentest humano externo.

## Prohibido publicar si
- Hay credenciales o llaves en el diff o en artefactos.
- Una prueba de autenticación/autorización de alto riesgo falló o no corrió.
- Hay una migración destructiva sin plan, respaldo y prueba de restauración.
- Un endpoint administrativo depende solo del frontend.
- Una función nueva de autenticación guarda la sesión en `localStorage`/`sessionStorage`.
- Hay datos personales expuestos en logs, exportaciones, respuestas de la API o ambientes de prueba.
- Un hallazgo alto/crítico de SAST/SCA sigue sin decisión.
- No hay vuelta atrás mínima para una funcionalidad crítica.

## Criterios de aceptación convertidos en prueba (ejemplos)
**«Usuarios normales no pueden cambiar roles»:** `GET /admin/users` sin login → `401`; `POST /admin/roles` con rol
user → `403`; con admin válido → autorizado; cambiar el rol en el cliente no cambia la autorización del servidor.

**«La sesión web no se puede robar con JavaScript»:** tras el login, `localStorage`/`sessionStorage` sin tokens ni ID
de sesión; cookie `HttpOnly`, `Secure` y `SameSite`; el cierre de sesión la invalida.
