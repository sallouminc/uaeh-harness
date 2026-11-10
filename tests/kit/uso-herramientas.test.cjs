// Pruebas de plugins/uaeh-kit/scripts/uso-herramientas.cjs con JSONL sintético en una casa temporal
// (nunca se leen las transcripciones reales).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, correr, RAIZ_KIT } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_KIT, 'scripts', 'uso-herramientas.cjs');
const herramientas = require(SCRIPT);

const AHORA = Date.parse('2026-10-30T20:00:00Z'); // la misma hora que fija UAEH_AHORA en el entorno hermético
const RECIENTE = new Date('2026-10-30T19:30:00Z');
const ANTIGUO = new Date('2026-09-01T00:00:00Z');
let n = 0;

const bloque = (name, input) => { n++; return { type: 'tool_use', id: `tu-${n}`, name, input }; };
function linea(bloques, timestamp = '2026-10-30T18:00:00Z') {
  n++;
  return JSON.stringify({ type: 'assistant', timestamp, message: { id: `m-${n}`, role: 'assistant', model: 'modelo-a', content: bloques } });
}
function escribir(ruta, lineas, modificado = RECIENTE) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, lineas.join('\n') + '\n', 'utf8');
  fs.utimesSync(ruta, modificado, modificado);
}

// Una sesión con todos los casos, un archivo de subagente anidado y un archivo entero sin tocar.
function crearTranscripciones(raiz) {
  escribir(path.join(raiz, 'proy-1', 'sesion-1.jsonl'), [
    linea([bloque('Agent', { subagent_type: 'revisor', model: 'modelo-chico', prompt: 'SECRETO-123 revisa esto' })]),
    linea([bloque('Agent', { subagent_type: 'revisor', description: 'sin modelo pedido' })]),
    linea([bloque('Task', { subagent_type: 'explorador', model: 'modelo-chico' })]), // el nombre antiguo de la herramienta
    linea([bloque('Agent', { prompt: 'sin tipo de agente' })]),
    linea([bloque('Skill', { skill: 'uae-loop', args: 'SECRETO-123' }), bloque('Skill', { skill: 'uae-loop' })]), // dos en paralelo
    linea([bloque('Skill', { skill: 'otra-skill' })]),
    linea([bloque('Skill', {})]), // sin nombre: no cuenta
    linea([bloque('Workflow', { script: 'SECRETO-123' })]),
    linea([bloque('Bash', { command: 'echo SECRETO-123' })]), // otra herramienta: no cuenta
    linea([bloque('Agent', null)]), // entrada vacía: tipo y modelo por defecto
    linea([bloque('Task', { subagent_type: 42, model: 7 })]), // tipos que no son texto: se tratan como ausentes
    linea([bloque('Agent', { subagent_type: 'viejo' })], '2026-09-01T00:00:00Z'), // línea fuera de la ventana de 30 días
    '{ esto no es json pero dice "tool_use" ',
    linea([{ type: 'text', text: 'hola' }]),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'texto' } }),
  ]);
  escribir(path.join(raiz, 'proy-1', 'sesion-1', 'subagents', 'agente.jsonl'), [
    linea([bloque('Skill', { skill: 'uae-loop' }), bloque('Agent', { subagent_type: 'revisor', model: 'modelo-grande' })]),
  ]);
  escribir(path.join(raiz, 'proy-2', 'archivo-viejo.jsonl'), [
    linea([bloque('Agent', { subagent_type: 'archivo-viejo' })]), // línea reciente en un archivo sin tocar: no se lee
  ], ANTIGUO);
}

const ESPERADO = {
  agentes: { revisor: 3, explorador: 1, '(general-purpose)': 3 },
  modelosPedidos: { 'modelo-chico': 2, 'modelo-grande': 1, '(hereda)': 4 },
  skills: { 'uae-loop': 3, 'otra-skill': 1 },
  workflows: 1,
  omitidos: 0,
};

test('medir cuenta agentes por tipo, modelo pedido, skills por nombre y workflows', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    crearTranscripciones(raiz);
    assert.deepEqual(herramientas.medir(raiz, 30, AHORA), ESPERADO);
  } finally { e.limpiar(); }
});

test('la ventana de días deja fuera las líneas viejas y los archivos sin tocar', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    crearTranscripciones(raiz);
    const r60 = herramientas.medir(raiz, 60, AHORA);
    assert.equal(r60.agentes.viejo, 1, 'con 60 días entra la línea del 1 de septiembre');
    assert.equal(r60.agentes['archivo-viejo'], 1, 'y el archivo sin tocar desde entonces');
    assert.equal(r60.agentes.revisor, 3);
    const r30 = herramientas.medir(raiz, 30, AHORA);
    assert.equal(r30.agentes.viejo, undefined);
    assert.equal(r30.agentes['archivo-viejo'], undefined);
    // Con una ventana de un solo día y las líneas de hoy, todo lo de la sesión sigue dentro.
    assert.equal(herramientas.medir(raiz, 1, AHORA).agentes.revisor, 3);
    // El archivo se modificó hace 30 minutos: con una ventana de 10 minutos no se abre.
    assert.deepEqual(herramientas.medir(raiz, 10 / 1440, AHORA).agentes, {});
  } finally { e.limpiar(); }
});

