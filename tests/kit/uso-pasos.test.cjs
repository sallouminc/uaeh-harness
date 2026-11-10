// Pruebas de plugins/uaeh-kit/scripts/uso-pasos.cjs con transcripciones inventadas en una casa temporal
// (nunca se leen las reales). Los primeros siete casos son los del script de origen, portados.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, correr, RAIZ_KIT } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_KIT, 'scripts', 'uso-pasos.cjs');
const pasos = require(SCRIPT);

const AHORA = Date.parse('2026-10-30T20:00:00Z'); // la misma hora que fija UAEH_AHORA en el entorno hermético
const RECIENTE = new Date('2026-10-30T19:30:00Z'); // fecha de modificación de los archivos «vivos»
let contador = 0;

// Un paso del asistente con las herramientas indicadas y `leido` tokens de cache leída.
function paso(herrs, leido, extra = {}) {
  contador++;
  const content = herrs.map((h, i) => ({ type: 'tool_use', id: `t${contador}-${i}`, name: h, input: h === 'Bash' ? { command: extra.cmd || `echo ${contador}-${i}` } : {} }));
  return {
    type: 'assistant', timestamp: extra.ts || '2026-10-30T19:00:00Z', isSidechain: !!extra.lateral,
    message: { id: `msg${contador}`, content, usage: { cache_read_input_tokens: leido } },
  };
}

function escribir(ruta, lineas, modificado = RECIENTE) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, lineas.join('\n'), 'utf8');
  fs.utimesSync(ruta, modificado, modificado);
  return ruta;
}

// Una carpeta de transcripciones con una sesión por elemento de `sesiones`. Claude Code escribe una línea por
// bloque de contenido con el mismo id: cada paso se duplica para probar que no cuenta doble.
function carpetaCon(e, sesiones, nombre = 'transcripciones') {
  const raiz = path.join(e.dir, nombre);
  sesiones.forEach((lista, i) => {
    const lineas = [];
    for (const p of lista) { lineas.push(JSON.stringify(p)); lineas.push(JSON.stringify(p)); }
    lineas.push('esto no es json');
    lineas.push(JSON.stringify({ type: 'user', message: { content: 'hola' } }));
    escribir(path.join(raiz, 'proyecto', `s${i}.jsonl`), lineas);
  });
  return raiz;
}

test('cuenta pasos, paralelo y releído sin duplicar líneas del mismo mensaje', () => {
  const e = entornoTemporal();
  try {
    const raiz = carpetaCon(e, [[paso(['Bash'], 100), paso(['Read', 'Grep'], 200), paso([], 50)]]);
    const r = pasos.medir(raiz, 7, AHORA);
    assert.equal(r.sesiones, 1);
    assert.equal(r.turnos, 3);
    assert.equal(r.leido, 350);
    assert.equal(r.conHerr, 2);
    assert.equal(r.paralelos, 1);
  } finally { e.limpiar(); }
});

test('una cadena de 4 pasos sueltos cuenta; una de 3 no; un paso en paralelo la corta', () => {
  const e = entornoTemporal();
  try {
    const raiz = carpetaCon(e, [[
      paso(['Bash'], 10), paso(['Read'], 10), paso(['Grep'], 10), paso(['PowerShell'], 10),
      paso(['Bash', 'Read'], 10),
      paso(['Bash'], 10), paso(['Bash'], 10), paso(['Bash'], 10),
    ]]);
    const r = pasos.medir(raiz, 7, AHORA);
    assert.equal(r.cadenas.n, 1);
    assert.equal(r.cadenas.turnos, 4);
    assert.equal(r.cadenas.leido, 40);
  } finally { e.limpiar(); }
});

test('ediciones uno por uno: 5 seguidas cuentan; Edit y Write juntos en paralelo también son edición', () => {
  const e = entornoTemporal();
  try {
    const raiz = carpetaCon(e, [[
      paso(['Edit'], 1), paso(['Edit'], 1), paso(['Write'], 1), paso(['Edit', 'Write'], 1), paso(['Edit'], 1),
      paso(['Bash'], 1),
      paso(['Edit'], 1), paso(['Edit'], 1),
    ]]);
    const r = pasos.medir(raiz, 7, AHORA);
    assert.equal(r.edicion.n, 1);
    assert.equal(r.edicion.turnos, 5);
  } finally { e.limpiar(); }
});

test('comandos idénticos repetidos: cuenta desde la segunda vez, normaliza espacios y no mezcla sesiones', () => {
  const e = entornoTemporal();
  try {
    const raiz = carpetaCon(e, [
      [paso(['Bash'], 5, { cmd: 'git   status' }), paso(['Bash'], 7, { cmd: 'git status' }), paso(['Bash'], 9, { cmd: 'git status' })],
      [paso(['Bash'], 100, { cmd: 'git status' })],
    ]);
    const r = pasos.medir(raiz, 7, AHORA);
    assert.equal(r.repetidos.n, 2);
    assert.equal(r.repetidos.leido, 16);
  } finally { e.limpiar(); }
});

