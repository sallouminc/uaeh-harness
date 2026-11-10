// Pruebas de plugins/uaeh-harness/templates/verify.ps1 y verify.sh: las plantillas de verificacion que la skill de
// preflight le pide al proyecto auditado.
// Qué protege: el contrato de salida (0 = todo paso · 1 = algo fallo · 3 = sin pruebas demostradas, "sin pruebas no es
// verde"), que una comprobacion que falla no detenga a las siguientes, el conteo de pruebas de `node --test` en TAP
// (un archivo vacio cuenta como 1 prueba que pasa y hay que restarlo), el conteo por regex, y la codificacion de los
// archivos (verify.ps1 solo ASCII y sin BOM porque PowerShell 5.1 lee UTF-8 sin BOM como ANSI; verify.sh sin BOM ni CR).
// Cada prueba copia la plantilla a una carpeta temporal y sustituye el bloque entre las marcas por comprobaciones de juguete.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { RAIZ_HARNESS, entornoTemporal, rutaBash } = require('../helpers/entorno.cjs');

const DIR = path.join(RAIZ_HARNESS, 'templates');
const MARCA_ABRE = '# >>> comprobaciones (adapta esto)';
const MARCA_CIERRA = '# <<< comprobaciones';
const leer = (n) => fs.readFileSync(path.join(DIR, n));

// Helper de juguete: `node emite.cjs <codigo> <texto...>` imprime el texto y sale con ese codigo.
const EMITE = "const [c, ...t] = process.argv.slice(2); console.log(t.join(' ')); process.exit(Number(c));\n";
// Sin ruta: desde Node 20 descubre los archivos solo (un glob como argumento no se expande en Node 20).
const TAP = 'node --test --test-reporter=tap';

function omitir(t, motivo) {
  if (process.env.UAEH_CI === '1' || process.env.UAEH_PRUEBAS_ESTRICTO === '1') throw new Error(`prueba omitida en modo estricto: ${motivo}`);
  t.skip(motivo);
}

function sustituir(texto, bloque) {
  const i = texto.indexOf(MARCA_ABRE);
  const j = texto.indexOf(MARCA_CIERRA);
  assert.ok(i >= 0 && j > i, 'la plantilla trae las dos marcas');
  return texto.slice(0, i) + MARCA_ABRE + '\n' + bloque + '\n' + texto.slice(j);
}

// Comprobacion { n: nombre, c: comando, k: conteo opcional } → linea de cada plantilla.
const lineaSh = ({ n, c, k }) => `check ${n} '${c}'${k ? ` '${k}'` : ''}`;
const lineaPs = ({ n, c, k }) => `Invoke-Check '${n}' '${c}'${k ? ` -Count '${k}'` : ''}`;

function prepararProyecto(e, archivos) {
  delete e.env.NODE_TEST_CONTEXT; // si no, el node --test de juguete cree que corre dentro de esta suite y no ejecuta nada
  e.escribir('proyecto/emite.cjs', EMITE);
  for (const [rel, txt] of Object.entries(archivos || {})) e.escribir(path.join('proyecto', rel), txt);
}

const PRUEBAS_2_Y_DESCRIBE = "const { test, describe } = require('node:test');\ntest('a', () => {});\ntest('b', () => {});\n"
  + "describe('d', () => { test('c', () => {}); });\n";

const ok = (n = 'ok') => ({ n, c: 'node emite.cjs 0 todo-bien' });
const mal = (n = 'mal') => ({ n, c: 'node emite.cjs 1 salida-del-fallo' });

