// Pruebas de tools/importar-lista-blanca.cjs. Herméticas: las carpetas K/ y X/, el repo de destino y el
// manifiesto viven en una casa temporal y se pasan con --raiz-k, --raiz-x, --raiz y --manifiesto.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, correr, RAIZ_REPO } = require('../helpers/entorno.cjs');
const { parsearManifiesto, leerManifiesto } = require('../../tools/importar-lista-blanca.cjs');

const HERRAMIENTA = path.join(RAIZ_REPO, 'tools', 'importar-lista-blanca.cjs');
const BOM = String.fromCharCode(0xFEFF);

const MANIFIESTO = [
  '# prueba · comentario de cabecera',
  '',
  '[importados]',
  'K/hooks/igual.js -> plugins/p/hooks/igual.js   # comentario al final de la línea',
  'K/hooks/distinto.js -> plugins/p/hooks/distinto.js',
  'K/hooks/falta-origen.js -> plugins/p/hooks/falta-origen.js',
  'K/hooks/falta-destino.js -> plugins/p/hooks/falta-destino.js',
  'X/agentes/uno.toml -> plugins/p/agentes/uno.toml',
  '',
  '[nuevos]',
  '   # un comentario sangrado',
  'plugins/p/README.md',
  '',
  '[Grandes-Permitidos]',
  'plugins/p/datos.json',
  '',
].join('\n');

// Casa temporal con una entrada de cada estado: IGUAL (el origen tiene CRLF y el destino LF), DISTINTO,
// FALTA-ORIGEN (con destino presente) y dos FALTA-DESTINO (una de K/ y otra de X/).
function escenario(t, texto = MANIFIESTO) {
  const e = entornoTemporal('uaeh-importar-');
  t.after(() => e.limpiar());
  const k = e.claudeHome;
  const x = path.join(e.dir, 'codex');
  const repo = path.join(e.dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const manifiesto = e.escribir('manifiesto.txt', texto);
  e.escribir(path.join(k, 'hooks', 'igual.js'), 'const a = 1;\r\nconst b = 2;\r\n');
  e.escribir(path.join(repo, 'plugins/p/hooks/igual.js'), 'const a = 1;\nconst b = 2;\n');
  e.escribir(path.join(k, 'hooks', 'distinto.js'), 'versión del origen\n');
  e.escribir(path.join(repo, 'plugins/p/hooks/distinto.js'), 'versión editada del destino\n');
  e.escribir(path.join(repo, 'plugins/p/hooks/falta-origen.js'), 'solo existe el destino\n');
  e.escribir(path.join(k, 'hooks', 'falta-destino.js'), 'contenido nuevo\n');
  e.escribir(path.join(x, 'agentes', 'uno.toml'), 'name = "uno"\n');
  const leer = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
  const existe = (rel) => fs.existsSync(path.join(repo, rel));
  const base = ['--manifiesto', manifiesto, '--raiz', repo, '--raiz-k', k, '--raiz-x', x];
  const ejecutar = (...extra) => correr(HERRAMIENTA, [...base, ...extra], { env: e.env, cwd: e.dir });
  return { e, k, x, repo, manifiesto, leer, existe, base, ejecutar };
}

const fila = (estado, origen, destino) => new RegExp(`^${estado}\\s+${origen.replace(/[./]/g, '\\$&')} -> ${destino.replace(/[./]/g, '\\$&')}$`, 'm');

test('en seco informa IGUAL, DISTINTO, FALTA-ORIGEN y FALTA-DESTINO y no escribe nada', (t) => {
  const s = escenario(t);
  const r = s.ejecutar();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /EN SECO/);
  assert.match(r.stdout, fila('IGUAL', 'K/hooks/igual.js', 'plugins/p/hooks/igual.js'), 'CRLF y LF no cuentan como diferencia');
  assert.match(r.stdout, fila('DISTINTO', 'K/hooks/distinto.js', 'plugins/p/hooks/distinto.js'));
  assert.match(r.stdout, fila('FALTA-ORIGEN', 'K/hooks/falta-origen.js', 'plugins/p/hooks/falta-origen.js'));
  assert.match(r.stdout, fila('FALTA-DESTINO', 'K/hooks/falta-destino.js', 'plugins/p/hooks/falta-destino.js'));
  assert.match(r.stdout, fila('FALTA-DESTINO', 'X/agentes/uno.toml', 'plugins/p/agentes/uno.toml'), 'X/ se resuelve con --raiz-x');
  assert.match(r.stdout, /5 entrada\(s\) — 1 IGUAL · 1 DISTINTO · 1 FALTA-ORIGEN · 2 FALTA-DESTINO · nada escrito/);
  assert.equal(s.existe('plugins/p/hooks/falta-destino.js'), false);
  assert.equal(s.existe('plugins/p/agentes/uno.toml'), false);
  assert.equal(s.leer('plugins/p/hooks/distinto.js'), 'versión editada del destino\n');
});

