#!/usr/bin/env bash
# verify.sh - plantilla de verificacion del proyecto (UAEH). Copiala a scripts/verify.sh y adapta SOLO el bloque
# entre las marcas ">>> comprobaciones" y "<<< comprobaciones".
# Regla: no copies un comando sin comprobar que existe (scripts de package.json, pyproject.toml, Makefile, etc.).
# Seguridad: los comandos son texto fijo, escrito y revisado por una persona; nunca los armes con la entrada de un
# prompt, un archivo externo o una variable de entorno.
#
# Uso: scripts/verify.sh [--full]   (--full: activa las comprobaciones lentas que agregues bajo "if [ $FULL = 1 ]")
# Corre TODAS las comprobaciones aunque una falle. Codigo de salida:
#   0 = todo paso | 1 = alguna salio con codigo distinto de 0 (FAIL domina) |
#   3 = nada fallo pero una comprobacion de pruebas no demostro ninguna prueba real (UNKNOWN: sin pruebas no es verde).
# check NOMBRE "COMANDO" [conteo]; el conteo es opcional:
#   node-tap -> para: node --test --test-reporter=tap  (sin ruta: Node descubre *.test.js y test/; un glob entre
#               comillas solo desde Node 21: Node 20 no lo expande. Nunca una carpeta como argumento).
#               Pruebas reales = "# tests N" menos los archivos de prueba vacios, que Node cuenta como 1 prueba que pasa.
#   regex    -> expresion con UN grupo que da el numero de pruebas (ej.: '(\d+) passed' de pytest/jest/vitest,
#               'OK \((\d+) tests?' de PHPUnit, '(\d+) passed;' de cargo). Si coincide varias veces se SUMAN. Sin coincidencia o 0 = UNKNOWN.
set -u

FULL=0
[ "${1:-}" = "--full" ] && FULL=1
TMP=$(mktemp) || exit 2
trap 'rm -f "$TMP"' EXIT
NOMBRES=(); CODIGOS=(); CUENTAS=(); ESTADOS=()

check() {
  local nombre=$1 cmd=$2 modo=${3:-} code total vacios pat sep n="-" estado
  echo "CHECK: $nombre -> $cmd"
  bash -c "$cmd" </dev/null 2>&1 | tee "$TMP"
  code=${PIPESTATUS[0]}
  if [ "$modo" = "node-tap" ]; then
    total=$(sed -n 's/^# tests \([0-9][0-9]*\).*/\1/p' "$TMP" | tail -n 1)
    vacios=$(grep -Ec '^(not )?ok [0-9]+ - .*\.(test|spec)\.[cm]?[jt]sx?[[:space:]]*$' "$TMP")
    n=$(( ${total:-0} - vacios ))
  elif [ -n "$modo" ]; then
    pat=$(printf '%s' "$modo" | sed 's/\\d/[0-9]/g'); sep=$'\001'
    n=$(grep -Eo "$pat" "$TMP" | sed -E "s${sep}${pat}${sep}\\1${sep}" | awk '{ s += $1 } END { print s + 0 }')
  fi
  if [ "$code" -ne 0 ]; then estado=FAIL
  elif [ -n "$modo" ] && [ "$n" -lt 1 ]; then estado=UNKNOWN
  else estado=PASS; fi
  NOMBRES+=("$nombre"); CODIGOS+=("$code"); CUENTAS+=("$n"); ESTADOS+=("$estado")
}

# >>> comprobaciones (adapta esto)
check tests "npm test"            # con conteo: check tests "npm test" '(\d+) passed'
check types "npm run typecheck"
check lint  "npm run lint"
# check tests-node 'node --test --test-reporter=tap' node-tap
# if [ $FULL = 1 ]; then check e2e "npm run e2e"; fi
# <<< comprobaciones

echo
printf '%-16s %5s %7s  %s\n' CHECK CODIGO PRUEBAS ESTADO
fallo=0; desconocido=0; i=0
while [ "$i" -lt "${#NOMBRES[@]}" ]; do
  printf '%-16s %5s %7s  %s\n' "${NOMBRES[$i]}" "${CODIGOS[$i]}" "${CUENTAS[$i]}" "${ESTADOS[$i]}"
  [ "${ESTADOS[$i]}" = FAIL ] && fallo=1
  [ "${ESTADOS[$i]}" = UNKNOWN ] && desconocido=1
  i=$((i + 1))
done
if [ "$fallo" = 1 ]; then echo "RESULTADO: FAIL"; exit 1; fi
if [ "$desconocido" = 1 ]; then echo "RESULTADO: UNKNOWN (sin pruebas no es verde)"; exit 3; fi
echo "RESULTADO: PASS"
