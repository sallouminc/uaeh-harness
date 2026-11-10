// Pruebas de plugins/uaeh-harness/scripts/uaeh-runs.cjs — retención de las corridas de la puerta de seguridad.
// Herméticas: la base vive en la casa temporal y la fecha "de hoy" es UAEH_AHORA (2026-10-30).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_HARNESS, entornoTemporal, correr } = require('../helpers/entorno.cjs');

const CLI = path.join(RAIZ_HARNESS, 'scripts', 'uaeh-runs.cjs');
const runs = require(CLI);
const HOY = new Date('2026-10-30T20:00:00Z');
const DIA = 86400000;

function conEntorno(fn) {
  const e = entornoTemporal('uaeh-runs-');
  try { return fn(e); } finally { e.limpiar(); }
}
const cli = (e, args) => correr(CLI, args, { env: e.env, cwd: e.dir });

function escribir(ruta, texto = 'x'.repeat(100)) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, texto, 'utf8');
}

// Corrida sintética con la evidencia y las copias pesadas; su fecha sale de run-metadata.json (hace `dias` días).
function crearRun(base, repo, nombre, dias, { pesadas = true, metadata = true } = {}) {
  const d = path.join(base, repo, nombre);
  escribir(path.join(d, 'findings.json'), '{"findings":[]}');
  escribir(path.join(d, 'REPORT.md'), '# informe');
  escribir(path.join(d, 'coverage-ledger.json'), '{}');
  escribir(path.join(d, 'codex', 'hallazgos.json'), '[]');
  escribir(path.join(d, 'codex', 'resumen.json'), '{}');
  escribir(path.join(d, 'artifacts', 'a.txt'));
  escribir(path.join(d, 'deterministico', 'salida.txt'));
  if (pesadas) {
    escribir(path.join(d, 'fuente', 'src', 'a.js'), 'a'.repeat(1000));
    escribir(path.join(d, 'fuente-base', 'src', 'a.js'), 'b'.repeat(1000));
    escribir(path.join(d, 'cambiados', 'a.js'), 'c'.repeat(1000));
    escribir(path.join(d, 'codex', 'eventos.jsonl'), 'e'.repeat(1000));
    escribir(path.join(d, 'agents', 'ag1', 'scratch', 'tmp.txt'), 's'.repeat(1000));
    escribir(path.join(d, 'agents', 'ag1', 'informe.md'), 'informe');
  }
  if (metadata) {
    const meta = path.join(d, 'run-metadata.json');
    escribir(meta, '{}');
    const t = new Date(HOY.getTime() - dias * DIA);
    fs.utimesSync(meta, t, t);
  }
  return d;
}

// Listado ordenado con tamaños y contenido de todo el árbol (sin seguir enlaces).
function foto(raiz) {
  const out = [];
  (function rec(p) {
    for (const n of fs.readdirSync(p).sort()) {
      const q = path.join(p, n);
      const s = fs.lstatSync(q);
      if (s.isSymbolicLink()) out.push(`L ${path.relative(raiz, q)}`);
      else if (s.isDirectory()) { out.push(`D ${path.relative(raiz, q)}`); rec(q); } else out.push(`F ${path.relative(raiz, q)} ${s.size} ${fs.readFileSync(q, 'utf8').length}`);
    }
  })(raiz);
  return out;
}

function escenario(e) {
  const base = path.join(e.dir, 'runs');
  // r1..r3 recientes-ish; r4 (60 d) compactar; r5 (400 d) borrar; r6 (10 d) fresca
  crearRun(base, 'repo', 'run-1', 400);
  crearRun(base, 'repo', 'run-2', 60);
  crearRun(base, 'repo', 'run-3', 45);
  crearRun(base, 'repo', 'run-4', 20);
  crearRun(base, 'repo', 'run-5', 10);
  crearRun(base, 'repo', 'run-6', 5);
  escribir(path.join(base, 'repo', 'estado-hallazgos.json'), '{"a":1}');
  escribir(path.join(base, 'repo', 'codex.log'), 'log');
  escribir(path.join(base, 'repo', 'run-7.codex.log'), 'log');
  escribir(path.join(base, 'repo', 'notas', 'nota.txt'), 'nota');
  escribir(path.join(base, 'repo', 'run-x', 'fuente', 'a.js'), 'x');
  return base;
}
const accionesDe = (j) => Object.fromEntries(j.repos.flatMap((r) => r.runs.map((x) => [x.nombre, x.accion])));