test('ignora subagentes (isSidechain) y pasos fuera de la ventana de días', () => {
  const e = entornoTemporal();
  try {
    const raiz = carpetaCon(e, [[paso(['Bash'], 10, { lateral: true }), paso(['Bash'], 20, { ts: '2026-10-01T00:00:00Z' }), paso(['Bash'], 30)]]);
    const r = pasos.medir(raiz, 7, AHORA);
    assert.equal(r.turnos, 1);
    assert.equal(r.leido, 30);
  } finally { e.limpiar(); }
});

test('carpeta inexistente: todo en cero, sin tronar', () => {
  const e = entornoTemporal();
  try {
    const r = pasos.medir(path.join(e.dir, 'no-existe'), 7, AHORA);
    assert.equal(r.turnos, 0);
    assert.equal(r.sesiones, 0);
    assert.equal(r.omitidos, 0);
  } finally { e.limpiar(); }
});

test('la línea de comandos imprime el informe con la referencia del autor y no imprime comandos', () => {
  const e = entornoTemporal();
  try {
    const raiz = carpetaCon(e, [[paso(['Bash'], 10, { cmd: 'echo SECRETO-123' }), paso(['Bash'], 10, { cmd: 'echo SECRETO-123' })]]);
    const r = correr(SCRIPT, ['7'], { env: { ...e.env, USO_RAIZ: raiz } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Referencia del autor del método \(oct-2026\): cadenas 34\.1 % de lo releído · paralelo 30\.5 % · 289K por paso\. Meta: menos cadenas y más paralelo sin bajar la calidad\./);
    assert.doesNotMatch(r.stdout, /Base 27-oct|27-oct-2026/, 'la línea ya no lleva fecha personal');
    assert.match(r.stdout, /Comandos idénticos repetidos en la misma sesión: 1/);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRETO/);

    const malo = correr(SCRIPT, ['abc'], { env: e.env });
    assert.equal(malo.status, 1);
  } finally { e.limpiar(); }
});

test('uso incorrecto: dias inválido o argumentos de más → código 1 con la forma de uso', () => {
  const e = entornoTemporal();
  try {
    for (const args of [['abc'], ['0'], ['-1'], [''], ['Infinity'], ['7', '8']]) {
      const r = correr(SCRIPT, args, { env: e.env });
      assert.equal(r.status, 1, `args ${JSON.stringify(args)}`);
      assert.match(r.stderr, /Uso: node uso-pasos\.cjs \[dias>0\]/);
      assert.equal(r.stdout, '');
    }
    assert.deepEqual(pasos.parsearArgumentos([]), { dias: 7 });
    assert.deepEqual(pasos.parsearArgumentos(['30']), { dias: 30 });
  } finally { e.limpiar(); }
});

