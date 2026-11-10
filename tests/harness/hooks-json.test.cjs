// Pruebas de plugins/uaeh-harness/hooks/hooks.json: forma exec, scripts existentes, matchers anclados, tiempos y onFailure
// solo donde el diseño lo manda (guardia-git.js). También comprueba que cada script del plugin arranca sin romper la
// sesión ante una entrada vacía o ilegible (hooks que bloquean = falla cerrado SOLO en su dominio).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_HARNESS, entornoTemporal, correr } = require('../helpers/entorno.cjs');

const RUTA = path.join(RAIZ_HARNESS, 'hooks', 'hooks.json');
const datos = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
const REVISORES = ['uae-verifier', 'uae-security', 'browser-verifier', 'uae-triage', 'uae-architect', 'design-auditor'];

function todosLosHooks() {
  const salida = [];
  for (const [evento, grupos] of Object.entries(datos.hooks)) {
    for (const g of grupos) for (const h of g.hooks) salida.push({ evento, matcher: g.matcher, h });
  }
  return salida;
}

test('todos los hooks van en forma exec: command "node" + args con ${CLAUDE_PLUGIN_ROOT}/…, timeout numérico', () => {
  const lista = todosLosHooks();
  assert.ok(lista.length >= 8, `pocos hooks: ${lista.length}`);
  for (const { evento, h } of lista) {
    assert.equal(h.type, 'command', evento);
    assert.equal(h.command, 'node', `${evento}: command debe ser node (sin shell)`);
    assert.ok(Array.isArray(h.args) && h.args.length >= 1, `${evento}: args`);
    assert.match(h.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks|scripts)\/[a-z0-9_.-]+\.(js|cjs)$/, `${evento}: ${h.args[0]}`);
    assert.ok(Number.isInteger(h.timeout) && h.timeout > 0 && h.timeout <= 30, `${evento}: timeout ${h.timeout}`);
    for (const a of h.args.slice(1)) assert.match(a, /^[a-z-]+$/, `${evento}: argumento ${a}`);
  }
});

test('cada script citado existe en el plugin y pasa node --check', () => {
  const vistos = new Set();
  for (const { h } of todosLosHooks()) {
    const rel = h.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
    const abs = path.join(RAIZ_HARNESS, ...rel.split('/'));
    assert.ok(fs.existsSync(abs), `no existe ${rel}`);
    if (vistos.has(abs)) continue;
    vistos.add(abs);
    const r = correr('--check', [abs]);
    assert.equal(r.status, 0, `node --check ${rel}: ${r.stderr}`);
  }
});

test('onFailure: block SOLO en guardia-git.js; los candados y los hooks informativos no lo llevan', () => {
  for (const { evento, h } of todosLosHooks()) {
    const esGuardiaGit = /\/guardia-git\.js$/.test(h.args[0]);
    if (esGuardiaGit) assert.equal(h.onFailure, 'block', 'guardia-git.js debe bloquear si node falla');
    else assert.equal(h.onFailure, undefined, `${evento} ${h.args[0]}: sin onFailure`);
  }
});

test('PreToolUse cubre Bash|PowerShell con guardia-git, guardia-cierre commit y los dos candados (solo-navegador después de solo-lectura)', () => {
  const pre = datos.hooks.PreToolUse;
  assert.equal(pre.length, 1);
  assert.equal(pre[0].matcher, 'Bash|PowerShell');
  const args = pre[0].hooks.map((h) => h.args.join(' '));
  assert.ok(args.some((a) => a.endsWith('/hooks/guardia-git.js')));
  assert.ok(args.some((a) => a.endsWith('/hooks/uaeh-guardia-cierre.js commit')));
  const lectura = args.findIndex((a) => a.endsWith('/hooks/solo-lectura.js'));
  const navegador = args.findIndex((a) => a.endsWith('/hooks/solo-navegador.js'));
  assert.ok(lectura >= 0, 'falta solo-lectura.js');
  assert.ok(navegador > lectura, 'solo-navegador.js va después de solo-lectura.js (lista negra primero, lista blanca después)');
});