// Escenarios comunes: [titulo, archivos, comprobaciones, codigo, [textos que deben aparecer en stdout]]
const ESCENARIOS = [
  ['todo pasa · 0', null, [ok('uno'), ok('dos')], 0, ['CHECK: uno ->', 'todo-bien', 'RESULTADO: PASS']],
  ['una falla y la siguiente igual corre · 1', null, [mal('primero'), ok('segundo')], 1,
    ['CHECK: primero ->', 'salida-del-fallo', 'CHECK: segundo ->', 'todo-bien', 'RESULTADO: FAIL']],
  ['node-tap con solo un archivo vacio · 3', { 'test/vacio.test.js': '' }, [{ n: 'tap', c: TAP, k: 'node-tap' }], 3,
    ['UNKNOWN', 'RESULTADO: UNKNOWN']],
  ['node-tap con 2 pruebas y un describe con 1 (mas un archivo vacio) · 0 y cuenta 3',
    { 'test/dos.test.js': PRUEBAS_2_Y_DESCRIBE, 'test/vacio.test.js': '' }, [{ n: 'tap', c: TAP, k: 'node-tap' }], 0,
    [/tap\s+0\s+3\s+PASS/, 'RESULTADO: PASS']],
  ['regex con "0 passed" · 3', null, [{ n: 'rx', c: 'node emite.cjs 0 0 passed', k: '(\\d+) passed' }], 3, [/rx\s+0\s+0\s+UNKNOWN/]],
  ['regex con "5 passed" · 0', null, [{ n: 'rx', c: 'node emite.cjs 0 5 passed', k: '(\\d+) passed' }], 0, [/rx\s+0\s+5\s+PASS/]],
  ['regex con varias coincidencias · se suman', null,
    [{ n: 'rx', c: 'node emite.cjs 0 12 passed and 3 passed', k: '(\\d+) passed' }], 0, [/rx\s+0\s+15\s+PASS/]],
  ['una falla y otra desconocida · 1 (FAIL domina)', null,
    [{ n: 'rx', c: 'node emite.cjs 0 0 passed', k: '(\\d+) passed' }, mal('cae')], 1, [/rx\s+0\s+0\s+UNKNOWN/, /cae\s+1\s+-\s+FAIL/, 'RESULTADO: FAIL']],
];

function verificar(r, codigo, textos) {
  const salida = (r.stdout || '') + (r.stderr || '');
  assert.equal(r.status, codigo, salida);
  for (const x of textos) {
    if (x instanceof RegExp) assert.match(salida, x);
    else assert.ok(salida.includes(x), `falta «${x}» en la salida:\n${salida}`);
  }
}

// ── Plantillas tal cual ─────────────────────────────────────────────────────────────────────
for (const nombre of ['verify.ps1', 'verify.sh']) {
  test(`${nombre} · trae las dos marcas exactas, una sola vez, y cada una en su propia linea`, () => {
    const lineas = leer(nombre).toString('utf8').split(/\r?\n/);
    assert.equal(lineas.filter((l) => l === MARCA_ABRE).length, 1);
    assert.equal(lineas.filter((l) => l === MARCA_CIERRA).length, 1);
    assert.ok(lineas.length <= 95, `la plantilla debe ser corta (${lineas.length} lineas)`);
  });
}

