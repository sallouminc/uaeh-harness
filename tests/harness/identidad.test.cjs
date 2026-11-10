// Pruebas de plugins/uaeh-harness/hooks/_identidad.js (la compuerta por identidad de los candados) y de hooks/candados.json.
// Las variantes con un candados.json distinto (ausente, roto, con otra lista) se prueban sobre COPIAS del módulo en la casa
// temporal: el módulo lee el candados.json que tiene al lado, así que cada copia lee el suyo.
// Correr: node --test tests/harness/identidad.test.cjs
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_HARNESS, entornoTemporal } = require('../helpers/entorno.cjs');

const DIR_HOOKS = path.join(RAIZ_HARNESS, 'hooks');
const identidad = require(path.join(DIR_HOOKS, '_identidad.js'));
const REVISORES = ['uae-verifier', 'uae-security', 'browser-verifier'];

let copias = 0;
// Copia _identidad.js a una carpeta de la casa `e`, junto a un candados.json con `contenido` (null = sin archivo), y
// devuelve el módulo cargado desde esa copia junto con la ruta del candados.json.
function identidadCon(e, contenido) {
  const dir = path.join(e.dir, `identidad-copia-${++copias}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(DIR_HOOKS, '_identidad.js'), path.join(dir, '_identidad.js'));
  const candados = path.join(dir, 'candados.json');
  if (contenido !== null) fs.writeFileSync(candados, typeof contenido === 'string' ? contenido : JSON.stringify(contenido), 'utf8');
  return { modulo: require(path.join(dir, '_identidad.js')), candados };
}

function conEntorno(fn) {
  const e = entornoTemporal('uaeh-identidad-');
  try { return fn(e); } finally { e.limpiar(); }
}

// ── tipoAgente ────────────────────────────────────────────────────────────────────────

test('tipoAgente · devuelve el nombre del agente sin el prefijo del plugin', () => {
  const casos = [
    ['uae-verifier', 'uae-verifier'], ['uaeh-harness:uae-verifier', 'uae-verifier'], ['otro-plugin:uae-security', 'uae-security'],
    ['  uae-security  ', 'uae-security'], ['\tuaeh-harness:browser-verifier\n', 'browser-verifier'], ['a:b:c', 'c'], [':uae-verifier', 'uae-verifier'],
    ['Explore', 'Explore'],
  ];
  for (const [entrada, esperado] of casos) assert.equal(identidad.tipoAgente({ agent_type: entrada }), esperado, JSON.stringify(entrada));
});

test('tipoAgente · sin agent_type de texto (o sin nombre tras el prefijo) devuelve cadena vacía', () => {
  for (const entrada of [undefined, null, {}, 5, 'texto', [], { agent_type: '' }, { agent_type: '   ' }, { agent_type: null }, { agent_type: 5 },
    { agent_type: true }, { agent_type: ['uae-verifier'] }, { agent_type: { nombre: 'uae-verifier' } }, { agent_type: 'uaeh-harness:' }]) {
    assert.equal(identidad.tipoAgente(entrada), '', JSON.stringify(entrada));
  }
});

// ── candados.json del plugin ──────────────────────────────────────────────────────────

test('candados.json · es un objeto cuyos candados son listas de nombres de agente sin prefijo', () => {
  const datos = JSON.parse(fs.readFileSync(identidad.RUTA_CANDADOS, 'utf8'));
  assert.equal(path.resolve(identidad.RUTA_CANDADOS), path.join(DIR_HOOKS, 'candados.json'), 'candados.json vive junto a _identidad.js');
  assert.ok(datos && typeof datos === 'object' && !Array.isArray(datos));
  for (const [clave, valor] of Object.entries(datos)) {
    if (clave.startsWith('_')) continue; // «_comentario» y similares no son candados
    assert.ok(Array.isArray(valor) && valor.length > 0, `${clave} debe ser una lista no vacía`);
    for (const agente of valor) {
      assert.equal(typeof agente, 'string', `${clave}: ${JSON.stringify(agente)}`);
      assert.match(agente, /^[a-z][a-z0-9-]*$/, `${clave}: el nombre va sin prefijo de plugin ni espacios`);
    }
    assert.equal(new Set(valor).size, valor.length, `${clave}: sin repetidos`);
  }
});

test('candados.json · solo-lectura cubre a los tres revisores y solo-navegador al verificador visual', () => {
  assert.deepEqual([...identidad.agentesDe('solo-lectura')].sort(), [...REVISORES].sort());
  assert.deepEqual(identidad.agentesDe('solo-navegador'), ['browser-verifier']);
});

test('agentesDe · un candado que no existe, o una clave que no es lista, devuelve null', () => {
  assert.equal(identidad.agentesDe('no-existe'), null);
  assert.equal(identidad.agentesDe('_comentario'), null, 'una clave de texto no es un candado');
});

// ── evaluar con el candados.json real ─────────────────────────────────────────────────

test('evaluar · la sesión principal (sin agent_type) no queda bajo ningún candado y no genera aviso', () => {
  for (const entrada of [undefined, null, {}, { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }, { agent_type: '' }, { agent_type: 5 }]) {
    assert.deepEqual(identidad.evaluar('solo-lectura', entrada), { aplica: false, tipo: '', aviso: null }, JSON.stringify(entrada));
  }
});

test('evaluar · los revisores listados quedan bajo el candado, con y sin el prefijo del plugin', () => {
  for (const agente of REVISORES) {
    for (const prefijo of ['', 'uaeh-harness:', 'otro-plugin:']) {
      assert.deepEqual(identidad.evaluar('solo-lectura', { agent_type: prefijo + agente }), { aplica: true, tipo: agente, aviso: null }, prefijo + agente);
    }
  }
});

test('evaluar · los agentes no listados no quedan bajo el candado (identidad conocida, sin aviso)', () => {
  for (const agente of ['uae-builder', 'general-purpose', 'Explore', 'Plan', 'uae-architect', 'uae-triage', 'design-auditor', 'uae-verifier-2', 'mi-uae-verifier']) {
    assert.deepEqual(identidad.evaluar('solo-lectura', { agent_type: agente }), { aplica: false, tipo: agente, aviso: null }, agente);
    assert.deepEqual(identidad.evaluar('solo-lectura', { agent_type: `uaeh-harness:${agente}` }), { aplica: false, tipo: agente, aviso: null }, agente);
  }
});

test('evaluar · cada candado tiene su propia lista (solo-navegador solo aplica al verificador visual)', () => {
  assert.equal(identidad.evaluar('solo-navegador', { agent_type: 'browser-verifier' }).aplica, true);
  assert.equal(identidad.evaluar('solo-navegador', { agent_type: 'uaeh-harness:browser-verifier' }).aplica, true);
  assert.equal(identidad.evaluar('solo-navegador', { agent_type: 'uae-verifier' }).aplica, false);
  assert.equal(identidad.evaluar('solo-navegador', { agent_type: 'uae-security' }).aplica, false);
});

test('evaluar · un candado que no existe en candados.json no aplica y avisa con su nombre', () => {
  const r = identidad.evaluar('candado-inventado', { agent_type: 'uae-verifier' });
  assert.equal(r.aplica, false);
  assert.equal(r.tipo, 'uae-verifier');
  assert.match(r.aviso, /candados\.json ilegible o sin la clave "candado-inventado"/);
  assert.match(r.aviso, /uae-verifier/);
});

test('evaluar · no modifica el evento que recibe', () => {
  const entrada = { agent_type: 'uaeh-harness:uae-verifier', tool_input: { command: 'ls' }, extra: [1, 2] };
  const copia = JSON.parse(JSON.stringify(entrada));
  identidad.evaluar('solo-lectura', entrada);
  identidad.candadoAplica('solo-lectura', entrada);
  assert.deepEqual(entrada, copia);
});

// ── candadoAplica ─────────────────────────────────────────────────────────────────────

test('candadoAplica · es un booleano: true solo para los agentes listados', () => {
  assert.strictEqual(identidad.candadoAplica('solo-lectura', { agent_type: 'uae-verifier' }), true);
  assert.strictEqual(identidad.candadoAplica('solo-lectura', { agent_type: 'uaeh-harness:uae-security' }), true);
  assert.strictEqual(identidad.candadoAplica('solo-lectura', { agent_type: 'uae-builder' }), false);
  assert.strictEqual(identidad.candadoAplica('solo-lectura', {}), false);
  assert.strictEqual(identidad.candadoAplica('solo-lectura', undefined), false);
  assert.strictEqual(identidad.candadoAplica('solo-navegador', { agent_type: 'uae-verifier' }), false);
});

test('el módulo expone la interfaz que usan los candados (rutas y funciones)', () => {
  assert.deepEqual(Object.keys(identidad).sort(), ['RUTA_CANDADOS', 'agentesDe', 'candadoAplica', 'evaluar', 'tipoAgente']);
  for (const f of ['agentesDe', 'candadoAplica', 'evaluar', 'tipoAgente']) assert.equal(typeof identidad[f], 'function', f);
  assert.equal(typeof identidad.RUTA_CANDADOS, 'string');
});

// ── candados.json ausente, ilegible o distinto (copias del módulo) ────────────────────

test('evaluar · con candados.json ilegible un agente conocido no queda bajo el candado y se avisa (fail-open documentado)', () => conEntorno((e) => {
  const rotos = [['JSON roto', '{ "solo-lectura": ['], ['archivo vacío', ''], ['no es un objeto', '[]'], ['solo texto', '"hola"'],
    ['sin la clave', { 'solo-navegador': ['browser-verifier'] }], ['la clave no es una lista', { 'solo-lectura': 'uae-verifier' }],
    ['la clave es un objeto', { 'solo-lectura': { 'uae-verifier': true } }], ['la clave es null', { 'solo-lectura': null }]];
  for (const [nombre, contenido] of rotos) {
    const { modulo } = identidadCon(e, contenido);
    for (const agente of ['uae-verifier', 'uaeh-harness:uae-security']) {
      const r = modulo.evaluar('solo-lectura', { agent_type: agente });
      assert.equal(r.aplica, false, `${nombre}: ${agente}`);
      assert.equal(r.tipo, agente.split(':').pop(), nombre);
      assert.match(r.aviso, /^candados\.json ilegible o sin la clave "solo-lectura": el candado no aplica a /, nombre);
    }
  }
}));

test('evaluar · sin candados.json (archivo ausente) ocurre lo mismo; la sesión principal ni lo lee ni recibe aviso', () => conEntorno((e) => {
  const { modulo } = identidadCon(e, null);
  assert.equal(modulo.agentesDe('solo-lectura'), null);
  const revisor = modulo.evaluar('solo-lectura', { agent_type: 'uae-verifier' });
  assert.equal(revisor.aplica, false);
  assert.match(revisor.aviso, /candados\.json ilegible/);
  assert.deepEqual(modulo.evaluar('solo-lectura', {}), { aplica: false, tipo: '', aviso: null });
  assert.equal(modulo.candadoAplica('solo-lectura', { agent_type: 'uae-verifier' }), false);
}));

test('agentesDe · descarta lo que no sea texto dentro de la lista y relee el archivo en cada llamada', () => conEntorno((e) => {
  const { modulo, candados } = identidadCon(e, { 'solo-lectura': ['uae-verifier', 5, null, { a: 1 }, 'uae-security'] });
  assert.deepEqual(modulo.agentesDe('solo-lectura'), ['uae-verifier', 'uae-security']);
  // el archivo se relee: el cambio se nota sin recargar el módulo
  fs.writeFileSync(candados, JSON.stringify({ 'solo-lectura': ['agente-propio'] }), 'utf8');
  assert.deepEqual(modulo.agentesDe('solo-lectura'), ['agente-propio']);
  assert.equal(modulo.evaluar('solo-lectura', { agent_type: 'uaeh-harness:agente-propio' }).aplica, true);
  assert.equal(modulo.evaluar('solo-lectura', { agent_type: 'uae-verifier' }).aplica, false);
  fs.writeFileSync(candados, '{ roto', 'utf8');
  assert.equal(modulo.agentesDe('solo-lectura'), null);
}));

test('evaluar · una lista vacía en candados.json es una lista legible: nadie queda bajo el candado y no hay aviso', () => conEntorno((e) => {
  const { modulo } = identidadCon(e, { 'solo-lectura': [] });
  assert.deepEqual(modulo.evaluar('solo-lectura', { agent_type: 'uae-verifier' }), { aplica: false, tipo: 'uae-verifier', aviso: null });
}));