test('plan · las 3 más recientes se conservan aunque sean viejas; el resto compacta o borra según la edad', () => conEntorno((e) => {
  const base = escenario(e);
  const r = cli(e, ['listar', '--base', base, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(accionesDe(r.json()), {
    'run-1': 'borrar', 'run-2': 'compactar', 'run-3': 'compactar', 'run-4': 'conservar', 'run-5': 'conservar', 'run-6': 'conservar',
  });
}));

test('las 3 más recientes se conservan aunque tengan más de 365 días', () => conEntorno((e) => {
  const base = path.join(e.dir, 'runs');
  crearRun(base, 'viejo', 'run-1', 900);
  crearRun(base, 'viejo', 'run-2', 800);
  crearRun(base, 'viejo', 'run-3', 700);
  const r = cli(e, ['limpiar', '--base', base, '--aplicar', '--json']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json().acciones, []);
  assert.ok(fs.existsSync(path.join(base, 'viejo', 'run-1', 'fuente', 'src', 'a.js')));
}));

test('--aplicar · compactar borra solo las partes pesadas y conserva la evidencia; borrar quita la carpeta; lo ajeno queda intacto', () => conEntorno((e) => {
  const base = escenario(e);
  const ajenoAntes = ['estado-hallazgos.json', 'codex.log', 'run-7.codex.log', 'notas/nota.txt', 'run-x/fuente/a.js'].map((f) => fs.readFileSync(path.join(base, 'repo', f), 'utf8'));
  const r = cli(e, ['limpiar', '--base', base, '--aplicar']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /HECHO compactar repo\/run-2/);
  assert.match(r.stdout, /HECHO borrar repo\/run-1/);
  assert.match(r.stdout, /docker volume ls/);
  assert.equal(fs.existsSync(path.join(base, 'repo', 'run-1')), false);
  const d = path.join(base, 'repo', 'run-2');
  for (const gone of ['fuente', 'fuente-base', 'cambiados', 'codex/eventos.jsonl', 'agents/ag1/scratch']) assert.equal(fs.existsSync(path.join(d, gone)), false, gone);
  for (const keep of ['findings.json', 'REPORT.md', 'coverage-ledger.json', 'codex/hallazgos.json', 'codex/resumen.json', 'artifacts/a.txt', 'deterministico/salida.txt', 'agents/ag1/informe.md', 'run-metadata.json']) assert.ok(fs.existsSync(path.join(d, keep)), keep);
  const c = JSON.parse(fs.readFileSync(path.join(d, 'compactado.json'), 'utf8'));
  assert.ok(c.borrado.includes('fuente') && c.borrado.includes('codex/eventos.jsonl') && c.borrado.includes('agents/ag1/scratch'));
  assert.ok(c.bytes_liberados >= 5000);
  // las frescas conservan todo
  assert.ok(fs.existsSync(path.join(base, 'repo', 'run-4', 'fuente', 'src', 'a.js')));
  const ajenoDespues = ['estado-hallazgos.json', 'codex.log', 'run-7.codex.log', 'notas/nota.txt', 'run-x/fuente/a.js'].map((f) => fs.readFileSync(path.join(base, 'repo', f), 'utf8'));
  assert.deepEqual(ajenoDespues, ajenoAntes);
}));

test('en seco no cambia ni un byte', () => conEntorno((e) => {
  const base = escenario(e);
  const antes = foto(base);
  const r = cli(e, ['limpiar', '--base', base]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /HARÍA compactar repo\/run-2/);
  assert.match(r.stdout, /HARÍA borrar repo\/run-1/);
  assert.deepEqual(foto(base), antes);
}));

test('--aplicar dos veces es idempotente y compactado.json conserva la fecha original', () => conEntorno((e) => {
  const base = escenario(e);
  assert.equal(cli(e, ['limpiar', '--base', base, '--aplicar']).status, 0);
  const cj = path.join(base, 'repo', 'run-2', 'compactado.json');
  const fecha = JSON.parse(fs.readFileSync(cj, 'utf8')).fecha_corrida;
  assert.ok(Math.abs(Date.parse(fecha) - (HOY.getTime() - 60 * DIA)) < 2000, fecha);
  const antes = foto(base);
  const r = cli(e, ['limpiar', '--base', base, '--aplicar', '--json']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json().acciones, []);
  assert.deepEqual(foto(base), antes);
  // la fecha sale de compactado.json aunque el mtime de run-metadata cambie
  const meta = path.join(base, 'repo', 'run-2', 'run-metadata.json');
  fs.utimesSync(meta, HOY, HOY);
  const lista = cli(e, ['listar', '--base', base, '--json']).json();
  const run2 = lista.repos[0].runs.find((x) => x.nombre === 'run-2');
  assert.equal(run2.completa, false);
  assert.ok(Math.abs(Date.parse(run2.fecha) - Date.parse(fecha)) < 2000);
}));

test('una corrida compactada que cumple 365 días se borra', () => conEntorno((e) => {
  const base = path.join(e.dir, 'runs');
  const viejo = crearRun(base, 'r', 'run-1', 100);
  for (let i = 2; i <= 4; i++) crearRun(base, 'r', `run-${i}`, 1);
  escribir(path.join(viejo, 'compactado.json'), JSON.stringify({ fecha_corrida: '2025-01-01T00:00:00Z', borrado: [], bytes_liberados: 0 }));
  const r = cli(e, ['limpiar', '--base', base, '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(fs.existsSync(viejo), false);
}));

test('nombres con sufijo (run-1-f3g-diff) cuentan como corridas; run-x y archivos sueltos no', () => conEntorno((e) => {
  const base = path.join(e.dir, 'runs');
  crearRun(base, 'r', 'run-1-f3g-diff', 100);
  crearRun(base, 'r', 'run-2-f5c-diff', 100);
  crearRun(base, 'r', 'run-3', 100);
  crearRun(base, 'r', 'run-4', 100);
  escribir(path.join(base, 'r', 'run-x', 'fuente', 'a.js'));
  escribir(path.join(base, 'r', 'run-9.codex.log'), 'l');
  const j = cli(e, ['listar', '--base', base, '--json']).json();
  assert.deepEqual(j.repos[0].runs.map((x) => x.nombre).sort(), ['run-1-f3g-diff', 'run-2-f5c-diff', 'run-3', 'run-4']);
  assert.equal(accionesDe(j)['run-1-f3g-diff'], 'compactar');
}));

test('base peligrosa · la casa, uaehHome y la raíz dan código 1 sin tocar nada', () => conEntorno((e) => {
  escribir(path.join(e.home, 'repo', 'run-1', 'fuente', 'a.js'));
  const antes = foto(e.home);
  for (const base of [e.home, e.uaehHome, e.claudeHome, path.parse(e.dir).root]) {
    const r = cli(e, ['limpiar', '--base', base, '--aplicar']);
    assert.equal(r.status, 1, `${base}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /base rechazada/);
  }
  assert.deepEqual(foto(e.home), antes);
  assert.equal(runs.basePeligrosa(path.join(e.dir, 'runs')), null);
}));

test('base inexistente · código 0 con «sin corridas»', () => conEntorno((e) => {
  const r = cli(e, ['tamano', '--base', path.join(e.dir, 'no-existe')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sin corridas/);
}));

test('un enlace o unión dentro de fuente/ hacia FUERA de la base: tras compactar el destino sigue intacto', () => conEntorno((e) => {
  const base = path.join(e.dir, 'runs');
  const fuera = path.join(e.dir, 'fuera');
  escribir(path.join(fuera, 'importante.txt'), 'no me toques');
  const d = crearRun(base, 'r', 'run-1', 100);
  for (let i = 2; i <= 4; i++) crearRun(base, 'r', `run-${i}`, 1);
  try { fs.symlinkSync(fuera, path.join(d, 'fuente', 'enlace'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (err) {
    if (process.env.UAEH_CI === '1') throw err;
    return; // sin permiso para crear enlaces en este equipo
  }
  const medido = runs.inventario(base);
  assert.ok(medido.bytes < 100000, 'el tamaño no atraviesa el enlace');
  const r = cli(e, ['limpiar', '--base', base, '--aplicar']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(d, 'fuente')), false);
  assert.equal(fs.readFileSync(path.join(fuera, 'importante.txt'), 'utf8'), 'no me toques');
  // y también al borrar la carpeta entera
  const d2 = crearRun(base, 'r2', 'run-1', 500);
  for (let i = 2; i <= 4; i++) crearRun(base, 'r2', `run-${i}`, 1);
  fs.symlinkSync(fuera, path.join(d2, 'fuente', 'enlace'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(cli(e, ['limpiar', '--base', base, '--aplicar']).status, 0);
  assert.equal(fs.existsSync(d2), false);
  assert.equal(fs.readFileSync(path.join(fuera, 'importante.txt'), 'utf8'), 'no me toques');
}));

test('presupuestoMs: 0 · devuelve lo medido con cortado:true', () => conEntorno((e) => {
  const base = escenario(e);
  const inv = runs.inventario(base, { presupuestoMs: 0 });
  assert.equal(inv.cortado, true);
  const completo = runs.inventario(base);
  assert.equal(completo.cortado, false);
  assert.ok(completo.bytes > inv.bytes);
}));

test('tamano · total por repo y AVISO al pasar de avisoGB; --json parsea', () => conEntorno((e) => {
  const base = escenario(e);
  const r = cli(e, ['tamano', '--base', base]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /TOTAL: /);
  assert.doesNotMatch(r.stdout, /AVISO/);
  const j = cli(e, ['tamano', '--base', base, '--json']).json();
  assert.ok(j && j.bytes > 0 && j.superaAviso === false && j.aplicado === false && j.codigo === 0);
  assert.equal(runs.inventario(base, { retencion: { avisoGB: 0 } }).superaAviso, true);
}));

test('uso incorrecto · orden o argumento desconocido da 2; --aplicar solo en limpiar', () => conEntorno((e) => {
  assert.equal(cli(e, []).status, 2);
  assert.equal(cli(e, ['borrar-todo']).status, 2);
  assert.equal(cli(e, ['listar', '--raro']).status, 2);
  assert.equal(cli(e, ['listar', '--aplicar']).status, 2);
  assert.equal(cli(e, ['listar', '--base']).status, 2);
}));

test('legibleBytes', () => {
  assert.equal(runs.legibleBytes(0), '0 B');
  assert.equal(runs.legibleBytes(1536), '1.5 KB');
  assert.equal(runs.legibleBytes(5 * 1024 ** 3), '5.0 GB');
});
