// tests/harness/clasificar-resultados.test.cjs — clasificador de la puerta visual (skills/uae-visual/scripts/clasificar-resultados.cjs).
//
// Qué protege: el paso del JSON de Playwright a los estados PASS | FAIL | BLOCKED | NOT_CHECKED (y UNKNOWN sin datos),
// el orden de gravedad del estado global (BLOCKED > FAIL > NOT_CHECKED > PASS) y los códigos de salida de la línea de
// comandos que cita la skill (0 con datos · 3 sin datos · 2 uso). Reportes de juguete; no necesita Playwright.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_HARNESS, entornoTemporal, correr } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_HARNESS, 'skills', 'uae-visual', 'scripts', 'clasificar-resultados.cjs');
const { clasificar } = require(SCRIPT);
const ESC = String.fromCharCode(27);

// Reporte con un describe «/» y los tests dados.
function reporte(tests) {
  return {
    suites: [{
      title: 'visual.spec.ts', file: 'visual.spec.ts',
      suites: [{
        title: '/',
        specs: tests.map((t) => ({
          title: t.check,
          tests: [{
            projectName: t.proyecto || 'movil-360',
            status: t.status || 'expected',
            results: [{ status: t.res, error: t.msg ? { message: t.msg } : undefined }],
          }],
        })),
      }],
    }],
    errors: [],
  };
}
const estados = (r) => r.pruebas.map((p) => p.estado);

test('todo pasa → PASS', () => {
  assert.equal(clasificar(reporte([{ check: 'axe', res: 'passed' }, { check: 'captura', res: 'passed' }])).global, 'PASS');
});

test('falla normal → FAIL', () => {
  const r = clasificar(reporte([{ check: 'axe', res: 'failed', msg: 'violaciones axe: color-contrast (2 nodos)' }]));
  assert.deepEqual(estados(r), ['FAIL']);
  assert.equal(r.global, 'FAIL');
});

test('sin baseline → NOT_CHECKED (nunca PASS)', () => {
  const r = clasificar(reporte([{ check: 'captura', res: 'failed', msg: "Error: A snapshot doesn't exist at x.png." }]));
  assert.deepEqual(estados(r), ['NOT_CHECKED']);
  assert.equal(r.global, 'NOT_CHECKED');
});

test('errores de entorno → BLOCKED (conexión rechazada, red, servidor de pruebas que no arranca)', () => {
  for (const msg of ['page.goto: net::ERR_CONNECTION_REFUSED at http://x', 'connect ECONNREFUSED 127.0.0.1:1', 'Timed out waiting 60000ms from config.webServer.']) {
    assert.equal(clasificar(reporte([{ check: 'axe', res: 'failed', msg }])).global, 'BLOCKED', msg);
  }
});

test('omitida → NOT_CHECKED', () => {
  assert.deepEqual(estados(clasificar(reporte([{ check: 'axe', res: 'skipped', status: 'skipped' }]))), ['NOT_CHECKED']);
});

test('orden del estado global: BLOCKED gana a FAIL y a NOT_CHECKED; FAIL gana a NOT_CHECKED', () => {
  assert.equal(clasificar(reporte([
    { check: 'a', res: 'failed', msg: 'otra cosa' },
    { check: 'b', res: 'failed', msg: "A snapshot doesn't exist" },
    { check: 'c', res: 'failed', msg: 'net::ERR_ABORTED' },
  ])).global, 'BLOCKED');
  assert.equal(clasificar(reporte([
    { check: 'a', res: 'failed', msg: 'otra cosa' },
    { check: 'b', res: 'failed', msg: "A snapshot doesn't exist" },
    { check: 'c', res: 'passed' },
  ])).global, 'FAIL');
});

test('los códigos de color ANSI no rompen la detección', () => {
  const r = clasificar(reporte([{ check: 'captura', res: 'failed', msg: `${ESC}[31mA snapshot doesn't exist${ESC}[39m` }]));
  assert.deepEqual(estados(r), ['NOT_CHECKED']);
});

test('0 pruebas → UNKNOWN; 0 pruebas con el servidor de pruebas caído → BLOCKED', () => {
  assert.equal(clasificar({ suites: [], errors: [] }).global, 'UNKNOWN');
  assert.equal(clasificar({ suites: [], errors: [{ message: 'Error: Timed out waiting 60000ms from config.webServer.' }] }).global, 'BLOCKED');
});

test('ruta, proyecto y nombre del chequeo se extraen', () => {
  const [p] = clasificar(reporte([{ check: 'axe', res: 'passed', proyecto: 'escritorio-1440' }])).pruebas;
  assert.equal(p.ruta, '/');
  assert.equal(p.proyecto, 'escritorio-1440');
  assert.equal(p.check, 'axe');
});

test('línea de comandos: sin datos sale 3 con ESTADO: UNKNOWN; con --json y reporte válido sale 0; sin argumentos, 2', () => {
  const e = entornoTemporal();
  try {
    const inexistente = correr(SCRIPT, [path.join(e.tmp, 'no-existe.json')], { env: e.env, cwd: e.proyecto });
    assert.equal(inexistente.status, 3);
    assert.match(inexistente.stdout, /ESTADO: UNKNOWN/);
    const f = path.join(e.tmp, 'r.json');
    fs.writeFileSync(f, JSON.stringify(reporte([{ check: 'axe', res: 'passed' }])));
    const valido = correr(SCRIPT, [f, '--json'], { env: e.env, cwd: e.proyecto });
    assert.equal(valido.status, 0, valido.stderr);
    assert.equal(valido.json().global, 'PASS');
    const sinArgs = correr(SCRIPT, [], { env: e.env, cwd: e.proyecto });
    assert.equal(sinArgs.status, 2);
    assert.match(sinArgs.stderr, /Uso: node clasificar-resultados\.cjs/);
  } finally { e.limpiar(); }
});
