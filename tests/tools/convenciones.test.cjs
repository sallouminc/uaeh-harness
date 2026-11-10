'use strict';
// Convenciones del código que ninguna otra prueba vigila. Cada regla nace de un fallo medido.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');

function fuentes(dir, salida = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) fuentes(p, salida);
    else if (/\.(cjs|js|mjs|ts)$/.test(e.name)) salida.push(p);
  }
  return salida;
}

test('nadie usa la copia recursiva de fs: en Windows falla sin avisar con rutas no ASCII (usuario con acento en su carpeta)', () => {
  const prohibido = 'cp' + 'Sync('; // armado por partes para que este archivo no se delate a sí mismo
  const malos = [];
  for (const carpeta of ['plugins', 'tools', 'tests']) {
    for (const f of fuentes(path.join(RAIZ, carpeta))) {
      const lineas = fs.readFileSync(f, 'utf8').split('\n');
      lineas.forEach((l, i) => { if (l.includes(prohibido) && !/^\s*(\/\/|\*)/.test(l)) malos.push(`${path.relative(RAIZ, f)}:${i + 1}`); });
    }
  }
  assert.deepEqual(malos, [], 'usar una copia propia (tests/helpers/entorno.cjs → copiarCarpeta)');
});
