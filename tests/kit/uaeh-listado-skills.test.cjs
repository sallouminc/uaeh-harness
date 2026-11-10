// Pruebas de plugins/uaeh-kit/scripts/uaeh-listado-skills.cjs con transcripciones sintéticas.
// Los primeros once casos son los del script de origen, portados a node:test.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, correr, RAIZ_KIT } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_KIT, 'scripts', 'uaeh-listado-skills.cjs');
const listado = require(SCRIPT);

const CONTENT = [
  '- alfa: hace cosas',
  '- uae-loop: protocolo de tareas',
  '- uae-preflight',
  '- beta',
  '- plug:gamma: de plugin con descripción',
  '- plug:delta',
].join('\n');
const linea = (content, count) => JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content, skillCount: count } });
const sinListado = JSON.stringify({ type: 'user', message: 'hola' });

// Escribe un archivo y le fija la fecha de modificación (segundos desde la época, para ordenar sin depender del reloj).
function escribir(ruta, contenido, segundos) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, contenido, 'utf8');
  if (segundos != null) fs.utimesSync(ruta, segundos, segundos);
  return ruta;
}

const T0 = Date.parse('2026-10-30T12:00:00Z') / 1000;

function conArchivoBase(e) {
  return escribir(path.join(e.dir, 'a.jsonl'), [sinListado, 'esto no es json {{{', linea(CONTENT, 6), linea('- otro: x', 1)].join('\n') + '\n');
}