test('verify.ps1 · 100 % ASCII y sin BOM (PowerShell 5.1 lee UTF-8 sin BOM como ANSI)', () => {
  const b = leer('verify.ps1');
  assert.notDeepEqual([...b.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'sin BOM');
  const malos = [...b].filter((x) => x > 127 || (x < 32 && ![9, 10, 13].includes(x)));
  assert.deepEqual(malos, [], 'solo ASCII');
});

test('verify.sh · sin BOM, sin CR, con shebang de bash y set -u', () => {
  const b = leer('verify.sh');
  assert.notDeepEqual([...b.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'sin BOM');
  assert.equal(b.includes(13), false, 'solo LF');
  const t = b.toString('utf8');
  assert.ok(t.startsWith('#!/usr/bin/env bash\n'));
  assert.match(t, /^set -u$/m);
  assert.doesNotMatch(t, /^set -e/m);
});

// ── verify.sh ───────────────────────────────────────────────────────────────────────────────
function correrSh(t, archivos, comprobaciones) {
  const bash = rutaBash();
  if (!bash) { omitir(t, 'no hay bash disponible'); return null; }
  const e = entornoTemporal('uaeh-verify-sh-');
  try {
    prepararProyecto(e, archivos);
    const txt = sustituir(leer('verify.sh').toString('utf8'), comprobaciones.map(lineaSh).join('\n'));
    const script = path.join(e.proyecto, 'verify.sh');
    fs.writeFileSync(script, txt, 'utf8');
    return spawnSync(bash, [script.replace(/\\/g, '/')], { cwd: e.proyecto, env: e.env, encoding: 'utf8', timeout: 60000 });
  } finally { e.limpiar(); }
}

for (const [titulo, archivos, comprobaciones, codigo, textos] of ESCENARIOS) {
  test(`verify.sh · ${titulo}`, (t) => {
    const r = correrSh(t, archivos, comprobaciones);
    if (r) verificar(r, codigo, textos);
  });
}

test('verify.sh · la plantilla sin sustituir corre y sale con 1 o 3, nunca 0, si el proyecto no tiene package.json', (t) => {
  const bash = rutaBash();
  if (!bash) return omitir(t, 'no hay bash disponible');
  const e = entornoTemporal('uaeh-verify-sh-');
  try {
    const script = path.join(e.proyecto, 'verify.sh');
    fs.copyFileSync(path.join(DIR, 'verify.sh'), script);
    const r = spawnSync(bash, [script.replace(/\\/g, '/')], { cwd: e.proyecto, env: e.env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /CHECK: tests -> npm test/);
    assert.match(r.stdout, /CHECK: lint -> npm run lint/);
  } finally { e.limpiar(); }
});

// ── verify.ps1 (solo Windows: necesita cmd.exe y PowerShell) ─────────────────────────────────
function correrPs(exe, crlf, archivos, comprobaciones) {
  const e = entornoTemporal('uaeh-verify-ps-');
  try {
    prepararProyecto(e, archivos);
    let txt = sustituir(leer('verify.ps1').toString('utf8').replace(/\r\n/g, '\n'), comprobaciones.map(lineaPs).join('\n'));
    if (crlf) txt = txt.replace(/\n/g, '\r\n');
    const script = path.join(e.proyecto, 'verify.ps1');
    fs.writeFileSync(script, txt, 'utf8');
    return spawnSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: e.proyecto, env: e.env, encoding: 'utf8', timeout: 60000 });
  } finally { e.limpiar(); }
}

// Fuera de Windows estas pruebas ni se registran (como las demás suites solo de Windows): una omitida esperada en cada
// corrida de Linux taparía las omitidas que sí son señal.
if (process.platform === 'win32') {
  const hayPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' }).status === 0;
  const MOTOR = [['powershell.exe', true]];
  if (hayPwsh) MOTOR.push(['pwsh', false]);

  for (const [exe, crlf] of MOTOR) {
    ESCENARIOS.forEach(([titulo, archivos, comprobaciones, codigo, textos], i) => {
      // Con pwsh (LF) solo los dos primeros escenarios, para no alargar la batería.
      if (!crlf && i > 1) return;
      test(`verify.ps1 (${exe}${crlf ? ', CRLF' : ', LF'}) · ${titulo}`, () => {
        verificar(correrPs(exe, crlf, archivos, comprobaciones), codigo, textos);
      });
    });
  }

  test('verify.ps1 (powershell.exe, LF) · la plantilla funciona con fin de linea LF', () => {
    verificar(correrPs('powershell.exe', false, null, [{ n: 'rx', c: 'node emite.cjs 0 5 passed', k: '(\\d+) passed' }, mal('cae')]), 1,
      [/rx\s+0\s+5\s+PASS/, /cae\s+1\s+-\s+FAIL/]);
  });
}
