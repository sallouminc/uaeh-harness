// Pruebas de plugins/uaeh-kit/scripts/lib/comun.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { entornoTemporal, RAIZ_KIT } = require('../helpers/entorno.cjs');

const LIB = path.join(RAIZ_KIT, 'scripts', 'lib', 'comun.cjs');

// Recarga la biblioteca con un env dado (las rutas se resuelven al llamar, no al cargar).
function conEnv(env, fn) {
  const previo = { ...process.env };
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(require(LIB)); } finally {
    for (const k of Object.keys(process.env)) if (!(k in previo)) delete process.env[k];
    Object.assign(process.env, previo);
  }
}

test('claudeHome respeta CLAUDE_CONFIG_DIR y uaehHome respeta UAEH_HOME', () => {
  const e = entornoTemporal();
  try {
    conEnv(e.env, (c) => {
      assert.equal(c.claudeHome(), e.claudeHome);
      assert.equal(c.uaehHome(), e.uaehHome);
      assert.equal(c.estableDir(), path.join(e.uaehHome, 'estable'));
    });
    const sinUaeh = { ...e.env }; delete sinUaeh.UAEH_HOME;
    conEnv(sinUaeh, (c) => assert.equal(c.uaehHome(), path.join(e.claudeHome, 'uaeh')));
    const sinNada = { ...e.env }; delete sinNada.UAEH_HOME; delete sinNada.CLAUDE_CONFIG_DIR;
    conEnv(sinNada, (c) => {
      assert.equal(c.claudeHome(), path.join(e.home, '.claude'));
      assert.equal(c.uaehHome(), path.join(e.home, '.claude', 'uaeh'));
    });
  } finally { e.limpiar(); }
});

test('ahora() obedece a UAEH_AHORA y la ignora si no parsea', () => {
  conEnv({ ...process.env, UAEH_AHORA: '2026-03-01T12:00:00Z' }, (c) => assert.equal(c.ahora().toISOString(), '2026-03-01T12:00:00.000Z'));
  conEnv({ ...process.env, UAEH_AHORA: 'no-es-fecha' }, (c) => assert.ok(Math.abs(c.ahora().getTime() - Date.now()) < 5000));
});

test('isoZona: zona fija, horario de verano e invierno, y UAEH_TZ manda sobre la config', () => {
  const t = new Date('2026-07-01T12:00:00Z');
  const w = new Date('2026-01-15T12:00:00Z');
  const sin = { ...process.env }; delete sin.UAEH_TZ;
  conEnv(sin, (c) => {
    assert.equal(c.isoZona(t, 'America/Bogota'), '2026-07-01T07:00:00-05:00');   // zona sin horario de verano
    assert.equal(c.isoZona(w, 'America/Bogota'), '2026-01-15T07:00:00-05:00');
    assert.equal(c.isoZona(t, 'Europe/Madrid'), '2026-07-01T14:00:00+02:00');
    assert.equal(c.isoZona(w, 'Europe/Madrid'), '2026-01-15T13:00:00+01:00');
    assert.equal(c.isoZona(t, 'Asia/Kolkata'), '2026-07-01T17:30:00+05:30');
    assert.equal(c.isoZona(t, 'UTC'), '2026-07-01T12:00:00+00:00');
    assert.equal(c.legibleZona(t, 'Europe/Madrid'), '2026-07-01 14:00 (Europe/Madrid)');
    assert.equal(c.zonaHoraria({ zonaHoraria: 'Europe/Madrid' }), 'Europe/Madrid');
    assert.ok(c.zonaValida(c.zonaHoraria({ zonaHoraria: 'Marte/Olympus' })), 'zona inválida cae a la del sistema');
  });
  conEnv({ ...process.env, UAEH_TZ: 'Asia/Tokyo' }, (c) => {
    assert.equal(c.zonaHoraria({ zonaHoraria: 'Europe/Madrid' }), 'Asia/Tokyo');
    assert.equal(c.isoZona(t), '2026-07-01T21:00:00+09:00');
  });
});

test('zonaHoraria sin argumento lee uaeh.config.json (en un proceso con la casa temporal); con null solo mira entorno y sistema', () => {
  const e = entornoTemporal();
  try {
    fs.mkdirSync(e.uaehHome, { recursive: true });
    fs.writeFileSync(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ zonaHoraria: 'Asia/Tokyo' }), 'utf8');
    const env = { ...e.env }; delete env.UAEH_TZ;
    const codigo = `const c = require(${JSON.stringify(LIB)}); const t = new Date('2026-07-01T12:00:00Z');` +
      'process.stdout.write(JSON.stringify([c.zonaHoraria(), c.isoZona(t), c.legibleZona(t), c.zonaHoraria(null) === "Asia/Tokyo"]))';
    const r = spawnSync(process.execPath, ['-e', codigo], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const [zona, iso, legible, nullLeeConfig] = JSON.parse(r.stdout);
    assert.equal(zona, 'Asia/Tokyo');
    assert.equal(iso, '2026-07-01T21:00:00+09:00');
    assert.equal(legible, '2026-07-01 21:00 (Asia/Tokyo)');
    // con null no se lee la config: cae a la zona del sistema (solo coincidiría si el sistema estuviera en Tokio)
    assert.equal(nullLeeConfig, Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Tokyo');
  } finally { e.limpiar(); }
});

