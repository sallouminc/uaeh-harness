// La biblioteca compartida vive en los dos plugins (cada plugin se instala solo). Esta prueba exige que las dos copias
// sean byte a byte iguales: así una corrección en una no se pierde en la otra, y el espejo estable recibe lo mismo.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_KIT, RAIZ_HARNESS } = require('../helpers/entorno.cjs');

test('scripts/lib/comun.cjs es idéntico en uaeh-kit y uaeh-harness', () => {
  const kit = fs.readFileSync(path.join(RAIZ_KIT, 'scripts', 'lib', 'comun.cjs'));
  const harness = fs.readFileSync(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'comun.cjs'));
  assert.ok(kit.equals(harness), 'las dos copias de comun.cjs difieren: copia la del kit al harness (o al revés) y vuelve a correr las dos baterías');
});

test('ningún script del harness lee rutas de estado fuera de lib/comun.cjs', () => {
  const prohibidos = [/os\.homedir\(\)\s*,\s*['"]\.claude['"]/, /['"]~\/\.claude\//, /process\.env\.UAEH_HOME\b(?!.*comun)/];
  const revisar = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { revisar(p); continue; }
      if (!/\.(cjs|js)$/.test(ent.name) || /comun\.cjs$/.test(ent.name)) continue;
      const texto = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      for (const re of prohibidos) assert.ok(!re.test(texto), `${path.relative(RAIZ_HARNESS, p)} lee una ruta de estado por su cuenta (${re})`);
    }
  };
  for (const sub of ['hooks', 'scripts']) revisar(path.join(RAIZ_HARNESS, sub));
});
