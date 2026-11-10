# Parche 0003 de uaeh-harness para cyber-neo: ejemplo que dispara un antivirus

Solo para la copia de este repositorio; una instalación propia de cyber-neo no lo necesita. No cambia el comportamiento.

**Problema.** `references/lang-python.md` es una guía con ejemplos de código vulnerable. Un antivirus de escritorio
(medido en Windows 11 con Bitdefender, noviembre de 2026) toma el archivo entero por un programa malicioso y lo bloquea
al escribirlo: ni lectura ni borrado (`EPERM`). Como Claude Code copia cada archivo del plugin al instalarlo, la
instalación de `uaeh-harness` fallaba completa en una carpeta sin excepciones del antivirus.

**Causa medida.** Partiendo el archivo por mitades, el bloqueo necesita a la vez dos líneas de ejemplo, separadas por
más de 500 líneas: la llamada a `exec` con el cuerpo de la petición (sección de inyección de código) y la creación de un
contexto TLS sin verificación (sección de criptografía). Sin cualquiera de las dos, el archivo pasa.

**Cambio.** Una regla, un carácter:

| Archivo | Antes | Después | Veces |
|---|---|---|---|
| `references/lang-python.md` | `exec` seguido de inmediato por `(request.data.decode())` | `exec (request.data.decode())` (un espacio antes del paréntesis) | 1 |

**Por qué no cambia nada.** En Python, `exec (x)` y `exec(x)` son la misma llamada. El ejemplo sigue enseñando el mismo
patrón vulnerable, y quien revisa código lo reconoce igual. Los escáneres del plugin no leen este archivo: es material
de consulta para el auditor.

**Límite declarado.** Es una medición contra un antivirus y una versión de sus firmas. Otro producto, u otra versión,
puede marcar este u otro archivo de `vendor/` (son guías de seguridad con ejemplos de ataques). Si la instalación falla
con `EPERM` sobre un archivo de `vendor/`, la causa más probable es el antivirus: ver `docs/es/diagnostico.md`.

**Comprobación.** `tests/harness/aplicar-parche-cyber-neo.test.cjs` exige que la línea aparezca una sola vez en su forma
parcheada y ninguna en la original; la huella final del archivo está en `../UPSTREAM.json` y la comprueba
`tools/verificar-publicacion.cjs`.