test('--aplicar copia SOLO lo que falta en el destino y deja intacto lo demás', (t) => {
  const s = escenario(t);
  s.e.escribir(path.join(s.repo, 'plugins/p/hooks/extra.js'), 'no figura en el manifiesto\n');
  const r = s.ejecutar('--aplicar');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /APLICANDO/);
  assert.match(r.stdout, /FALTA-DESTINO\s+K\/hooks\/falta-destino\.js -> plugins\/p\/hooks\/falta-destino\.js\s+→ COPIADO/);
  assert.match(r.stdout, /DISTINTO\s+K\/hooks\/distinto\.js -> plugins\/p\/hooks\/distinto\.js\s+→ OMITIDO \(el destino existe y difiere; usa --forzar/);
  assert.match(r.stdout, /2 copiado\(s\), 0 pisado\(s\), 1 omitido\(s\), 0 con error/);
  assert.equal(s.leer('plugins/p/hooks/falta-destino.js'), 'contenido nuevo\n');
  assert.equal(s.leer('plugins/p/agentes/uno.toml'), 'name = "uno"\n');
  assert.equal(s.leer('plugins/p/hooks/distinto.js'), 'versión editada del destino\n', 'un destino editado no se pisa sin --forzar');
  assert.equal(s.leer('plugins/p/hooks/igual.js'), 'const a = 1;\nconst b = 2;\n', 'lo IGUAL no se toca');
  assert.equal(s.leer('plugins/p/hooks/falta-origen.js'), 'solo existe el destino\n');
  assert.equal(s.leer('plugins/p/hooks/extra.js'), 'no figura en el manifiesto\n', 'nunca borra');
  // Segunda vuelta: lo copiado ya está IGUAL y nada más cambia.
  const de_nuevo = s.ejecutar();
  assert.match(de_nuevo.stdout, /3 IGUAL · 1 DISTINTO · 1 FALTA-ORIGEN · 0 FALTA-DESTINO/);
});

test('--forzar solo pisa los destinos que difieren y únicamente junto con --aplicar', (t) => {
  const s = escenario(t);
  const sola = s.ejecutar('--forzar');
  assert.equal(sola.status, 0);
  assert.match(sola.stdout, /--forzar solo tiene efecto junto con --aplicar/);
  assert.equal(s.leer('plugins/p/hooks/distinto.js'), 'versión editada del destino\n');
  assert.equal(s.existe('plugins/p/hooks/falta-destino.js'), false, '--forzar sin --aplicar sigue siendo en seco');

  const r = s.ejecutar('--aplicar', '--forzar');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DISTINTO\s+K\/hooks\/distinto\.js -> plugins\/p\/hooks\/distinto\.js\s+→ PISADO/);
  assert.match(r.stdout, /2 copiado\(s\), 1 pisado\(s\), 0 omitido\(s\), 0 con error/);
  assert.equal(s.leer('plugins/p/hooks/distinto.js'), 'versión del origen\n');
  assert.equal(s.leer('plugins/p/hooks/igual.js'), 'const a = 1;\nconst b = 2;\n', 'lo IGUAL tampoco se reescribe con --forzar');
  assert.equal(s.leer('plugins/p/hooks/falta-origen.js'), 'solo existe el destino\n', 'sin origen no hay nada que pisar');
});