test('una línea sin marca de tiempo se conserva', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    const sinMarca = JSON.parse(linea([bloque('Skill', { skill: 'sin-marca' })]));
    delete sinMarca.timestamp;
    escribir(path.join(raiz, 'p', 's.jsonl'), [JSON.stringify(sinMarca)]);
    assert.deepEqual(herramientas.medir(raiz, 7, AHORA).skills, { 'sin-marca': 1 });
  } finally { e.limpiar(); }
});

test('raíz inexistente: todo en cero, sin tronar', () => {
  const e = entornoTemporal();
  try {
    const r = herramientas.medir(path.join(e.dir, 'no-existe'), 30, AHORA);
    assert.deepEqual(r, { agentes: {}, modelosPedidos: {}, skills: {}, workflows: 0, omitidos: 0 });
  } finally { e.limpiar(); }
});

test('informe: tres rankings ordenados de mayor a menor (empates por nombre) y el total de workflows', () => {
  const texto = herramientas.informe(ESPERADO, 30);
  assert.equal(texto, [
    '=== Agentes invocados (30 días) ===',
    '    3  (general-purpose)',
    '    3  revisor',
    '    1  explorador',
    '',
    '=== Modelo pedido al lanzar agentes ===',
    '    4  (hereda)',
    '    2  modelo-chico',
    '    1  modelo-grande',
    '',
    '=== Skills invocadas ===',
    '    3  uae-loop',
    '    1  otra-skill',
    '',
    'Workflows: 1',
  ].join('\n'));
  assert.match(herramientas.informe({ agentes: {}, modelosPedidos: {}, skills: {}, workflows: 0 }, 7), /\(ninguno\)[\s\S]*\(ninguno\)[\s\S]*\(ninguno\)[\s\S]*Workflows: 0$/);
});

test('la línea de comandos usa USO_RAIZ y 30 días por defecto; imprime nombres y nunca prompts, argumentos ni comandos', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    crearTranscripciones(raiz);
    const r = correr(SCRIPT, [], { env: { ...e.env, USO_RAIZ: raiz } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, herramientas.informe(ESPERADO, 30) + '\n');
    assert.doesNotMatch(r.stdout + r.stderr, /SECRETO|echo|sin tipo de agente|sin modelo pedido/);

    const sesenta = correr(SCRIPT, ['60'], { env: { ...e.env, USO_RAIZ: raiz } });
    assert.match(sesenta.stdout, /^=== Agentes invocados \(60 días\) ===/);
    assert.match(sesenta.stdout, /^ +1  archivo-viejo$/m);
  } finally { e.limpiar(); }
});

test('sin USO_RAIZ lee <carpeta de Claude Code>/projects; raíz inexistente da salida vacía y código 0', () => {
  const e = entornoTemporal();
  try {
    const vacio = correr(SCRIPT, [], { env: e.env });
    assert.equal(vacio.status, 0, vacio.stderr);
    assert.equal((vacio.stdout.match(/\(ninguno\)/g) || []).length, 3);
    assert.match(vacio.stdout, /Workflows: 0$/m);

    escribir(path.join(e.claudeHome, 'projects', 'p', 's.jsonl'), [linea([bloque('Skill', { skill: 'de-la-casa' })])]);
    const r = correr(SCRIPT, ['7'], { env: e.env });
    assert.match(r.stdout, /^ +1  de-la-casa$/m);
  } finally { e.limpiar(); }
});

test('uso incorrecto: dias inválido o argumentos de más → código 1 con la forma de uso', () => {
  const e = entornoTemporal();
  try {
    for (const args of [['abc'], ['0'], ['-3'], [''], ['Infinity'], ['30', '7']]) {
      const r = correr(SCRIPT, args, { env: e.env });
      assert.equal(r.status, 1, `args ${JSON.stringify(args)}`);
      assert.match(r.stderr, /Uso: node uso-herramientas\.cjs \[dias>0\]/);
      assert.equal(r.stdout, '');
    }
    assert.deepEqual(herramientas.parsearArgumentos([]), { dias: 30 });
    assert.deepEqual(herramientas.parsearArgumentos(['90']), { dias: 90 });
  } finally { e.limpiar(); }
});

test('un archivo ilegible se omite y se cuenta; el resto sigue', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    escribir(path.join(raiz, 'p', 'bien.jsonl'), [linea([bloque('Skill', { skill: 'a' })])]);
    escribir(path.join(raiz, 'p', 'ilegible.jsonl'), [linea([bloque('Skill', { skill: 'b' })])]);
    const original = fs.readFileSync;
    fs.readFileSync = function (ruta, ...resto) {
      if (String(ruta).endsWith('ilegible.jsonl')) throw Object.assign(new Error('EACCES simulado'), { code: 'EACCES' });
      return original.call(this, ruta, ...resto);
    };
    let r;
    try { r = herramientas.medir(raiz, 7, AHORA); } finally { fs.readFileSync = original; }
    assert.equal(r.omitidos, 1);
    assert.deepEqual(r.skills, { a: 1 });
  } finally { e.limpiar(); }
});
