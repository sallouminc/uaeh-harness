// Pruebas de plugins/uaeh-harness/hooks/linea-inicio.cjs (SessionStart informativo).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, correr, git, repoTemporal, RAIZ_HARNESS } = require('../helpers/entorno.cjs');

const HOOK = path.join(RAIZ_HARNESS, 'hooks', 'linea-inicio.cjs');
const HUELLA = path.join(RAIZ_HARNESS, 'scripts', 'uaeh-huella.cjs');
const VERSION = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'comun.cjs')).versionPlugin();

function conCasa(fn) {
  const e = entornoTemporal('uaeh-linea-');
  try { return fn(e); } finally { e.limpiar(); }
}

function lanzar(e, stdin = { source: 'startup', session_id: 'abc' }) {
  const r = correr(HOOK, [], { stdin, env: e.env, cwd: e.proyecto });
  assert.equal(r.status, 0, r.stderr);
  const json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return { r, json, texto: json ? json.hookSpecificOutput.additionalContext : '' };
}

function espejoCon(e, version) {
  const espejo = path.join(e.uaehHome, 'estable', 'uaeh-harness');
  fs.mkdirSync(espejo, { recursive: true });
  fs.writeFileSync(path.join(espejo, 'VERSION'), `${version}\n`, 'utf8');
  return espejo;
}

test('sin espejo: una línea que dice cómo instalar la guarda, en formato hookSpecificOutput', () => conCasa((e) => {
  const { json, texto } = lanzar(e);
  assert.equal(json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(texto, /guarda de git no está instalada/);
  assert.match(texto, /instalar\.cjs" git-guard --aplicar/);
  assert.ok(texto.includes(`v${VERSION}`));
  assert.ok(!texto.includes('\\'), 'las rutas van con /');
}));

test('espejo con otra versión: avisa y pide actualizar; con la misma versión y config sana: silencio total', () => conCasa((e) => {
  espejoCon(e, '0.0.0-vieja');
  const viejo = lanzar(e);
  assert.match(viejo.texto, /v0\.0\.0-vieja/);
  assert.match(viejo.texto, /plugin en v/);
  assert.match(viejo.texto, /git-guard --aplicar/);
  espejoCon(e, VERSION);
  const alDia = lanzar(e);
  assert.equal(alDia.json, null);
  assert.equal(alDia.r.stdout, '');
}));

test('avisos de uaeh.config.json se resumen (máximo 3) y se suman a la línea', () => conCasa((e) => {
  espejoCon(e, VERSION);
  fs.writeFileSync(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ a: 1, b: 2, c: 3, d: 4, commits: { credito: 'x' } }), 'utf8');
  const { texto } = lanzar(e);
  assert.match(texto, /uaeh\.config\.json tiene avisos/);
  assert.match(texto, /y \d+ más/);
  assert.equal(texto.split('\n').length, 1);
}));

test('preflight: sin sello calla; con sello da su estado en una línea (vigente → no repetir; cambió auth → incremental)', () => conCasa((e) => {
  espejoCon(e, VERSION);
  const repo = repoTemporal(e, 'proyecto-con-sello');
  const enRepo = (extra = {}) => {
    const r = correr(HOOK, [], { stdin: { source: 'startup', cwd: repo, ...extra }, env: e.env, cwd: repo });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
  };
  assert.equal(enRepo(), '', 'repo sin sello: el preflight es bajo pedido, la línea calla');

  const s = correr(HUELLA, ['sellar', repo, '--tipo', 'completa', '--riesgo', 'medio'], { env: e.env, cwd: repo });
  assert.equal(s.status, 0, s.stderr);
  git(repo, ['add', 'docs'], e.env);
  git(repo, ['commit', '-q', '-m', 'sello'], e.env);
  const vigente = enRepo();
  assert.match(vigente, /^UAEH: preflight vigente del .+ en proyecto-con-sello\. NO repetir\.$/);
  assert.equal(vigente.split('\n').length, 1);

  fs.mkdirSync(path.join(repo, 'src', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'auth', 'login.js'), 'module.exports = {};\n', 'utf8');
  git(repo, ['add', 'src'], e.env);
  git(repo, ['commit', '-q', '-m', 'auth'], e.env);
  assert.match(enRepo(), /cambió auth → preflight INCREMENTAL solo de eso \(git diff [0-9a-f]+\.\.HEAD\)/);
  assert.match(enRepo({ source: 'clear' }), /preflight INCREMENTAL/, 'tras /clear el modelo empieza sin contexto: vuelve a decirlo');
  assert.equal(enRepo({ source: 'compact' }), '', 'al compactar calla');
}));

test('solo habla en el arranque real y tras /clear: en compact/resume calla aunque falte el espejo; stdin vacío o roto no rompe', () => conCasa((e) => {
  assert.equal(lanzar(e, { source: 'compact' }).json, null);
  assert.equal(lanzar(e, { source: 'resume' }).json, null);
  assert.match(lanzar(e, { source: 'clear' }).texto, /guarda de git no está instalada/);
  assert.ok(lanzar(e, {}).json, 'sin source se asume arranque');
  const roto = correr(HOOK, [], { stdin: '{{{', env: e.env, cwd: e.proyecto });
  assert.equal(roto.status, 0);
  const vacio = correr(HOOK, [], { stdin: '', env: e.env, cwd: e.proyecto });
  assert.equal(vacio.status, 0);
  assert.ok(vacio.stdout.trim(), 'stdin vacío = arranque: avisa que falta el espejo');
}));
