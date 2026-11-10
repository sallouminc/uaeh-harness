// Pruebas de plugins/uaeh-harness/scripts/uaeh-ignorar.cjs — el ritual que mantiene la evidencia local fuera de git.
// Repos temporales con el git real; nunca tocan un repo del usuario.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { RAIZ_HARNESS, entornoTemporal, correr, repoTemporal } = require('../helpers/entorno.cjs');

const CLI = path.join(RAIZ_HARNESS, 'scripts', 'uaeh-ignorar.cjs');
const { REGLAS, LINEAS, MARCA, agregar, faltantes } = require(CLI);

function conRepo(fn) {
  const e = entornoTemporal('uaeh-ignorar-');
  try { return fn(e, repoTemporal(e)); } finally { e.limpiar(); }
}
const ignorar = (e, args) => correr(CLI, args, { env: e.env, cwd: e.dir });
function gitIgnora(e, repo, muestra) {
  return spawnSync('git', ['-C', repo, 'check-ignore', '-q', '--no-index', muestra], { env: e.env }).status === 0;
}

test('fuera de un repo git · código 2 y lo explica', () => conRepo((e) => {
  const r = ignorar(e, ['--repo', e.proyecto]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no es un repositorio git/);
}));

test('en seco · lista las 8 líneas que faltan, código 1 y no crea el .gitignore', () => conRepo((e, repo) => {
  const r = ignorar(e, ['--repo', repo]);
  assert.equal(r.status, 1, r.stderr);
  for (const l of LINEAS) assert.ok(r.stdout.includes(`+ ${l}`), l);
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false);
}));

test('--aplicar · agrega las líneas bajo la marca y git ignora cada tipo de evidencia', () => conRepo((e, repo) => {
  for (const [, muestra] of REGLAS) assert.equal(gitIgnora(e, repo, muestra), false, `antes no se ignora: ${muestra}`);
  const r = ignorar(e, ['--repo', repo, '--aplicar']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK: git ignora los 8 tipos de evidencia/);
  const texto = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.ok(texto.startsWith(MARCA));
  assert.deepEqual(faltantes(texto), []);
  for (const [, muestra] of REGLAS) assert.equal(gitIgnora(e, repo, muestra), true, `después se ignora: ${muestra}`);
}));

test('idempotente · la segunda vez no cambia ni un byte y en seco da 0', () => conRepo((e, repo) => {
  assert.equal(ignorar(e, ['--repo', repo, '--aplicar']).status, 0);
  const antes = fs.readFileSync(path.join(repo, '.gitignore'));
  const r = ignorar(e, ['--repo', repo, '--aplicar']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sin cambios/);
  assert.ok(fs.readFileSync(path.join(repo, '.gitignore')).equals(antes));
  assert.equal(ignorar(e, ['--repo', repo]).status, 0, 'en seco, sin nada que agregar');
}));

test('un .gitignore existente en CRLF y sin salto final · conserva lo suyo, agrega solo lo que falta y sigue en CRLF', () => conRepo((e, repo) => {
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\r\ntest-results/\r\n.playwright/');
  const r = ignorar(e, ['--repo', repo, '--aplicar']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const texto = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.ok(texto.startsWith('node_modules/\r\ntest-results/\r\n.playwright/\r\n'));
  assert.equal(texto.split('test-results/').length - 1, 1, 'no repite una línea que ya estaba');
  assert.equal(/[^\r]\n/.test(texto), false, 'todos los saltos quedan en CRLF');
  assert.match(r.stdout, /agregadas 6 línea/);
}));

test('--local --docs-harness · repo de un cliente: docs/harness/ del preflight queda en el clon, además de la evidencia', () => conRepo((e, repo) => {
  const muestra = 'docs/harness/AUDIT_REPORT.md';
  assert.equal(gitIgnora(e, repo, muestra), false, 'control: sin la opción, docs/harness/ entra al repo');
  const seco = ignorar(e, ['--repo', repo, '--local', '--docs-harness']);
  assert.equal(seco.status, 1);
  assert.match(seco.stdout, /\+ docs\/harness\//);
  const r = ignorar(e, ['--repo', repo, '--local', '--docs-harness', '--aplicar']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`OK: git ignora los ${REGLAS.length + 1} tipos de evidencia`));
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false, 'nunca toca el .gitignore de un repo ajeno');
  assert.equal(gitIgnora(e, repo, muestra), true);
  for (const [, m] of REGLAS) assert.equal(gitIgnora(e, repo, m), true, m);
  const exclude = path.join(repo, '.git', 'info', 'exclude');
  const antes = fs.readFileSync(exclude);
  assert.equal(ignorar(e, ['--repo', repo, '--local', '--docs-harness', '--aplicar']).status, 0);
  assert.ok(fs.readFileSync(exclude).equals(antes), 'idempotente');
  // Sin la opción, el ritual de siempre sigue igual: no exige docs/harness/ ni lo agrega.
  assert.equal(ignorar(e, ['--repo', repo, '--local']).status, 0);
}));

test('sin --docs-harness · docs/harness/ no se ignora (en un proyecto propio esos documentos van al repo)', () => conRepo((e, repo) => {
  assert.equal(ignorar(e, ['--repo', repo, '--aplicar']).status, 0);
  assert.ok(!fs.readFileSync(path.join(repo, '.gitignore'), 'utf8').includes('docs/harness'));
  assert.equal(gitIgnora(e, repo, 'docs/harness/AUDIT_REPORT.md'), false);
}));

test('--local · usa .git/info/exclude del clon y no toca el .gitignore', () => conRepo((e, repo) => {
  const r = ignorar(e, ['--repo', repo, '--local', '--aplicar']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false);
  assert.deepEqual(faltantes(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')), []);
  for (const [, muestra] of REGLAS) assert.equal(gitIgnora(e, repo, muestra), true, muestra);
}));

test('desde una subcarpeta · trabaja sobre la raíz del repo', () => conRepo((e, repo) => {
  const sub = path.join(repo, 'src', 'modulo');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(ignorar(e, ['--repo', sub, '--aplicar']).status, 0);
  assert.ok(fs.existsSync(path.join(repo, '.gitignore')));
  assert.equal(fs.existsSync(path.join(sub, '.gitignore')), false);
}));

test('otra regla que des-ignora (un .gitignore más profundo) · código 1 y nombra la evidencia expuesta', () => conRepo((e, repo) => {
  fs.mkdirSync(path.join(repo, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'reports', '.gitignore'), '!visual-audit/\n');
  const r = ignorar(e, ['--repo', repo, '--aplicar']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /git todavía NO ignora/);
  assert.match(r.stdout, /reports\/visual-audit\//);
}));

test('agregar() · texto vacío sin línea en blanco inicial; marca una sola vez', () => {
  const t1 = agregar('', ['a/', 'b/']);
  assert.equal(t1, `${MARCA}\na/\nb/\n`);
  const t2 = agregar(t1, ['c/']);
  assert.equal(t2.split(MARCA).length - 1, 1);
  assert.ok(t2.endsWith('\nc/\n'));
});

test('uso incorrecto · código 64', () => conRepo((e, repo) => {
  for (const args of [['--raro'], ['--repo'], ['--repo', '--aplicar']]) {
    const r = ignorar(e, args);
    assert.equal(r.status, 64, args.join(' '));
    assert.match(r.stderr, /uso: uaeh-ignorar\.cjs/);
  }
  void repo;
}));