test('listado de juguete: caracteres y skillCount (usa el primero)', () => {
  const e = entornoTemporal();
  try {
    const r = correr(SCRIPT, [conArchivoBase(e)], { env: e.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Caracteres totales: ${CONTENT.length}\\b`));
    assert.match(r.stdout, /skillCount: 6/);
  } finally { e.limpiar(); }
});

test('cuenta con y sin descripción', () => {
  const e = entornoTemporal();
  try {
    const r = correr(SCRIPT, [conArchivoBase(e)], { env: e.env });
    assert.match(r.stdout, /Con descripción: 3\b/);
    assert.match(r.stdout, /Sin descripción: 3\b/);
  } finally { e.limpiar(); }
});

test('reporta las uae-* automáticamente', () => {
  const e = entornoTemporal();
  try {
    const r = correr(SCRIPT, [conArchivoBase(e)], { env: e.env });
    assert.match(r.stdout, /uae-loop: sí/);
    assert.match(r.stdout, /uae-preflight: no/);
  } finally { e.limpiar(); }
});

test('separa las skills sin prefijo de plugin', () => {
  const e = entornoTemporal();
  try {
    const r = correr(SCRIPT, [conArchivoBase(e)], { env: e.env });
    assert.match(r.stdout, /sin prefijo de plugin: con descripción 2, sin 2/);
  } finally { e.limpiar(); }
});

test('sin listado → código 2', () => {
  const e = entornoTemporal();
  try {
    const g = escribir(path.join(e.dir, 'b.jsonl'), sinListado + '\n');
    const r = correr(SCRIPT, [g], { env: e.env });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /No se encontró/);
  } finally { e.limpiar(); }
});

test('--nombres informa de skills concretas, también las que no están', () => {
  const e = entornoTemporal();
  try {
    const r = correr(SCRIPT, [conArchivoBase(e), '--nombres', 'alfa,beta,noexiste'], { env: e.env });
    assert.match(r.stdout, /alfa: sí/);
    assert.match(r.stdout, /beta: no/);
    assert.match(r.stdout, /noexiste: no \(ausente\)/);
  } finally { e.limpiar(); }
});

test('--json entrega las cifras y el estado de cada skill', () => {
  const e = entornoTemporal();
  try {
    const r = correr(SCRIPT, [conArchivoBase(e), '--json'], { env: e.env });
    assert.equal(r.status, 0, r.stderr);
    const j = r.json();
    assert.equal(j.caracteres, CONTENT.length);
    assert.equal(j.skillCount, 6);
    assert.equal(j.conDescripcion, 3);
    assert.equal(j.sinDescripcion, 3);
    assert.deepEqual(j.propias, { conDescripcion: 2, sinDescripcion: 2, caracteresConDescripcion: '- alfa: hace cosas'.length + '- uae-loop: protocolo de tareas'.length });
    assert.deepEqual(j.skills, { 'uae-loop': 'con descripción', 'uae-preflight': 'sin descripción' });
    assert.equal(j.archivo, conArchivoBase(e));
  } finally { e.limpiar(); }
});

test('--ultima elige la transcripción más reciente que tenga listado', () => {
  const e = entornoTemporal();
  try {
    const d = path.join(e.dir, 'dir');
    escribir(path.join(d, 'viejo.jsonl'), linea('- viejo: x', 1) + '\n', T0 - 300);
    escribir(path.join(d, 'medio.jsonl'), linea('- medio: x\n- medio2: y', 2) + '\n', T0 - 200);
    escribir(path.join(d, 'nuevo.jsonl'), sinListado + '\n', T0 - 100);
    const r = correr(SCRIPT, ['--ultima', d, '--json'], { env: e.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.json().archivo, /medio\.jsonl$/);
    assert.equal(r.json().skillCount, 2);
  } finally { e.limpiar(); }
});

test('--ultima sin listados → código 2', () => {
  const e = entornoTemporal();
  try {
    const vacio = path.join(e.dir, 'vacio');
    fs.mkdirSync(vacio);
    assert.equal(correr(SCRIPT, ['--ultima', vacio], { env: e.env }).status, 2);
  } finally { e.limpiar(); }
});

test('sin argumentos → código 1', () => {
  const e = entornoTemporal();
  try {
    const r = correr(SCRIPT, [], { env: e.env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /falta <archivo\.jsonl> o --ultima/);
  } finally { e.limpiar(); }
});

test('archivo inexistente → código 1', () => {
  const e = entornoTemporal();
  try {
    const r = correr(SCRIPT, [path.join(e.dir, 'noexiste.jsonl')], { env: e.env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no se pudo leer .*ENOENT/);
  } finally { e.limpiar(); }
});

test('las uae-* se reportan solas con o sin prefijo de plugin; lo demás solo si se pide con --nombres', () => {
  const contenido = [
    '- uae-loop: protocolo de tareas',
    '- uaeh-harness:uae-loop: protocolo de tareas del plugin',
    '- uaeh-harness:uae-preflight',
    '- otro_plugin-2:uae-x: de otro plugin',
    '- uaeh-kit:medir: lleva prefijo de plugin pero no es uae-*',
    '- xuae-falsa: no empieza por uae-',
    '- uae: sin guion no es uae-*',
  ].join('\n');
  const esperado = {
    'uae-loop': 'con descripción',
    'uaeh-harness:uae-loop': 'con descripción',
    'uaeh-harness:uae-preflight': 'sin descripción',
    'otro_plugin-2:uae-x': 'con descripción',
  };

  // Función pura: --nombres suma otras skills y no duplica las que ya salen solas.
  assert.deepEqual(listado.analizar({ content: contenido, skillCount: 7 }, []).skills, esperado);
  assert.deepEqual(
    listado.analizar({ content: contenido, skillCount: 7 }, ['uaeh-kit:medir', 'uae-loop', 'no-esta']).skills,
    { ...esperado, 'uaeh-kit:medir': 'con descripción', 'no-esta': 'ausente' },
  );

  // Línea de comandos, en JSON y en texto.
  const e = entornoTemporal();
  try {
    const ruta = escribir(path.join(e.dir, 'prefijos.jsonl'), linea(contenido, 7) + '\n');
    const json = correr(SCRIPT, [ruta, '--json'], { env: e.env });
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(json.json().skills, esperado);
    const texto = correr(SCRIPT, [ruta], { env: e.env });
    assert.equal(texto.status, 0, texto.stderr);
    assert.match(texto.stdout, /^  uaeh-harness:uae-loop: sí \(con descripción\)$/m);
    assert.match(texto.stdout, /^  uaeh-harness:uae-preflight: no \(sin descripción\)$/m);
    assert.match(texto.stdout, /^  otro_plugin-2:uae-x: sí \(con descripción\)$/m);
    assert.doesNotMatch(texto.stdout, /uaeh-kit:medir|xuae-falsa|^  uae: /m);
  } finally { e.limpiar(); }
});

test('--ultima sin carpeta busca en todas las subcarpetas de <carpeta de Claude Code>/projects y omite las de subagentes', () => {
  const e = entornoTemporal();
  try {
    const projects = path.join(e.claudeHome, 'projects');
    escribir(path.join(projects, 'proy-a', 'sesion-vieja.jsonl'), linea('- vieja: x', 1) + '\n', T0 - 500);
    escribir(path.join(projects, 'proy-b', 'sesion-sin-listado.jsonl'), sinListado + '\n', T0 - 100);
    escribir(path.join(projects, 'proy-b', 'sesion-buena.jsonl'), linea('- buena: x\n- buena2: y\n- buena3: z', 3) + '\n', T0 - 200);
    // La más reciente de todas pertenece a un subagente: se ignora.
    escribir(path.join(projects, 'proy-b', 'sesion-buena', 'subagents', 'agente.jsonl'), linea('- subagente: x', 1) + '\n', T0);
    assert.equal(e.env.USO_RAIZ, undefined);

    const r = correr(SCRIPT, ['--ultima', '--json'], { env: e.env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().archivo, path.join(projects, 'proy-b', 'sesion-buena.jsonl'));
    assert.equal(r.json().skillCount, 3);

    // Con --nombres a continuación de --ultima, el nombre no se confunde con la carpeta.
    const conNombres = correr(SCRIPT, ['--ultima', '--nombres', 'buena,otra'], { env: e.env });
    assert.match(conNombres.stdout, /buena: sí/);
    assert.match(conNombres.stdout, /otra: no \(ausente\)/);

    // USO_RAIZ manda sobre la carpeta de Claude Code.
    const otra = path.join(e.dir, 'otra-raiz');
    escribir(path.join(otra, 'p', 's.jsonl'), linea('- de-otra-raiz: x', 1) + '\n', T0);
    const conRaiz = correr(SCRIPT, ['--ultima', '--json'], { env: { ...e.env, USO_RAIZ: otra } });
    assert.equal(conRaiz.json().archivo, path.join(otra, 'p', 's.jsonl'));
  } finally { e.limpiar(); }
});

test('--ultima con carpeta explícita también recorre subcarpetas; una carpeta inexistente o un archivo → código 1', () => {
  const e = entornoTemporal();
  try {
    const d = path.join(e.dir, 'arbol');
    escribir(path.join(d, 'nivel1', 'nivel2', 'profundo.jsonl'), linea('- profundo: x', 1) + '\n', T0 - 10);
    escribir(path.join(d, 'plano.jsonl'), linea('- plano: x', 1) + '\n', T0 - 20);
    const r = correr(SCRIPT, ['--ultima', d, '--json'], { env: e.env });
    assert.equal(r.json().archivo, path.join(d, 'nivel1', 'nivel2', 'profundo.jsonl'));

    const falta = correr(SCRIPT, ['--ultima', path.join(e.dir, 'no-existe')], { env: e.env });
    assert.equal(falta.status, 1);
    assert.match(falta.stderr, /no es una carpeta/);
    const archivo = correr(SCRIPT, ['--ultima', path.join(d, 'plano.jsonl')], { env: e.env });
    assert.equal(archivo.status, 1);
  } finally { e.limpiar(); }
});

test('--ultima sin carpeta y sin transcripciones (la carpeta de Claude Code ni existe) → código 2', () => {
  const e = entornoTemporal();
  try {
    assert.equal(fs.existsSync(path.join(e.claudeHome, 'projects')), false);
    const r = correr(SCRIPT, ['--ultima'], { env: e.env });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /No se encontró/);
  } finally { e.limpiar(); }
});

test('masLargas: las 10 líneas más largas como { nombre, caracteres }, empates por nombre', () => {
  const lineas = [];
  for (let i = 1; i <= 12; i++) lineas.push(`- s${String(i).padStart(2, '0')}: ${'x'.repeat(i * 10)}`); // largo = 7 + 10·i
  lineas.push(`- tie-b: ${'y'.repeat(291)}`, `- tie-a: ${'z'.repeat(291)}`, '- sin-descripcion');
  const analisis = listado.analizar({ content: lineas.join('\n'), skillCount: lineas.length }, []);
  assert.equal(analisis.masLargas.length, 10);
  assert.deepEqual(analisis.masLargas, [
    { nombre: 'tie-a', caracteres: 300 },
    { nombre: 'tie-b', caracteres: 300 },
    { nombre: 's12', caracteres: 127 },
    { nombre: 's11', caracteres: 117 },
    { nombre: 's10', caracteres: 107 },
    { nombre: 's09', caracteres: 97 },
    { nombre: 's08', caracteres: 87 },
    { nombre: 's07', caracteres: 77 },
    { nombre: 's06', caracteres: 67 },
    { nombre: 's05', caracteres: 57 },
  ]);

  // Con menos de diez, salen todas, también las que no llevan descripción.
  const poco = listado.analizar({ content: CONTENT, skillCount: 6 }, []);
  assert.deepEqual(poco.masLargas, [
    { nombre: 'plug:gamma', caracteres: '- plug:gamma: de plugin con descripción'.length },
    { nombre: 'uae-loop', caracteres: '- uae-loop: protocolo de tareas'.length },
    { nombre: 'alfa', caracteres: '- alfa: hace cosas'.length },
    { nombre: 'uae-preflight', caracteres: '- uae-preflight'.length },
    { nombre: 'plug:delta', caracteres: '- plug:delta'.length },
    { nombre: 'beta', caracteres: '- beta'.length },
  ]);

  // Y llega por la línea de comandos solo con --json.
  const e = entornoTemporal();
  try {
    const archivo = conArchivoBase(e);
    const json = correr(SCRIPT, [archivo, '--json'], { env: e.env }).json();
    assert.deepEqual(json.masLargas, poco.masLargas);
    assert.deepEqual(Object.keys(json), ['archivo', 'caracteres', 'skillCount', 'conDescripcion', 'sinDescripcion', 'caracteresConDescripcion', 'propias', 'skills', 'masLargas']);
    assert.doesNotMatch(correr(SCRIPT, [archivo], { env: e.env }).stdout, /masLargas|plug:gamma/, 'el texto no cambia');
  } finally { e.limpiar(); }
});

test('buscarListado lee por bloques: un carácter multibyte partido entre dos bloques llega entero y manda el primer listado', () => {
  const e = entornoTemporal();
  try {
    const BLOQUE = 1 << 20;
    const contenido = '- ñandú: descripción con acentos áéíóú y emoji 😀';
    const primero = linea(contenido, 1);
    // Relleno para que el primer byte de «ñ» sea el último del primer bloque y el segundo abra el siguiente.
    const bytesAntes = Buffer.byteLength(primero.slice(0, primero.indexOf('ñ')));
    const relleno = 'x'.repeat(BLOQUE - 2 - bytesAntes);
    const ruta = escribir(path.join(e.dir, 'grande.jsonl'), [relleno, primero, linea('- segundo: no debe usarse', 9), 'tampoco json {{'].join('\n') + '\n');
    assert.ok(fs.statSync(ruta).size > BLOQUE);
    const at = listado.buscarListado(ruta);
    assert.equal(at.content, contenido);
    assert.equal(at.skillCount, 1);

    // Sin salto de línea final y con el listado en la última línea del archivo.
    const sinSalto = escribir(path.join(e.dir, 'sin-salto.jsonl'), [sinListado, linea('- ultimo: x', 1)].join('\n'));
    assert.equal(listado.buscarListado(sinSalto).content, '- ultimo: x');
    assert.equal(listado.buscarListado(escribir(path.join(e.dir, 'vacio.jsonl'), '')), null);
  } finally { e.limpiar(); }
});

test('buscarListado se detiene en el primer listado: no sigue leyendo el resto de un archivo enorme', () => {
  const e = entornoTemporal();
  try {
    const ruta = escribir(path.join(e.dir, 'enorme.jsonl'), [linea('- primero: x', 1), 'x'.repeat(3 * (1 << 20))].join('\n') + '\n');
    const lecturas = [];
    const original = fs.readSync;
    fs.readSync = function (...args) { const n = original.apply(this, args); lecturas.push(n); return n; };
    let at;
    try { at = listado.buscarListado(ruta); } finally { fs.readSync = original; }
    assert.equal(at.content, '- primero: x');
    assert.equal(lecturas.length, 1, 'una sola lectura de bloque');
  } finally { e.limpiar(); }
});

test('parseArgs: --ultima con o sin carpeta, --nombres, --json y argumentos incorrectos', () => {
  assert.deepEqual(listado.parseArgs(['a.jsonl']), { archivo: 'a.jsonl', ultima: null, nombres: [], json: false });
  assert.deepEqual(listado.parseArgs(['--ultima']), { archivo: null, ultima: true, nombres: [], json: false });
  assert.equal(listado.parseArgs(['--ultima', 'carpeta']).ultima, 'carpeta');
  assert.deepEqual(listado.parseArgs(['--ultima', '--json']), { archivo: null, ultima: true, nombres: [], json: true });
  assert.deepEqual(listado.parseArgs(['--ultima', 'c', '--nombres', ' a , b,,c ']).nombres, ['a', 'b', 'c']);
  assert.equal(listado.parseArgs(['--ultima', '']).ultima, true, 'una carpeta vacía equivale a la de por defecto');
  assert.throws(() => listado.parseArgs([]), /falta <archivo\.jsonl> o --ultima/);
  assert.throws(() => listado.parseArgs(['a.jsonl', '--nada']), /argumento desconocido: --nada/);
});

test('privacidad: se imprimen conteos y nombres, nunca las descripciones', () => {
  const e = entornoTemporal();
  try {
    const ruta = escribir(path.join(e.dir, 'p.jsonl'), linea('- secreta: descripción con SECRETO-123\n- uae-x: otro SECRETO-123', 2) + '\n');
    for (const args of [[ruta], [ruta, '--json']]) {
      const r = correr(SCRIPT, args, { env: e.env });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /uae-x/, 'sí aparece el nombre de la skill: es un dato del listado');
      assert.doesNotMatch(r.stdout + r.stderr, /SECRETO/);
    }
  } finally { e.limpiar(); }
});
