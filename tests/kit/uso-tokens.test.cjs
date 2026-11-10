// Pruebas de plugins/uaeh-kit/scripts/uso-tokens.cjs con transcripciones sintéticas en una casa temporal
// (nunca se leen las reales). Los totales esperados están calculados a mano en ESPERADO.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, correr, lineaUso, RAIZ_KIT } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_KIT, 'scripts', 'uso-tokens.cjs');
const uso = require(SCRIPT);

const AHORA = Date.parse('2026-10-30T20:00:00Z'); // la misma hora que fija UAEH_AHORA en el entorno hermético
const RECIENTE = new Date('2026-10-30T19:00:00Z'); // fecha de modificación de los archivos «vivos»
const ANTIGUO = new Date('2026-09-01T00:00:00Z');

// Escribe una transcripción y le fija la fecha de modificación: no depende del reloj de la máquina.
function transcripcion(raiz, relativa, lineas, modificado = RECIENTE) {
  const ruta = path.join(raiz, relativa);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, lineas.join('\n') + '\n', 'utf8');
  fs.utimesSync(ruta, modificado, modificado);
  return ruta;
}

const u = (o) => lineaUso({ timestamp: '2026-10-30T18:00:00Z', ...o });

// Dos proyectos: una sesión principal de 5 turnos con un mensaje repetido, uno viejo y ruido; un archivo de
// subagente en carpeta «subagents»; una sesión corta con una línea isSidechain dentro del archivo principal;
// y un archivo entero sin tocar desde hace semanas.
function crearTranscripciones(raiz) {
  transcripcion(raiz, 'proy-alfa/sesion-1.jsonl', [
    u({ id: 'a1', modelo: 'modelo-a', entrada: 10, cacheLeida: 1000000, cacheEscrita: 100000, salida: 50 }),
    u({ id: 'a1', modelo: 'modelo-a', entrada: 10, cacheLeida: 1000000, cacheEscrita: 100000, salida: 50 }), // mismo mensaje, otra línea
    u({ id: 'a2', modelo: 'modelo-b', entrada: 20, cacheLeida: 2000000, cacheEscrita: 0, salida: 100 }),
    u({ id: 'a3', modelo: 'modelo-a', entrada: 5, cacheLeida: 3000000, cacheEscrita: 50000, salida: 25 }),
    u({ id: 'a4', modelo: 'modelo-a', entrada: 5, cacheLeida: 4000000, cacheEscrita: 0, salida: 25 }),
    u({ id: 'a5', modelo: 'modelo-a', entrada: 5, cacheLeida: 5000000, cacheEscrita: 0, salida: 25 }),
    u({ id: 'a-antiguo', modelo: 'modelo-a', entrada: 999, cacheLeida: 999999, cacheEscrita: 999, salida: 999, timestamp: '2026-09-01T00:00:00Z' }),
    'esto no es json {{{',
    JSON.stringify({ type: 'user', timestamp: '2026-10-30T18:00:00Z', message: { role: 'user', content: 'hola' } }),
    JSON.stringify({ type: 'assistant', message: { id: 'sin-modelo', usage: { input_tokens: 1 } } }), // con usage pero sin modelo
  ]);
  transcripcion(raiz, 'proy-alfa/sesion-1/subagents/agente-1.jsonl', [
    u({ id: 's1', modelo: 'modelo-a', entrada: 1, cacheLeida: 100000, cacheEscrita: 10000, salida: 5, lateral: true }),
    u({ id: 's2', modelo: 'modelo-c', entrada: 2, cacheLeida: 200000, cacheEscrita: 0, salida: 7 }), // sin bandera: basta la carpeta
  ]);
  transcripcion(raiz, 'proy-beta/sesion-2.jsonl', [
    u({ id: 'b1', modelo: 'modelo-a', entrada: 7, cacheLeida: 700000, cacheEscrita: 70000, salida: 35 }),
    u({ id: 'b2', modelo: 'modelo-a', entrada: 3, cacheLeida: 300000, cacheEscrita: 30000, salida: 15 }),
    u({ id: 'b3', modelo: 'modelo-a', entrada: 1, cacheLeida: 10000, cacheEscrita: 1000, salida: 2, lateral: true }), // subagente dentro del archivo principal
  ]);
  transcripcion(raiz, 'proy-beta/viejo.jsonl', [
    u({ id: 'v1', modelo: 'modelo-a', entrada: 7777, cacheLeida: 7777777, cacheEscrita: 7777, salida: 7777 }), // línea reciente, archivo sin tocar
  ], ANTIGUO);
}

