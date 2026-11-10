// Pruebas de la documentación de usuario (docs/es, docs/en, README, SECURITY). Corren sobre el repo real:
// los dos idiomas tienen las mismas páginas y la misma estructura, los enlaces relativos existen y las
// rutas de scripts citadas existen. No juzgan la redacción.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_REPO } = require('../helpers/entorno.cjs');

const DOCS = path.join(RAIZ_REPO, 'docs');
const IDIOMAS = ['es', 'en'];

function paginas(idioma) {
  return fs.readdirSync(path.join(DOCS, idioma)).filter((n) => n.endsWith('.md')).sort();
}

function leer(abs) {
  return fs.readFileSync(abs, 'utf8');
}

// Texto sin bloques de código cercados: un «# comentario» dentro de un bloque no es un título.
function sinBloques(texto) {
  const fuera = [];
  let dentro = false;
  for (const linea of texto.split('\n')) {
    if (/^\s*(```|~~~)/.test(linea)) { dentro = !dentro; continue; }
    if (!dentro) fuera.push(linea);
  }
  return fuera.join('\n');
}

function titulos(texto) {
  return sinBloques(texto).split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => l.match(/^#+/)[0].length);
}

function enlacesRelativos(texto) {
  const salida = [];
  const re = /\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(sinBloques(texto))) !== null) {
    const destino = m[1];
    if (/^(https?:|mailto:|#)/.test(destino)) continue;
    salida.push(destino.split('#')[0]);
  }
  return salida;
}

function documentosConEnlaces() {
  const lista = ['README.md', 'README.es.md', 'SECURITY.md'].map((n) => path.join(RAIZ_REPO, n));
  for (const idioma of IDIOMAS) for (const n of paginas(idioma)) lista.push(path.join(DOCS, idioma, n));
  return lista;
}

test('docs/es y docs/en tienen exactamente las mismas páginas', () => {
  const es = paginas('es');
  assert.ok(es.length >= 10, `se esperaban al menos 10 páginas en docs/es y hay ${es.length}`);
  assert.ok(es.includes('README.md'), 'falta el índice docs/es/README.md');
  assert.deepEqual(paginas('en'), es);
});

test('cada página tiene la misma estructura de títulos en los dos idiomas', () => {
  for (const nombre of paginas('es')) {
    const es = titulos(leer(path.join(DOCS, 'es', nombre)));
    const en = titulos(leer(path.join(DOCS, 'en', nombre)));
    assert.equal(es[0], 1, `docs/es/${nombre} no empieza con un título de nivel 1`);
    assert.deepEqual(en, es, `docs/en/${nombre} y docs/es/${nombre} no tienen los mismos niveles de título`);
  }
});

test('cada página tiene los mismos bloques de código en los dos idiomas', () => {
  const contar = (texto) => texto.split('\n').filter((l) => /^\s*(```|~~~)/.test(l)).length;
  for (const nombre of paginas('es')) {
    const es = contar(leer(path.join(DOCS, 'es', nombre)));
    const en = contar(leer(path.join(DOCS, 'en', nombre)));
    assert.equal(es % 2, 0, `docs/es/${nombre} tiene un bloque de código sin cerrar`);
    assert.equal(en, es, `docs/en/${nombre} y docs/es/${nombre} no tienen el mismo número de bloques de código`);
  }
});

test('todo enlace relativo de la documentación apunta a un archivo que existe', () => {
  const rotos = [];
  for (const abs of documentosConEnlaces()) {
    for (const destino of enlacesRelativos(leer(abs))) {
      if (!destino) continue;
      const objetivo = path.resolve(path.dirname(abs), decodeURIComponent(destino));
      if (!fs.existsSync(objetivo)) rotos.push(`${path.relative(RAIZ_REPO, abs)} -> ${destino}`);
    }
  }
  assert.deepEqual(rotos, []);
});

test('toda ruta de script del repo citada en la documentación existe', () => {
  const faltan = [];
  const re = /(?:plugins|tools|tests)\/[A-Za-z0-9_./-]+\.(?:cjs|json|js|sh|ps1|toml|yml)\b/g;
  for (const abs of documentosConEnlaces()) {
    for (const ruta of leer(abs).match(re) || []) {
      if (!fs.existsSync(path.join(RAIZ_REPO, ruta))) faltan.push(`${path.relative(RAIZ_REPO, abs)}: ${ruta}`);
    }
  }
  assert.deepEqual(faltan, []);
});

test('cada índice enlaza todas las páginas de su idioma y al otro idioma', () => {
  for (const idioma of IDIOMAS) {
    const indice = leer(path.join(DOCS, idioma, 'README.md'));
    const enlaces = enlacesRelativos(indice);
    for (const nombre of paginas(idioma)) {
      if (nombre === 'README.md') continue;
      assert.ok(enlaces.includes(nombre), `docs/${idioma}/README.md no enlaza ${nombre}`);
    }
    const otro = idioma === 'es' ? 'en' : 'es';
    assert.ok(enlaces.includes(`../${otro}/README.md`), `docs/${idioma}/README.md no enlaza al índice en ${otro}`);
  }
});