test('cargarConfig: sin archivo → defectos; roto → defectos + aviso; claves desconocidas → aviso; fusión profunda', () => {
  const e = entornoTemporal();
  try {
    conEnv(e.env, (c) => {
      let r = c.cargarConfig();
      assert.equal(r.existe, false);
      assert.equal(r.config.reglas.inyectar, true);
      assert.equal(r.config.statusline.estadoClaude, false);
      assert.equal(c.idioma(r.config), 'es');

      e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), '{ esto no es json');
      r = c.cargarConfig();
      assert.equal(r.existe, true);
      assert.equal(r.config.reglas.inyectar, true);
      assert.match(r.avisos.join('\n'), /no parsea/);

      e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({
        idioma: 'en', zonaHoraria: 'Europe/Madrid', reglas: { inyectar: false }, statusline: { estadoClaude: true },
        rara: 1, codex: { habilitado: true },
      }));
      r = c.cargarConfig();
      assert.equal(c.idioma(r.config), 'en');
      assert.equal(r.config.reglas.inyectar, false);
      assert.equal(r.config.statusline.estadoClaude, true);
      assert.equal(r.config.statusline.guardarLimites, false, 'la fusión conserva los defectos no pisados');
      assert.equal(r.config.codex.habilitado, true, 'las claves de otras capas se conservan');
      assert.match(r.avisos.join('\n'), /clave desconocida.*"rara"/);

      e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ idioma: 'fr', zonaHoraria: 'Marte/Olympus' }));
      r = c.cargarConfig();
      assert.equal(r.config.idioma, 'auto');
      assert.equal(r.config.zonaHoraria, '');
      assert.equal(r.avisos.length, 2);
    });
  } finally { e.limpiar(); }
});

test('bloqueUaeh detecta marcadores y versión; claudeMdDelProyecto sube sin pasar por la casa', () => {
  const e = entornoTemporal();
  try {
    conEnv(e.env, (c) => {
      assert.deepEqual(c.bloqueUaeh('x'), { presente: false, version: null });
      assert.deepEqual(c.bloqueUaeh('<!-- UAEH:BEGIN v0.1.0 -->\nreglas\n<!-- UAEH:END -->'), { presente: true, version: '0.1.0' });
      assert.deepEqual(c.bloqueUaeh('<!-- UAEH:BEGIN -->\nreglas\n<!-- UAEH:END -->'), { presente: true, version: null });
      assert.deepEqual(c.bloqueUaeh('<!-- UAEH:BEGIN v1 -->\nsin fin'), { presente: false, version: null });

      const anidado = path.join(e.proyecto, 'app', 'src');
      e.escribir(path.join(e.proyecto, 'CLAUDE.md'), '# raíz');
      e.escribir(path.join(e.proyecto, 'app', 'CLAUDE.md'), '# app');
      e.escribir(path.join(e.dir, 'CLAUDE.md'), '# ancestro: Claude Code también lo carga');
      e.escribir(path.join(e.home, 'CLAUDE.md'), '# rama hermana: no debe aparecer');
      require('fs').mkdirSync(anidado, { recursive: true });
      const lista = c.claudeMdDelProyecto(anidado, { tope: e.dir });
      assert.deepEqual(lista, [path.join(e.proyecto, 'app', 'CLAUDE.md'), path.join(e.proyecto, 'CLAUDE.md'), path.join(e.dir, 'CLAUDE.md')]);
      const sinTope = c.claudeMdDelProyecto(anidado);
      assert.deepEqual(sinTope.slice(0, 3), lista, 'sin tope sigue subiendo hasta la raíz del disco');
    });
  } finally { e.limpiar(); }
});

test('salidaHook arma el único formato que Claude Code inyecta', () => {
  const c = require(LIB);
  assert.deepEqual(c.salidaHook('SessionStart', 'hola'), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hola' } });
  assert.deepEqual(c.salidaHook('UserPromptSubmit', 'x', { systemMessage: 'm' }).systemMessage, 'm');
  assert.equal(c.MARCA_CONTEXTO, '[uaeh-kit ctx v1]');
});