const ESPERADO = {
  porModelo: {
    'modelo-a': { turnos: 6, entrada: 35, cacheLeida: 14000000, cacheEscrita: 250000, salida: 175 },
    'modelo-b': { turnos: 1, entrada: 20, cacheLeida: 2000000, cacheEscrita: 0, salida: 100 },
    'sub:modelo-c': { turnos: 1, entrada: 2, cacheLeida: 200000, cacheEscrita: 0, salida: 7 },
    'sub:modelo-a': { turnos: 2, entrada: 2, cacheLeida: 110000, cacheEscrita: 11000, salida: 7 },
  },
  porProyecto: {
    'proy-alfa': { turnos: 7, entrada: 48, cacheLeida: 15300000, cacheEscrita: 160000, salida: 237 },
    'proy-beta': { turnos: 3, entrada: 11, cacheLeida: 1010000, cacheEscrita: 101000, salida: 52 },
  },
  sesiones: [
    { proyecto: 'proy-alfa', turnos: 5, cacheLeida: 15000000, primerContexto: 1100010, maxContexto: 5000005, modelos: ['modelo-a', 'modelo-b'] },
  ],
  arranques: { mediana: 1100010, p90: 1100010, sesiones: 1 },
};

// Entorno de ejecución con la raíz sintética; `extra` pisa variables.
function envCon(e, raiz, extra = {}) {
  return { ...e.env, ...(raiz ? { USO_RAIZ: raiz } : {}), ...extra };
}

test('recorrer suma exacto: duplicados una vez, subagentes aparte (carpeta o isSidechain), vieja y archivo sin tocar fuera', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    crearTranscripciones(raiz);
    const datos = uso.recorrer(raiz, 7, AHORA);
    assert.deepEqual(Object.fromEntries(datos.porModelo), ESPERADO.porModelo);
    assert.deepEqual(Object.fromEntries(datos.porProyecto), ESPERADO.porProyecto);
    assert.equal(datos.omitidos, 0);
    // Cada archivo principal con turnos propios deja una sesión; el de subagentes no deja ninguna.
    assert.deepEqual(datos.sesiones.map((s) => `${s.proyecto}:${s.turnos}`).sort(), ['proy-alfa:5', 'proy-beta:2']);
  } finally { e.limpiar(); }
});

test('resumir ordena por uso, deja solo sesiones con 5+ turnos y entrega la forma exacta de --json', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    crearTranscripciones(raiz);
    const r = uso.resumir(uso.recorrer(raiz, 7, AHORA), 7);
    assert.deepEqual(r, { dias: 7, ...ESPERADO });
    assert.deepEqual(Object.keys(r.porModelo), ['modelo-a', 'modelo-b', 'sub:modelo-c', 'sub:modelo-a'], 'de mayor a menor tokens');
    assert.deepEqual(Object.keys(r.porProyecto), ['proy-alfa', 'proy-beta']);
    assert.deepEqual(Object.keys(r), ['dias', 'porModelo', 'porProyecto', 'sesiones', 'arranques']);
  } finally { e.limpiar(); }
});

test('resumir: mediana y p90 salen del primer contexto de las sesiones principales; las de menos de 5 turnos no cuentan', () => {
  const sesion = (proyecto, turnos, cacheLeida, primerContexto) => ({ proyecto, turnos, cacheLeida, primerContexto, maxContexto: primerContexto * 2, modelos: ['m'] });
  const vacio = () => ({ porModelo: new Map(), porProyecto: new Map(), omitidos: 0 });

  const diez = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((p, i) => sesion(`p${i}`, 5 + i, 1000 * (i + 1), p));
  const r = uso.resumir({ ...vacio(), sesiones: [...diez, sesion('corta', 4, 1e9, 5)] }, 7);
  assert.deepEqual(r.arranques, { mediana: 600, p90: 1000, sesiones: 10 });
  assert.equal(r.sesiones[0].proyecto, 'p9', 'la más pesada (más cache leída) va primero');
  assert.equal(r.sesiones.length, 10);

  assert.deepEqual(uso.resumir({ ...vacio(), sesiones: [sesion('sola', 5, 1, 42)] }, 7).arranques, { mediana: 42, p90: 42, sesiones: 1 });
  assert.deepEqual(uso.resumir({ ...vacio(), sesiones: [sesion('a', 5, 1, 10), sesion('b', 5, 1, 20)] }, 7).arranques, { mediana: 20, p90: 20, sesiones: 2 });
  assert.deepEqual(uso.resumir({ ...vacio(), sesiones: [] }, 7).arranques, { mediana: null, p90: null, sesiones: 0 });
});

