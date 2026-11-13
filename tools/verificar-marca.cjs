'use strict';
// Comprobación local de los recursos de marca, sin instalar ni publicar.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const raiz = path.resolve(__dirname, '..');
let controles = 0;
function comprobar(nombre, fn) {
  fn(); controles += 1; console.log(`OK ${nombre}`);
}
function leer(rel) { return fs.readFileSync(path.join(raiz, rel)); }
function json(rel) { return JSON.parse(leer(rel)); }
function png(rel, size) {
  const b = leer(rel);
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(b.subarray(12, 16).toString(), 'IHDR');
  assert.equal(b.readUInt32BE(16), size);
  assert.equal(b.readUInt32BE(20), size);
  return b;
}
try {
  for (const size of [32, 64, 128, 256, 512]) {
    comprobar(`PNG ${size} x ${size}`, () => png(`assets/brand/uaeh-icon-${size}.png`, size));
  }
  const marketplace = json('.claude-plugin/marketplace.json');
  for (const nombre of ['uaeh-kit', 'uaeh-harness']) {
    comprobar(`${nombre}: icono empaquetado y versión coherente`, () => {
      const manifest = json(`plugins/${nombre}/.claude-plugin/plugin.json`);
      assert.equal(manifest.icon, './assets/icon.png');
      const b = png(`plugins/${nombre}/assets/icon.png`, 512);
      assert.deepEqual(b, leer('assets/brand/uaeh-icon-512.png'));
      assert.equal(manifest.version, marketplace.plugins.find((p) => p.name === nombre).version);
    });
  }
  comprobar('nombre completo y ausencia de eslogan en la configuración de marca', () => {
    const p = json('assets/brand/palette.json');
    assert.equal(p.fullName, 'Universal Agentic Engineering Harness');
    assert.equal(p.slogan, null);
    for (const hex of Object.values(p.colors)) assert.match(hex, /^#[0-9A-F]{6}$/);
  });
  comprobar('guía PDF presente', () => assert.equal(leer('assets/brand/UAEH-brand-guide.pdf').subarray(0, 5).toString(), '%PDF-'));
  comprobar('documentación ES/EN enlaza la guía', () => {
    for (const idioma of ['es', 'en']) assert.match(leer(`docs/${idioma}/marca.md`).toString(), /UAEH-brand-guide\.pdf/);
  });
  console.log(`MARCA_OK: ${controles} controles; icono SHA256 ${crypto.createHash('sha256').update(leer('assets/brand/uaeh-icon-512.png')).digest('hex')}`);
} catch (e) {
  console.error(`MARCA_FALLO tras ${controles} controles: ${e.message}`);
  process.exitCode = 1;
}
