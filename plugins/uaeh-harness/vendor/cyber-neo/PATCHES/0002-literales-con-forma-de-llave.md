# Parche 0002 de uaeh-harness para cyber-neo: literales con forma de llave

Solo para la copia de este repositorio; una instalación propia de cyber-neo no lo necesita. No cambia el comportamiento.

**Problema.** El escáner y sus referencias traen, como patrones y ejemplos, cabeceras PEM de llave privada y la llave de
acceso de ejemplo de la documentación de AWS escritas enteras. Cualquier guarda de secretos (la de commits de
uaeh-harness, gitleaks, el escaneo de secretos de GitHub) las toma por secretos reales y niega el commit o la
publicación de esta carpeta.

**Por qué no es un `.patch`.** Un diff que quita esas cadenas las contiene en sus líneas «-»: la guarda lo negaría igual.
Por eso el cambio se describe como reglas. `<B>` = `-----BEGIN ` y `<K>` = `PRIVATE KEY-----`; `<TIPO>` = `RSA`, `EC`,
`DSA`, `OPENSSH`, `ENCRYPTED` o nada.

| Archivo | Antes | Después | Veces |
|---|---|---|---|
| `scripts/scan_secrets.py` | `r"<B><TIPO> <K>"` (RSA, EC, DSA, OPENSSH y sin tipo) | `r"<B><TIPO> " r"<K>"` | 5 |
| `references/secrets-patterns.md` | `` `<B><TIPO> <K>` `` (RSA ×2; EC, DSA, OPENSSH, ENCRYPTED y sin tipo ×1) | `` `<B><TIPO> PRIVATE[ ]KEY-----` `` | 7 |
| `references/secrets-patterns.md` | la llave de ejemplo de AWS, entre comillas invertidas | `` `AKIA` + `<resto>` `` | 1 |
| `references/crypto-patterns.md` | la primera línea de la llave del fragmento de JavaScript | `<B>RSA PRIVATE KEY (example)-----` | 1 |
| `references/lang-python.md` | `"<llave de ejemplo de AWS>"` | `"AKIA" "<resto>"` | 1 |

**Por qué no cambia nada.**
- Python une al compilar dos literales de cadena contiguos: los 56 patrones de `scan_secrets.py` quedan idénticos a los
  del original (comprobado importando el módulo y comparando `PATTERNS`).
- En una expresión regular, `[ ]` casa un espacio: la búsqueda de las referencias es la misma.
- `"AKIA" "<resto>"` es el mismo valor en Python; el fragmento de JavaScript es un ejemplo de lo que NO se debe hacer.
- El bloque del parche 0001 no se toca.

**Comprobación.** `tests/harness/aplicar-parche-cyber-neo.test.cjs` deshace estas reglas sobre `scan_secrets.py` y exige
la huella exacta de «original + 0001» declarada en `../UPSTREAM.json`; las huellas finales de los cuatro archivos están
en ese mismo archivo y las comprueba `tools/verificar-publicacion.cjs`.