test('informe imprime las tres tablas y la línea del contexto al arrancar', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    crearTranscripciones(raiz);
    const texto = uso.informe(uso.resumir(uso.recorrer(raiz, 7, AHORA), 7));
    assert.match(texto, /^=== Últimos 7 días · por modelo \(sub: = subagentes\) ===$/m);
    assert.match(texto, /^=== Por proyecto \(top 12\) ===$/m);
    assert.match(texto, /^=== Sesiones principales más pesadas \(contexto del 1er turno = lo que pesa arrancar\) ===$/m);
    assert.match(texto, /^modelo-a\s+turnos\s+6 \| leida-cache\s+14\.0M \|/m);
    assert.match(texto, /^sub:modelo-a\s+turnos\s+2 \|/m);
    assert.match(texto, /^proy-alfa\s+turnos\s+7 \| leida-cache\s+15\.3M \|/m);
    assert.match(texto, /^proy-alfa\s+turnos\s+5 \| 1er turno 1100k \| máx 5000k \| leída 15\.0M \| modelo-a,modelo-b$/m);
    assert.match(texto, /^Contexto al arrancar una sesión: mediana 1100k · p90 1100k · sesiones 1$/m);
    assert.doesNotMatch(texto, /\(sin datos\)/);
  } finally { e.limpiar(); }
});

test('informe recorta a 12 filas la tabla de proyectos y la de sesiones', () => {
  const quince = Array.from({ length: 15 }, (_, i) => `proy-${String(i + 1).padStart(2, '0')}`);
  const fila = { turnos: 9, entrada: 1, cacheLeida: 1e6, cacheEscrita: 1, salida: 1 };
  const resumen = {
    dias: 3,
    porModelo: {},
    porProyecto: Object.fromEntries(quince.map((p) => [p, fila])),
    sesiones: quince.map((p) => ({ proyecto: p, turnos: 9, cacheLeida: 1e6, primerContexto: 1000, maxContexto: 2000, modelos: ['m'] })),
    arranques: { mediana: 1000, p90: 1000, sesiones: 15 },
  };
  const texto = uso.informe(resumen);
  // Filas de una sección: las líneas bajo su título hasta la primera línea en blanco.
  const filas = (titulo) => {
    const bloque = texto.split('\n=== ').find((s) => s.startsWith(titulo)).split('\n').slice(1);
    const fin = bloque.indexOf('');
    return fin < 0 ? bloque : bloque.slice(0, fin);
  };
  assert.equal(filas('Por proyecto').length, 12);
  assert.equal(filas('Sesiones principales').length, 12);
  assert.match(texto, /^=== Últimos 3 días/);
  assert.match(texto, /sesiones 15$/m, 'la línea de arranque cuenta todas las sesiones, no solo las 12 que se listan');
});

test('la línea de comandos entrega el mismo resumen con --json (sin nombres de archivo) y las tablas sin él', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    crearTranscripciones(raiz);
    const env = envCon(e, raiz);

    const conJson = correr(SCRIPT, ['--json'], { env });
    assert.equal(conJson.status, 0, conJson.stderr);
    assert.equal(conJson.stderr, '');
    assert.deepEqual(conJson.json(), { dias: 7, ...ESPERADO });
    assert.doesNotMatch(conJson.stdout, /\.jsonl|sesion-1|sesion-2|agente-1|viejo/, 'el JSON no lleva nombres de archivo');

    const orden = correr(SCRIPT, ['7', '--json'], { env });
    assert.deepEqual(orden.json(), conJson.json(), 'dias y --json en cualquier orden');
    assert.equal(correr(SCRIPT, ['--json', '7'], { env }).stdout, orden.stdout);

    const texto = correr(SCRIPT, [], { env });
    assert.equal(texto.status, 0, texto.stderr);
    assert.equal(texto.stdout, uso.informe(uso.resumir(uso.recorrer(raiz, 7, AHORA), 7)) + '\n', 'el texto sale del mismo resumen');
  } finally { e.limpiar(); }
});