test('los matchers de agentes son regex ancladas que admiten el prefijo del plugin y casan con cada revisor', () => {
  const grupos = [...datos.hooks.SubagentStart, ...datos.hooks.SubagentStop];
  for (const g of grupos) {
    assert.match(g.matcher, /^\^\(uaeh-harness:\)\?\(.+\)\$$/, g.matcher);
    const re = new RegExp(g.matcher);
    const nombres = /\(uaeh-harness:\)\?\(([^)]+)\)/.exec(g.matcher)[1].split('|');
    for (const n of nombres) {
      assert.ok(REVISORES.includes(n), `revisor desconocido en el matcher: ${n}`);
      assert.ok(re.test(n) && re.test(`uaeh-harness:${n}`), `no casa ${n}`);
      assert.ok(!re.test(`otro-plugin:${n}`) && !re.test(`${n}-x`) && !re.test(`x${n}`), `casa de más con ${n}`);
    }
  }
  const integridad = (ev) => datos.hooks[ev].find((g) => g.hooks.some((h) => /uaeh-integridad\.cjs$/.test(h.args[0])));
  for (const ev of ['SubagentStart', 'SubagentStop']) {
    const g = integridad(ev);
    assert.ok(g, `${ev} sin sello`);
    const nombres = /\(uaeh-harness:\)\?\(([^)]+)\)/.exec(g.matcher)[1].split('|').sort();
    assert.deepEqual(nombres, [...REVISORES].sort(), `${ev}: el sello debe cubrir a los seis revisores`);
    assert.equal(g.hooks[0].timeout, 30, 'el sello tiene presupuesto interno de 20 s < 30');
  }
  const revisor = datos.hooks.SubagentStop.find((g) => g.hooks.some((h) => h.args.includes('revisor')));
  assert.ok(revisor);
  assert.deepEqual(/\(uaeh-harness:\)\?\(([^)]+)\)/.exec(revisor.matcher)[1].split('|').sort(), ['uae-security', 'uae-verifier']);
});

test('Stop lleva la guardia de cierre y SessionStart la línea de inicio, ambos sin matcher', () => {
  assert.equal(datos.hooks.Stop.length, 1);
  assert.equal(datos.hooks.Stop[0].matcher, undefined);
  assert.ok(datos.hooks.Stop[0].hooks[0].args.join(' ').endsWith('/hooks/uaeh-guardia-cierre.js cierre'));
  assert.equal(datos.hooks.SessionStart.length, 1);
  assert.equal(datos.hooks.SessionStart[0].matcher, undefined);
  assert.ok(datos.hooks.SessionStart[0].hooks[0].args[0].endsWith('/hooks/linea-inicio.cjs'));
});

test('la descripción explica qué bloquea y la compuerta por identidad', () => {
  assert.match(datos.description, /BLOQUEAN/);
  assert.match(datos.description, /candados\.json/);
  assert.match(datos.description, /onFailure/);
});

test('ante una entrada vacía o ilegible, ningún hook informativo rompe la sesión (exit 0) y los que bloquean solo niegan en su dominio', () => {
  const e = entornoTemporal('uaeh-hooks-');
  try {
    const vistos = new Set();
    for (const { h } of todosLosHooks()) {
      const rel = h.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
      const clave = h.args.join(' ');
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      const abs = path.join(RAIZ_HARNESS, ...rel.split('/'));
      for (const stdin of ['', '{{{ roto', '{}']) {
        const r = correr(abs, h.args.slice(1), { stdin, env: e.env, cwd: e.proyecto, timeout: 30000 });
        assert.equal(r.status, 0, `${rel} ${h.args.slice(1).join(' ')} con stdin «${stdin}» salió ${r.status}: ${r.stderr}`);
        if (r.stdout.trim()) {
          let json = null;
          try { json = JSON.parse(r.stdout); } catch { /* abajo */ }
          assert.ok(json, `${rel}: stdout no es JSON: ${r.stdout.slice(0, 120)}`);
          if (/guardia-git\.js$/.test(rel)) {
            // falla cerrado en su dominio: sin comando de texto → niega
            assert.equal(json.hookSpecificOutput.permissionDecision, 'deny');
          }
        }
      }
    }
  } finally { e.limpiar(); }
});
