// Pruebas de tools/lint-publicacion.cjs. Ningún archivo se exime por ruta, tampoco este: lo que la lista pública marca
// se arma en tiempo de ejecución, y la lista privada de estas pruebas es FICTICIA (la real no vive en el repositorio).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lintMod = require('../../tools/lint-publicacion.cjs');
const { revisarArchivo, lint, RAIZ } = lintMod;
const { correr, RAIZ_REPO } = require('../helpers/entorno.cjs');

const HERRAMIENTA = path.join(RAIZ_REPO, 'tools', 'lint-publicacion.cjs');
// Lista privada ficticia: en proceso se fija con fijarPrivados; a la línea de comandos le llega por la variable.
const PRIVADA_FICTICIA = ['Fulanito', 'ClienteFicticio', 'cupo\\b', 'Villaficticia', 'usuariodemaquina'].join('\n');
lintMod.fijarPrivados(PRIVADA_FICTICIA);
const ENV_FICTICIO = { ...process.env, UAEH_LINT_PRIVADO: PRIVADA_FICTICIA };
const u = (a, b) => a + b; // une trozos para no escribir la palabra completa aquí
const AUTOR = u('sal', 'louminc');
const EMPRESA = u('Sal', 'loum Inc');

// Escribe un archivo temporal DENTRO del repo (carpeta ignorada por git no sirve: el lint recorre
// lo que le pasan), lo revisa y lo borra.
function revisarTexto(nombre, texto) {
  const dir = path.join(RAIZ, 'tests', 'fixtures', '.tmp-lint');
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, nombre);
  fs.writeFileSync(abs, texto, 'utf8');
  try { return revisarArchivo(path.relative(RAIZ, abs).replace(/\\/g, '/')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('detecta nombres, rutas de máquina y clientes; una por línea con número de línea', () => {
  const texto = [
    'línea limpia',
    `ruta ${u('C:\\Us', 'ers\\alguien')}\\proyecto`,
    `otra ${u('/mnt/c/Us', 'ers/alguien')}`,
    'nombre Fulanito dijo',
    'cliente ClienteFicticio y CUPO',
    `${u('Desk', 'top')}\\cosa`,
    'zona Villaficticia y villaficticia',
    'usuario usuariodemaquina suelto',
  ].join('\n');
  const h = revisarTexto('a.md', texto);
  const lineas = h.map((x) => x.linea);
  assert.deepEqual([...new Set(lineas)], [2, 3, 4, 5, 6, 7, 8]);
  assert.ok(h.every((x) => x.archivo.endsWith('a.md')));
});

test('el nombre público del autor se admite en sus archivos, en la URL del repo y en la firma de ejemplo; suelto, no', () => {
  const limpio = revisarTexto('b.md', `repo https://github.com/${AUTOR}/uaeh-harness · firma de ejemplo: Authored By: ${AUTOR}.com`);
  assert.equal(limpio.length, 0, 'URL del repo y firma de ejemplo se admiten en cualquier archivo');
  assert.equal(revisarTexto('README.es.md', `MIT © 2026 ${EMPRESA} · autor: ${AUTOR}`).length, 0, 'los archivos del autor pueden nombrarlo');
  assert.equal(revisarTexto('g.md', `MIT © 2026 ${EMPRESA}`).length, 1, 'fuera de ellos, el nombre de la empresa se marca');
  const sucio = revisarTexto('c.md', `correo de ${AUTOR} en texto suelto`);
  assert.equal(sucio.length, 1, 'fuera de LICENSE/README/manifiestos, el nombre del autor suelto se marca');
  assert.equal(revisarTexto('README.md', `autor: ${AUTOR}`).length, 0, 'en README sí se admite');
});

test('«uaeh-lint: permitir» exime de la lista pública, nunca de la privada; un nombre armado por partes se detecta; los binarios se saltan', () => {
  assert.equal(revisarTexto('d.md', `ruta ${u('C:\\Us', 'ers\\alguien')} // uaeh-lint: permitir (prueba)`).length, 0, 'lista pública: se exime');
  assert.equal(revisarTexto('d2.md', 'Fulanito // uaeh-lint: permitir (prueba)').length, 1, 'lista privada: no hay excepción por línea');
  assert.equal(revisarTexto('d3.js', "const x = 'Fula' + 'nito';").length, 1, 'armado por partes con +');
  assert.equal(revisarTexto('d4.js', 'const x = "Cliente"   +   `Ficticio`;').length, 1, 'con otras comillas y espacios');
  assert.equal(revisarTexto('d5.js', "const x = 'Fula' + variable + 'nito';").length, 0, 'con una variable en medio no es legible a simple vista');
  assert.equal(revisarTexto('e.png', 'Fulanito').length, 0);
  assert.equal(revisarTexto('f.txt', 'Fulanito\u0000binario').length, 0);
});

test('lint() sobre rutas explícitas y la línea de comandos devuelve 1 con hallazgos y 0 sin ellos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uaeh-lint-'));
  try {
    const sucio = path.join(dir, 'sucio.txt');
    fs.writeFileSync(sucio, 'hola ClienteFicticio\n');
    const limpio = path.join(dir, 'limpio.txt');
    fs.writeFileSync(limpio, 'hola mundo\n');
    const r1 = correr(HERRAMIENTA, [sucio], { env: ENV_FICTICIO });
    assert.equal(r1.status, 1, r1.stdout);
    assert.match(r1.stdout, /sucio\.txt:1/);
    const r2 = correr(HERRAMIENTA, [limpio]);
    assert.equal(r2.status, 0, r2.stdout);
    assert.match(r2.stdout, /OK/);
    const r3 = correr(HERRAMIENTA, [sucio, '--json'], { env: ENV_FICTICIO });
    assert.equal(r3.json().hallazgos.length, 1);
    const r4 = correr(HERRAMIENTA, ['--rara']);
    assert.equal(r4.status, 2);
    const todo = lint({ rutas: [dir] });
    assert.equal(todo.archivos, 2);
    assert.equal(todo.hallazgos.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('terceros: se exime solo lo idéntico a la huella de su UPSTREAM.json y sin parches; lo demás se revisa', () => {
  // Dentro del repo (el lint resuelve contra su raíz); se borra al terminar.
  const base = path.join(RAIZ, 'tests', 'fixtures', '.tmp-lint-terceros');
  const dir = 'tests/fixtures/.tmp-lint-terceros/plugins/p/vendor/lib';
  const abs = (rel) => path.join(RAIZ, ...dir.split('/'), ...rel.split('/'));
  const escribir = (rel, texto) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), texto); };
  const huella = (texto) => require('crypto').createHash('sha256').update(texto.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  const comun = `the cupo of the ${u('desk', 'top')} app\n`; // palabras comunes del inglés que la lista negra marca
  const nombreIntacto = `${u('DESK', 'TOP')}-guia.md`; // nombre de archivo de origen con una palabra de la lista
  const nombreCambiado = `${u('DESK', 'TOP')}-cambiado.md`;
  try {
    escribir('igual.md', comun);
    escribir('crlf.md', comun.replace(/\n/g, '\r\n'));
    escribir(nombreIntacto, 'guide\n');
    escribir(nombreCambiado, 'guide (local)\n');
    escribir('cambiado.md', comun + 'x\n');
    escribir('parcheado.md', comun);
    escribir('sin-declarar.md', comun);
    escribir('PATCHES/0001.md', comun);
    escribir('../fuera.md', comun);
    escribir('UPSTREAM.json', JSON.stringify({
      incluye: `la cupo también y ${nombreIntacto} en prosa`,
      archivos: {
        'igual.md': { sha256: huella(comun) },
        'crlf.md': { sha256: huella(comun) },
        [nombreIntacto]: { origen: `src/${nombreIntacto}`, sha256: huella('guide\n') },
        [nombreCambiado]: { origen: `src/${nombreCambiado}`, sha256: huella('guide\n') },
        'cambiado.md': { sha256: huella(comun) },
        'parcheado.md': { sha256: huella(comun), parches: ['PATCHES/0001.md'] },
        'PATCHES/0001.md': { sha256: huella(comun) },
        '../fuera.md': { sha256: huella(comun) },
      },
    }, null, 2));
    const exentos = lintMod.exentosDeTerceros(RAIZ, [dir]);
    assert.equal(exentos.archivos.size, 3);
    const r = lint({ rutas: [base], exentos });
    assert.equal(r.terceros, 3);
    const prefijo = 'tests/fixtures/.tmp-lint-terceros/plugins/p/vendor/';
    const conHallazgos = [...new Set(r.hallazgos.map((h) => h.archivo.slice(prefijo.length)))].sort();
    // fuera.md: una clave con «..» no exime nada fuera de la carpeta.
    assert.deepEqual(conHallazgos, ['fuera.md', 'lib/PATCHES/0001.md', 'lib/UPSTREAM.json', 'lib/cambiado.md', 'lib/parcheado.md', 'lib/sin-declarar.md'].sort());
    // En UPSTREAM.json: el nombre del archivo intacto (clave y origen) se admite; el del cambiado y la prosa del autor, no.
    const enUp = r.hallazgos.filter((h) => h.archivo.endsWith('/UPSTREAM.json')).map((h) => h.contexto);
    assert.ok(!enUp.some((c) => c.includes('-guia.md') && !c.includes('incluye')), enUp.join('\n'));
    assert.ok(enUp.some((c) => c.includes('incluye')), 'la prosa del autor se revisa');
    assert.equal(enUp.filter((c) => c.includes('-cambiado.md')).length, 2, 'clave y origen del archivo cambiado se revisan');
    // Sin carpetas explícitas manda el manifiesto real, que no declara esta: nada se exime.
    assert.equal(lint({ rutas: [base] }).terceros, 0);
    // UPSTREAM.json ilegible: nada se exime.
    escribir('UPSTREAM.json', '{ no es json');
    assert.equal(lintMod.exentosDeTerceros(RAIZ, [dir]).archivos.size, 0);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('terceros del repo real: el código de origen intacto se exime; parcheados, UPSTREAM.json y PATCHES/ no', () => {
  const exentos = lintMod.exentosDeTerceros().archivos;
  const tiene = (rel) => exentos.has(process.platform === 'win32' ? path.resolve(RAIZ, rel).toLowerCase() : path.resolve(RAIZ, rel));
  assert.ok(tiene('plugins/uaeh-harness/vendor/security-audit/SKILL.md'));
  assert.ok(tiene('plugins/uaeh-harness/vendor/web-interface-guidelines/command.md'));
  assert.ok(tiene('plugins/uaeh-harness/vendor/cyber-neo/LICENSE'));
  assert.ok(!tiene('plugins/uaeh-harness/vendor/cyber-neo/scripts/scan_secrets.py'), 'un archivo parcheado se revisa siempre');
  assert.ok(!tiene('plugins/uaeh-harness/vendor/security-audit/UPSTREAM.json'));
});

test('el repo real está limpio', () => {
  // Con la lista privada REAL si está (variable o archivo local); sin ella, solo la pública.
  const r = correr(HERRAMIENTA, []);
  assert.equal(r.status, 0, r.stdout);
});

test('lista privada: sale de la variable o del archivo local, nunca del repo; sin ella el lint lo dice y sigue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uaeh-lint-priv-'));
  try {
    const f = path.join(dir, 'x.txt');
    fs.writeFileSync(f, 'hola ClienteFicticio\n');
    const con = correr(HERRAMIENTA, [f], { env: ENV_FICTICIO });
    assert.equal(con.status, 1);
    assert.match(con.stdout, /lista privada: 5 patrón\(es\) de variable UAEH_LINT_PRIVADO/);
    assert.doesNotMatch(con.stdout, /cupo|Villaficticia/, 'el informe nunca imprime la lista');
    assert.equal(correr(HERRAMIENTA, [f, '--json'], { env: ENV_FICTICIO }).json().hallazgos[0].patron, '(lista privada)');
    // patrón inválido: aviso, no excepción
    const rota = correr(HERRAMIENTA, [f], { env: { ...process.env, UAEH_LINT_PRIVADO: 'ClienteFicticio\n(sin cerrar' } });
    assert.equal(rota.status, 1);
    assert.match(rota.stdout, /AVISO: lista privada: una línea no es una expresión regular válida/);
    // sin lista (variable vacía): avisa y sigue con la pública. El archivo local puede existir en la máquina del autor:
    // por eso se comprueba la función con la lista soltada y sin variable, no la línea de comandos.
    const limpio = path.join(dir, 'limpio.txt');
    fs.writeFileSync(limpio, 'hola mundo\n');
    const sinLista = correr(HERRAMIENTA, [limpio], { env: { ...process.env, UAEH_LINT_PRIVADO: '' } });
    assert.equal(sinLista.status, 0, sinLista.stdout);
    assert.match(sinLista.stdout, /lista privada: \d+ patrón\(es\) de tools\/lista-negra\.local\.txt|AVISO: sin lista privada/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // El archivo local de la lista está ignorado por git y no está rastreado.
  const git = (args) => require('child_process').spawnSync('git', args, { cwd: RAIZ, encoding: 'utf8' });
  assert.equal(git(['check-ignore', '-q', 'tools/lista-negra.local.txt']).status, 0, 'debe estar en .gitignore');
  assert.equal(git(['ls-files', '--', 'tools/lista-negra.local.txt']).stdout.trim(), '', 'no debe estar rastreado');
  // La lista pública no trae nombres propios: solo el autor (público) y rutas genéricas.
  assert.ok(lintMod.PATRONES.length <= 8, 'un patrón nuevo con un nombre propio va a la lista privada, no aquí');
});