test('--solo limita todo a una entrada y exige que exista', (t) => {
  const s = escenario(t);
  const r = s.ejecutar('--solo', 'plugins/p/hooks/falta-destino.js', '--aplicar');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 entrada\(s\)/);
  assert.doesNotMatch(r.stdout, /uno\.toml/);
  assert.equal(s.existe('plugins/p/hooks/falta-destino.js'), true);
  assert.equal(s.existe('plugins/p/agentes/uno.toml'), false, 'las demás entradas no se tocan');
  const mala = s.ejecutar('--solo', 'plugins/p/no-esta.js');
  assert.equal(mala.status, 2);
  assert.match(mala.stderr, /--solo: ningún destino del manifiesto coincide/);
});

test('el BOM del origen y una carpeta en lugar de archivo se tratan como corresponde', (t) => {
  const s = escenario(t, [
    '[importados]',
    'K/con-bom.md -> plugins/p/con-bom.md',
    'K/carpeta -> plugins/p/carpeta',
  ].join('\n'));
  s.e.escribir(path.join(s.k, 'con-bom.md'), `${BOM}hola\r\n`);
  s.e.escribir(path.join(s.repo, 'plugins/p/con-bom.md'), 'hola\n');
  fs.mkdirSync(path.join(s.k, 'carpeta'), { recursive: true });
  const r = s.ejecutar();
  assert.match(r.stdout, fila('IGUAL', 'K/con-bom.md', 'plugins/p/con-bom.md'), 'el BOM no cuenta como diferencia');
  assert.match(r.stdout, fila('FALTA-ORIGEN', 'K/carpeta', 'plugins/p/carpeta'), 'no se importa por carpeta');
});