test('la ventana de días filtra por archivo (fecha de modificación) y por línea (marca de tiempo)', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    const sinMarca = JSON.parse(u({ id: 'l4', modelo: 'modelo-a', entrada: 1 }));
    delete sinMarca.timestamp;
    transcripcion(raiz, 'proy-ventana/s.jsonl', [
      u({ id: 'l1', modelo: 'modelo-a', entrada: 1, timestamp: '2026-10-26T12:00:00Z' }), // 4 días antes
      u({ id: 'l2', modelo: 'modelo-a', entrada: 1, timestamp: '2026-10-28T12:00:00Z' }), // 2 días antes
      u({ id: 'l3', modelo: 'modelo-a', entrada: 1, timestamp: '2026-10-30T12:00:00Z' }),
      JSON.stringify(sinMarca),
    ]);
    const turnos = (dias) => (uso.recorrer(raiz, dias, AHORA).porModelo.get('modelo-a') || { turnos: 0 }).turnos;
    assert.equal(turnos(7), 4);
    assert.equal(turnos(5), 4, 'el límite de 5 días queda antes de la línea más vieja (4 días)');
    assert.equal(turnos(3), 3, 'sin la línea de hace 4 días; la que no tiene marca de tiempo se conserva');
    assert.equal(turnos(1), 2, 'solo la de hoy y la que no tiene marca de tiempo');
    assert.equal(turnos(0.01), 0, 'el archivo se modificó hace más de 14 minutos: ni se abre');
    assert.equal(JSON.parse(correr(SCRIPT, ['3', '--json'], { env: envCon(e, raiz) }).stdout).porModelo['modelo-a'].turnos, 3);
  } finally { e.limpiar(); }
});

test('un mensaje sin id usa uuid para no contarse doble; sin id ni uuid cada línea cuenta', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    const base = (extra) => JSON.stringify({ timestamp: '2026-10-30T18:00:00Z', ...extra.linea, message: { model: 'm', usage: { input_tokens: 4 }, ...extra.mensaje } });
    transcripcion(raiz, 'p-uuid/s.jsonl', [
      base({ linea: { uuid: 'x1' }, mensaje: {} }),
      base({ linea: { uuid: 'x1' }, mensaje: {} }), // mismo uuid, sin message.id: repetida
      base({ linea: { uuid: 'x2' }, mensaje: {} }),
    ]);
    transcripcion(raiz, 'p-sin-id/s.jsonl', [base({ linea: {}, mensaje: {} }), base({ linea: {}, mensaje: {} }), base({ linea: {}, mensaje: {} })]);
    const datos = uso.recorrer(raiz, 7, AHORA);
    assert.equal(datos.porProyecto.get('p-uuid').turnos, 2);
    assert.equal(datos.porProyecto.get('p-sin-id').turnos, 3);
  } finally { e.limpiar(); }
});

test('raíz inexistente: salida vacía sin tronar, en texto y en JSON', () => {
  const e = entornoTemporal();
  try {
    const env = envCon(e, path.join(e.dir, 'no-existe'));
    const texto = correr(SCRIPT, [], { env });
    assert.equal(texto.status, 0, texto.stderr);
    assert.equal(texto.stderr, '');
    assert.equal((texto.stdout.match(/\(sin datos\)/g) || []).length, 3, 'las tres tablas salen vacías');
    assert.doesNotMatch(texto.stdout, /turnos +\d/);
    assert.doesNotMatch(texto.stdout, /Contexto al arrancar/);

    const json = correr(SCRIPT, ['--json'], { env });
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(json.json(), { dias: 7, porModelo: {}, porProyecto: {}, sesiones: [], arranques: { mediana: null, p90: null, sesiones: 0 } });
  } finally { e.limpiar(); }
});

