# verify.ps1 - plantilla de verificacion del proyecto (UAEH). Probada en PowerShell 5.1 (en 7, sin probar). Solo ASCII: PS 5.1 lee un
# .ps1 UTF-8 sin BOM como ANSI. Copiala a scripts\verify.ps1 y adapta SOLO el bloque entre las marcas
# ">>> comprobaciones" y "<<< comprobaciones".
# Regla: no copies un comando sin comprobar que existe (scripts de package.json, pyproject.toml, Makefile, etc.).
# Seguridad: los comandos son texto fijo, escrito y revisado por una persona; nunca los armes con la entrada de un
# prompt, un archivo externo o una variable de entorno.
#
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1 [-Full]
# -Full: no hace nada por si solo; sirve para activar comprobaciones lentas que agregues bajo "if ($Full)".
# Corre TODAS las comprobaciones aunque una falle. Codigo de salida:
#   0 = todo paso | 1 = alguna salio con codigo distinto de 0 (FAIL domina) |
#   3 = nada fallo pero una comprobacion de pruebas no demostro ninguna prueba real (UNKNOWN: sin pruebas no es verde).
# Invoke-Check NOMBRE 'COMANDO' [-Count ...]; el conteo es opcional:
#   node-tap -> para: node --test --test-reporter=tap  (sin ruta: Node descubre *.test.js y test\; un glob entre
#               comillas solo desde Node 21: Node 20 no lo expande. Nunca una carpeta como argumento).
#               Pruebas reales = "# tests N" menos los archivos de prueba vacios, que Node cuenta como 1 prueba que pasa.
#   regex    -> expresion con UN grupo que da el numero de pruebas (ej.: '(\d+) passed' de pytest/jest/vitest,
#               'OK \((\d+) tests?' de PHPUnit, '(\d+) passed;' de cargo). Si coincide varias veces se SUMAN. Sin coincidencia o 0 = UNKNOWN.
param([switch]$Full)
$ErrorActionPreference = 'Continue'
$script:Resultados = @()

function Invoke-Check {
    param([string]$Name, [string]$Cmd, [string]$Count = '')
    Write-Host "CHECK: $Name -> $Cmd"
    $lineas = @()
    # cmd.exe lo ejecuta (compatible con npm.cmd) y une stderr a stdout ahi dentro: asi PS 5.1 no genera NativeCommandError.
    & cmd.exe /d /s /c "$Cmd 2>&1" | ForEach-Object { Write-Host $_; $lineas += [string]$_ }
    $code = $LASTEXITCODE
    $n = '-'
    if ($Count -eq 'node-tap') {
        $total = 0
        foreach ($l in $lineas) { if ($l -match '^# tests (\d+)') { $total = [int]$Matches[1] } }
        $vacios = @($lineas | Where-Object { $_ -match '^(not )?ok \d+ - .*\.(test|spec)\.[cm]?[jt]sx?\s*$' }).Count
        $n = $total - $vacios
    } elseif ($Count -ne '') {
        $n = 0
        foreach ($m in [regex]::Matches(($lineas -join "`n"), $Count)) { $n += [int]$m.Groups[1].Value }
    }
    if ($code -ne 0) { $estado = 'FAIL' }
    elseif ($Count -ne '' -and $n -lt 1) { $estado = 'UNKNOWN' }
    else { $estado = 'PASS' }
    $script:Resultados += [pscustomobject]@{ Name = $Name; Code = $code; Count = $n; Estado = $estado }
}

# >>> comprobaciones (adapta esto)
Invoke-Check 'tests' 'npm test'            # con conteo: Invoke-Check 'tests' 'npm test' -Count '(\d+) passed'
Invoke-Check 'types' 'npm run typecheck'
Invoke-Check 'lint' 'npm run lint'
# Invoke-Check 'tests-node' 'node --test --test-reporter=tap' -Count 'node-tap'
# if ($Full) { Invoke-Check 'e2e' 'npm run e2e' }
# <<< comprobaciones

Write-Host ''
Write-Host ('{0,-16} {1,6} {2,8}  {3}' -f 'CHECK', 'CODIGO', 'PRUEBAS', 'ESTADO')
foreach ($r in $script:Resultados) {
    Write-Host ('{0,-16} {1,6} {2,8}  {3}' -f $r.Name, $r.Code, $r.Count, $r.Estado)
}
if (@($script:Resultados | Where-Object { $_.Estado -eq 'FAIL' }).Count -gt 0) { Write-Host 'RESULTADO: FAIL'; exit 1 }
if (@($script:Resultados | Where-Object { $_.Estado -eq 'UNKNOWN' }).Count -gt 0) { Write-Host 'RESULTADO: UNKNOWN (sin pruebas no es verde)'; exit 3 }
Write-Host 'RESULTADO: PASS'
exit 0