test('sin --raiz-k ni --raiz-x, K/ y X/ salen de CLAUDE_CONFIG_DIR y CODEX_HOME', (t) => {
  const s = escenario(t);
  const env = { ...s.e.env, CODEX_HOME: s.x };
  const r = correr(HERRAMIENTA, ['--manifiesto', s.manifiesto, '--raiz', s.repo], { env, cwd: s.e.dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /5 entrada\(s\) — 1 IGUAL · 1 DISTINTO · 1 FALTA-ORIGEN · 2 FALTA-DESTINO/);
  assert.ok(r.stdout.includes(`K/ = ${s.e.claudeHome}`), r.stdout);
  assert.ok(r.stdout.includes(`X/ = ${s.x}`), r.stdout);
});

test('el analizador devuelve importados, nuevos y grandes y descarta comentarios y líneas vacías', () => {
  const m = parsearManifiesto(MANIFIESTO);
  assert.deepEqual(m.importados, [
    { origen: 'K/hooks/igual.js', destino: 'plugins/p/hooks/igual.js' },
    { origen: 'K/hooks/distinto.js', destino: 'plugins/p/hooks/distinto.js' },
    { origen: 'K/hooks/falta-origen.js', destino: 'plugins/p/hooks/falta-origen.js' },
    { origen: 'K/hooks/falta-destino.js', destino: 'plugins/p/hooks/falta-destino.js' },
    { origen: 'X/agentes/uno.toml', destino: 'plugins/p/agentes/uno.toml' },
  ]);
  assert.deepEqual(m.nuevos, ['plugins/p/README.md']);
  assert.deepEqual(m.grandes, ['plugins/p/datos.json']);
  // CRLF, BOM y barras invertidas se toleran.
  const crlf = parsearManifiesto(BOM + '[importados]\r\nK\\a\\b.js -> plugins\\x\\b.js\r\n[nuevos]\r\nplugins/x/c.md\r\n');
  assert.deepEqual(crlf.importados, [{ origen: 'K/a/b.js', destino: 'plugins/x/b.js' }]);
  assert.deepEqual(crlf.nuevos, ['plugins/x/c.md']);
  assert.deepEqual(m.terceros, []);
});

test('el analizador acepta [terceros] como carpetas plugins/<p>/vendor/<nombre> y rechaza lo demás', () => {
  const m = parsearManifiesto('[terceros]\nplugins/p/vendor/lib-a\nplugins\\p\\vendor\\lib-b\n');
  assert.deepEqual(m.terceros, ['plugins/p/vendor/lib-a', 'plugins/p/vendor/lib-b']);
  const rechaza = (texto, patron) => assert.throws(() => parsearManifiesto(texto, 'm.txt'), patron);
  rechaza('[terceros]\nplugins/p/lib-a', /m\.txt:2: «plugins\/p\/lib-a» debe ser una carpeta plugins\/<plugin>\/vendor\/<nombre>/);
  rechaza('[terceros]\nplugins/p/vendor/lib-a/sub', /m\.txt:2: .*vendor\/<nombre>/);
  rechaza('[terceros]\nplugins/p/vendor/../x', /m\.txt:2:/);
  rechaza('[terceros]\nplugins/p/vendor/lib-a\nplugins/p/vendor/lib-a', /m\.txt:3: .*ya está declarado/);
});

test('el analizador rechaza con número de línea lo que está mal formado', () => {
  const rechaza = (texto, patron) => assert.throws(() => parsearManifiesto(texto, 'm.txt'), patron);
  rechaza('[importados]\nK/a.js plugins/a.js', /m\.txt:2: se esperaba «K\/origen -> destino»/);
  rechaza('[raros]\n', /m\.txt:1: sección desconocida «raros»/);
  rechaza('plugins/a.js\n', /m\.txt:1: entrada fuera de una sección/);
  rechaza('[importados]\nA/a.js -> plugins/a.js', /m\.txt:2: el origen/);
  rechaza('[importados]\nK/../a.js -> plugins/a.js', /m\.txt:2: el origen/);
  rechaza('[importados]\nK/a.js -> ../fuera.js', /m\.txt:2: el destino/);
  rechaza('[importados]\nK/a.js -> /absoluto.js', /m\.txt:2: el destino/);
  rechaza('[importados]\nK/carpeta/ -> plugins/carpeta/', /m\.txt:2:/);
  rechaza('[importados]\nK/a.js -> plugins/a.js\nK/b.js -> plugins/a.js', /m\.txt:3: el destino «plugins\/a\.js» ya está declarado/);
  rechaza('[importados]\nK/a.js -> plugins/a.js\n[nuevos]\nplugins/a.js', /m\.txt:4: «plugins\/a\.js» ya está declarado/);
  rechaza('[nuevos]\n../fuera.md', /m\.txt:2:/);
});

test('manifiesto inexistente o ilegible y uso incorrecto salen con 2', (t) => {
  const s = escenario(t);
  const falta = correr(HERRAMIENTA, ['--manifiesto', path.join(s.e.dir, 'no-existe.txt'), '--raiz', s.repo], { env: s.e.env, cwd: s.e.dir });
  assert.equal(falta.status, 2);
  assert.match(falta.stderr, /no se pudo leer el manifiesto/);
  assert.throws(() => leerManifiesto(path.join(s.e.dir, 'no-existe.txt')), /no se pudo leer el manifiesto/);

  const roto = s.e.escribir('roto.txt', '[importados]\nsin flecha\n');
  const r = correr(HERRAMIENTA, ['--manifiesto', roto, '--raiz', s.repo], { env: s.e.env, cwd: s.e.dir });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /roto\.txt:2:/);

  assert.equal(s.ejecutar('--rara').status, 2);
  const sinValor = correr(HERRAMIENTA, ['--solo'], { env: s.e.env, cwd: s.e.dir });
  assert.equal(sinValor.status, 2);
  assert.match(sinValor.stderr, /falta el valor de --solo/);
});

test('el manifiesto real del repo parsea y declara las 15 importaciones de la capa 1', () => {
  const m = leerManifiesto(path.join(RAIZ_REPO, 'tools', 'manifiesto-importacion.txt'));
  assert.ok(m.importados.length >= 15, `importados: ${m.importados.length}`);
  assert.ok(m.importados.every((e) => /^[KX]\//.test(e.origen) && e.destino.startsWith('plugins/')));
  assert.ok(m.nuevos.includes('plugins/uaeh-kit/.claude-plugin/plugin.json'));
  assert.ok(m.importados.some((e) => e.origen === 'K/hooks/router-context-inject.js' && e.destino === 'plugins/uaeh-kit/hooks/inyectar-contexto.js'));
  assert.ok(m.terceros.includes('plugins/uaeh-harness/vendor/cyber-neo'));
});