test('sin argumentos mide 7 días y toma la hora de UAEH_AHORA y la raíz de USO_RAIZ; las variables antiguas ya no se leen', () => {
  const e = entornoTemporal();
  try {
    const raiz = carpetaCon(e, [[paso(['Bash'], 10), paso(['Read'], 10)]]);
    const r = correr(SCRIPT, [], { env: { ...e.env, USO_RAIZ: raiz, USO_PASOS_RAIZ: path.join(e.dir, 'otra'), USO_PASOS_AHORA: '2030-01-01T00:00:00Z' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Últimos 7 días · 1 sesiones principales · 2 pasos /);

    // Con otra hora de referencia la misma sesión queda fuera de la ventana.
    const lejos = correr(SCRIPT, [], { env: { ...e.env, USO_RAIZ: raiz, UAEH_AHORA: '2026-12-31T00:00:00Z' } });
    assert.match(lejos.stdout, /^Últimos 7 días · 0 sesiones principales · 0 pasos /);
  } finally { e.limpiar(); }
});

test('sin USO_RAIZ lee <carpeta de Claude Code>/projects', () => {
  const e = entornoTemporal();
  try {
    carpetaCon(e, [[paso(['Bash'], 10), paso(['Bash'], 20), paso(['Bash'], 30)]], path.join('casa', '.claude', 'projects'));
    assert.equal(e.env.USO_RAIZ, undefined);
    const r = correr(SCRIPT, ['7'], { env: e.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Últimos 7 días · 1 sesiones principales · 3 pasos · releído 0M · 0K por paso/);
  } finally { e.limpiar(); }
});

test('un mensaje repartido en varias líneas (una por bloque) es un solo paso en paralelo y toma el mayor releído', () => {
  const e = entornoTemporal();
  try {
    const bloque = (idBloque, nombre, leido) => ({
      type: 'assistant', timestamp: '2026-10-30T19:00:00Z', isSidechain: false,
      message: { id: 'msg-unico', content: [{ type: 'tool_use', id: idBloque, name: nombre, input: {} }], usage: { cache_read_input_tokens: leido } },
    });
    const raiz = path.join(e.dir, 'transcripciones');
    escribir(path.join(raiz, 'proyecto', 's.jsonl'), [bloque('b1', 'Read', 100), bloque('b2', 'Grep', 120), bloque('b2', 'Grep', 120)].map((o) => JSON.stringify(o)));
    const r = pasos.medir(raiz, 7, AHORA);
    assert.equal(r.turnos, 1);
    assert.equal(r.conHerr, 1);
    assert.equal(r.paralelos, 1, 'dos herramientas distintas en el mismo mensaje; el bloque repetido no suma');
    assert.equal(r.leido, 120);
  } finally { e.limpiar(); }
});

test('una línea sin marca de tiempo se conserva (no se descarta como si fuera vieja)', () => {
  const e = entornoTemporal();
  try {
    const sinMarca = paso(['Bash'], 40);
    delete sinMarca.timestamp;
    const raiz = carpetaCon(e, [[sinMarca, paso(['Bash'], 60, { ts: '2026-10-01T00:00:00Z' })]]);
    const r = pasos.medir(raiz, 7, AHORA);
    assert.equal(r.turnos, 1);
    assert.equal(r.leido, 40);
  } finally { e.limpiar(); }
});

test('un archivo sin tocar dentro de la ventana no se lee, y las subcarpetas (subagentes) no se miden', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    const lineas = (n) => [JSON.stringify(paso(['Bash'], n))];
    escribir(path.join(raiz, 'proyecto', 'antiguo.jsonl'), lineas(1000), new Date('2026-09-01T00:00:00Z'));
    escribir(path.join(raiz, 'proyecto', 'sesion-1', 'subagents', 'agente.jsonl'), lineas(2000));
    escribir(path.join(raiz, 'proyecto', 'vivo.jsonl'), lineas(7));
    const r = pasos.medir(raiz, 7, AHORA);
    assert.equal(r.sesiones, 1);
    assert.equal(r.leido, 7);
  } finally { e.limpiar(); }
});

test('un archivo ilegible se omite y se cuenta; el resto sigue', () => {
  const e = entornoTemporal();
  try {
    const raiz = path.join(e.dir, 'transcripciones');
    escribir(path.join(raiz, 'proyecto', 'bien.jsonl'), [JSON.stringify(paso(['Bash'], 5))]);
    escribir(path.join(raiz, 'proyecto', 'ilegible.jsonl'), [JSON.stringify(paso(['Bash'], 500))]);
    const original = fs.readFileSync;
    fs.readFileSync = function (ruta, ...resto) {
      if (String(ruta).endsWith('ilegible.jsonl')) throw Object.assign(new Error('EACCES simulado'), { code: 'EACCES' });
      return original.call(this, ruta, ...resto);
    };
    let r;
    try { r = pasos.medir(raiz, 7, AHORA); } finally { fs.readFileSync = original; }
    assert.equal(r.omitidos, 1);
    assert.equal(r.sesiones, 1);
    assert.equal(r.leido, 5);
  } finally { e.limpiar(); }
});

test('informe: formato exacto con cifras calculadas a mano, también en cero', () => {
  const r = {
    sesiones: 2, turnos: 10, leido: 5000000, conHerr: 8, paralelos: 2,
    cadenas: { n: 1, turnos: 4, leido: 2000000 }, edicion: { n: 0, turnos: 0, leido: 0 }, repetidos: { n: 3, leido: 500000 },
  };
  assert.deepEqual(pasos.informe(r, 7).split('\n'), [
    'Últimos 7 días · 2 sesiones principales · 10 pasos · releído 5M · 500K por paso',
    'Pasos con herramientas en paralelo: 25.0 % (2 de 8)',
    'Cadenas de 4+ comandos o lecturas sueltos: 1 · 40.0 % de los pasos · 40.0 % de lo releído',
    'Ediciones uno por uno (5+ seguidas): 0 · 0.0 % de lo releído',
    'Comandos idénticos repetidos en la misma sesión: 3 · 10.0 % de lo releído',
    'Referencia del autor del método (oct-2026): cadenas 34.1 % de lo releído · paralelo 30.5 % · 289K por paso. Meta: menos cadenas y más paralelo sin bajar la calidad.',
  ]);
  const e = entornoTemporal();
  try {
    const lineas = pasos.informe(pasos.medir(path.join(e.dir, 'no-existe'), 30, AHORA), 30).split('\n');
    assert.equal(lineas[0], 'Últimos 30 días · 0 sesiones principales · 0 pasos · releído 0M · 0K por paso');
    assert.equal(lineas[1], 'Pasos con herramientas en paralelo: 0.0 % (0 de 0)');
  } finally { e.limpiar(); }
  assert.equal(pasos.pct(1, 3), '33.3');
  assert.equal(pasos.pct(5, 0), '0.0');
  assert.deepEqual(pasos.REFERENCIA, { cadenas: 34.1, paralelo: 30.5, porPaso: 289 });
});