test('sin USO_RAIZ lee <carpeta de Claude Code>/projects y dias vale 7 por defecto', () => {
  const e = entornoTemporal();
  try {
    transcripcion(path.join(e.claudeHome, 'projects'), 'proy-casa/s.jsonl', [u({ id: 'c1', modelo: 'modelo-a', entrada: 3 }), u({ id: 'c2', modelo: 'modelo-a', entrada: 4 })]);
    assert.equal(e.env.USO_RAIZ, undefined);
    const r = correr(SCRIPT, ['--json'], { env: e.env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().dias, 7);
    assert.deepEqual(r.json().porProyecto['proy-casa'], { turnos: 2, entrada: 7, cacheLeida: 0, cacheEscrita: 0, salida: 0 });
    // Las variables antiguas de las herramientas personales ya no se leen.
    const viejas = correr(SCRIPT, ['--json'], { env: { ...e.env, USO_PASOS_RAIZ: path.join(e.dir, 'otra'), USO_PASOS_AHORA: '2030-01-01T00:00:00Z' } });
    assert.deepEqual(viejas.json(), r.json());
  } finally { e.limpiar(); }
});

test('uso incorrecto: dias inválido o argumentos de más → código 1 con la forma de uso, sin tablas', () => {
  const e = entornoTemporal();
  try {
    for (const args of [['abc'], ['0'], ['-3'], [''], ['Infinity'], ['7', '8'], ['--nada'], ['7d']]) {
      const r = correr(SCRIPT, args, { env: envCon(e, path.join(e.dir, 'x')) });
      assert.equal(r.status, 1, `args ${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /Uso: node uso-tokens\.cjs \[dias>0\] \[--json\]/);
      assert.equal(r.stdout, '');
    }
    assert.deepEqual(uso.parsearArgumentos([]), { dias: 7, json: false });
    assert.deepEqual(uso.parsearArgumentos(['2.5', '--json']), { dias: 2.5, json: true });
    assert.throws(() => uso.parsearArgumentos(['0']), /mayor que 0/);
  } finally { e.limpiar(); }
});

test('un archivo ilegible se omite, se avisa por stderr y el resto sigue contando', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    transcripcion(raiz, 'proy-ok/bien.jsonl', [u({ id: 'o1', modelo: 'modelo-a', entrada: 2 })]);
    transcripcion(raiz, 'proy-ok/ilegible.jsonl', [u({ id: 'o2', modelo: 'modelo-a', entrada: 100 })]);
    const original = fs.readFileSync;
    fs.readFileSync = function (ruta, ...resto) {
      if (String(ruta).endsWith('ilegible.jsonl')) throw Object.assign(new Error('EACCES simulado'), { code: 'EACCES' });
      return original.call(this, ruta, ...resto);
    };
    let datos;
    try { datos = uso.recorrer(raiz, 7, AHORA); } finally { fs.readFileSync = original; }
    assert.equal(datos.omitidos, 1);
    assert.equal(datos.porModelo.get('modelo-a').entrada, 2);
  } finally { e.limpiar(); }
});

test('privacidad: ni el contenido de la conversación ni los nombres de archivo llegan a la salida', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    const conTexto = (id) => {
      const o = JSON.parse(u({ id, modelo: 'modelo-a', entrada: 10, cacheLeida: 500 }));
      o.message.content = [{ type: 'text', text: 'respuesta con SECRETO-123' }, { type: 'tool_use', id: `t-${id}`, name: 'Bash', input: { command: 'echo SECRETO-123' } }];
      o.cwd = 'carpeta/SECRETO-123';
      o.gitBranch = 'rama-SECRETO-123';
      return JSON.stringify(o);
    };
    const lineas = [1, 2, 3, 4, 5].map((i) => conTexto(`p${i}`));
    lineas.push(JSON.stringify({ type: 'user', timestamp: '2026-10-30T18:00:00Z', message: { role: 'user', content: 'pregunta con SECRETO-123' } }));
    transcripcion(raiz, 'proy-privado/sesion-NOMBRE-DE-ARCHIVO-SECRETO.jsonl', lineas);
    for (const args of [[], ['--json']]) {
      const r = correr(SCRIPT, args, { env: envCon(e, raiz) });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /proy-privado/, 'sí aparece el proyecto: es un dato de uso');
      assert.doesNotMatch(r.stdout + r.stderr, /SECRETO|NOMBRE-DE-ARCHIVO/);
    }
  } finally { e.limpiar(); }
});
