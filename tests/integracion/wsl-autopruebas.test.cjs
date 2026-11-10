// Integración de la capa 3 instalada: corre las autopruebas de plugins/uaeh-harness/wsl/pruebas/ en el motor de Linux
// (WSL2 en Windows, directo en Linux) contra lo instalado en /opt/uaeh. Fuera de la batería normal:
//
//   node tools/correr-pruebas.cjs --solo integracion
//
// Necesita la capa 3 instalada con los instaladores del plugin (wsl/instalar.sh y wsl/instalar-bin.sh): Docker que
// responda para el usuario, /opt/uaeh/uaeh.conf y las imágenes fijadas. Cada autoprueba sale con 77 si falta algo de
// eso; aquí 77 = omitida con su motivo, y con UAEH_INTEGRACION=1 (el trabajo linux-integracion de CI) = FALLO.
// En Windows, si la distro no se llama como la de fábrica, exporta UAEH_WSL_DISTRO (y UAEH_WSL_USER) antes.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { RAIZ_HARNESS, entornoTemporal } = require('../helpers/entorno.cjs');

const configLib = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'config.cjs'));
const runner = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'runner.cjs'));

const E = entornoTemporal('uaeh-wsl-int-');
process.on('exit', () => E.limpiar());
const ENV = { ...E.env };
for (const k of ['UAEH_WSL_DISTRO', 'UAEH_WSL_USER']) if (process.env[k]) ENV[k] = process.env[k];
const CFG = configLib.cargarConfig({ env: ENV }).config;
const ESTRICTO = process.env.UAEH_INTEGRACION === '1';
const MOTOR = runner.motorListo(CFG);

if (!MOTOR.listo && ESTRICTO) {
  test('integración obligatoria (UAEH_INTEGRACION=1): el motor de Linux responde', () => assert.fail(`SIN MOTOR: ${MOTOR.detalle}`));
}

// [archivo, segundos, marca que debe salir en verde]
const AUTOPRUEBAS = [
  ['probar-promover.sh', 300, /RESUMEN pass=\d+ fail=0/],
  ['probar-sandbox.sh', 900, /RESUMEN pass=\d+ fail=0/],
  ['probar-pnpmfile.sh', 600, /PNPMFILE_OK/],
];

for (const [archivo, segundos, verde] of AUTOPRUEBAS) {
  test(`autoprueba ${archivo} contra la capa 3 instalada`, { timeout: (segundos + 60) * 1000 }, (t) => {
    if (!MOTOR.listo) { t.skip(`SIN MOTOR: ${MOTOR.detalle}`); return; }
    const script = runner.aRutaMotor(path.join(RAIZ_HARNESS, 'wsl', 'pruebas', archivo));
    const r = runner.ejecutarEnLinux(['/bin/bash', script], { segundos }, CFG);
    const salida = `${r.stdout}${r.stderr}`;
    if (r.codigo === 77) {
      const motivo = (/^SKIP: (.+)$/m.exec(salida) || [, 'sin motivo'])[1];
      if (ESTRICTO) assert.fail(`omitida en modo estricto (UAEH_INTEGRACION=1): ${motivo}`);
      t.skip(`CAPA 3 NO INSTALADA: ${motivo}`);
      return;
    }
    assert.equal(r.agotado, false, `${archivo} pasó de ${segundos} s`);
    assert.equal(r.codigo, 0, salida.split('\n').filter((l) => /^(FAIL|FALLA)/.test(l)).join('\n') || salida.slice(-2000));
    assert.match(salida, verde);
  });
}
