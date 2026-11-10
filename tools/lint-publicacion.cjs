#!/usr/bin/env node
// tools/lint-publicacion.cjs — lista negra de publicación.
//
// Este repositorio nace de la configuración personal de su autor, donde conviven credenciales,
// rutas de máquina y nombres de terceros con el código que sí se publica. Antes de cada commit
// (y en CI) se busca en todos los archivos rastreados, preparados y nuevos cualquier rastro de
// esa procedencia. Un hallazgo = exit 1.
//
// Uso: node tools/lint-publicacion.cjs [--json] [--todo] [ruta ...]
//   sin rutas → archivos rastreados + preparados + nuevos no ignorados (git)
//   --todo    → además recorre el disco (por si git no está disponible)
//   ruta ...  → solo esos archivos o carpetas
//
// Dos listas:
//   · PÚBLICA (abajo): rutas de una máquina concreta y el nombre público del autor fuera de sus archivos.
//   · PRIVADA: los nombres propios que no deben aparecer (usuario de la máquina, personas, clientes, proveedores).
//     NO vive en el repositorio: una lista de nombres prohibidos publicada sería, ella misma, la filtración. Se lee de
//     la variable UAEH_LINT_PRIVADO (texto; en la CI, un secreto) o, si no existe, del archivo
//     tools/lista-negra.local.txt (ignorado por git). Formato: una expresión regular por línea; «#» comenta.
//     Sin lista privada el lint corre solo con la pública y lo dice (así pasa en el fork de un colaborador).
//
// Excepciones:
//   · LICENSE, README*.md, THIRD_PARTY_NOTICES.md, CHANGELOG.md, SECURITY.md, .claude-plugin/*.json y
//     package.json pueden nombrar al autor. En todos los demás archivos, el nombre del autor solo se admite en la
//     URL del repositorio y en la firma de ejemplo «Authored By: …».
//   · Una línea con el comentario «uaeh-lint: permitir» se exime de la lista PÚBLICA (úsalo solo con motivo escrito al
//     lado). La lista privada no admite esa excepción, y se busca también con los literales unidos ('ab' + 'cd').
//   · Ningún archivo se exime por ruta: tampoco este ni su prueba.
//   · Código de terceros idéntico a su origen: un archivo de una carpeta de [terceros] del manifiesto cuya huella
//     (sha256 con LF) es la que declara su UPSTREAM.json, y que no lleva parches, es texto del proyecto de origen y no
//     puede traer rastros de esta máquina; sus palabras comunes no son hallazgos. Basta un byte cambiado para que la
//     huella deje de coincidir y el archivo se revise como cualquier otro. UPSTREAM.json, PATCHES/ y los archivos
//     parcheados se revisan siempre; dentro de UPSTREAM.json solo se admiten los nombres de archivo (clave y «origen»)
//     de lo que se eximió, que también son del proyecto de origen. Que las huellas sean las de upstream lo comprueba
//     verificar-publicacion («terceros»).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');

// Lista PÚBLICA. Un patrón por línea; insensible a mayúsculas. Los literales se arman por partes para que este archivo
// no se marque a sí mismo.
const AUTOR = 'sal' + 'louminc';
const PATRONES = [
  new RegExp(AUTOR), new RegExp('Sal' + 'loum\\s+Inc'),            // nombre público del autor: solo en sus archivos, URL del repo y firma de ejemplo
  new RegExp('C:[\\\\/]+Us' + 'ers', 'i'), new RegExp('/mnt/c/Us' + 'ers', 'i'), new RegExp('/Us' + 'ers/[a-z]'),   // rutas de una máquina concreta
  new RegExp('Desk' + 'top'), new RegExp('Escri' + 'torio\\\\'),
];

// Lista PRIVADA (ver la cabecera). Devuelve { patrones: RegExp[], origen: texto, avisos: [] }. Nunca lanza.
const ARCHIVO_PRIVADO = path.join(__dirname, 'lista-negra.local.txt');
let privadosFijados = null;
function leerPrivados(texto, origen) {
  const patrones = []; const avisos = [];
  for (const cruda of String(texto).split(/\r?\n/)) {
    const l = cruda.trim();
    if (!l || l.startsWith('#')) continue;
    try { patrones.push(new RegExp(l)); } catch { avisos.push('lista privada: una línea no es una expresión regular válida (se ignora)'); }
  }
  return { patrones, origen, avisos };
}
function cargarPrivados() {
  if (privadosFijados) return privadosFijados;
  const env = process.env.UAEH_LINT_PRIVADO;
  if (typeof env === 'string' && env.trim()) return leerPrivados(env, 'variable UAEH_LINT_PRIVADO');
  try { return leerPrivados(fs.readFileSync(ARCHIVO_PRIVADO, 'utf8'), 'tools/lista-negra.local.txt'); } catch { /* sin archivo */ }
  return { patrones: [], origen: null, avisos: [] };
}
// Para las pruebas: fija la lista privada (texto) o la suelta (null).
function fijarPrivados(texto) { privadosFijados = texto == null ? null : leerPrivados(texto, 'fijada por una prueba'); }
const ARCHIVOS_DEL_AUTOR = new Set([
  'LICENSE', 'README.md', 'README.es.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'SECURITY.md', 'package.json',
]);
const EXT_BINARIAS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.pptx', '.docx', '.xlsx', '.woff', '.woff2', '.ttf', '.zip', '.gz', '.xz', '.tar']);

// Lo que se admite en cualquier archivo: URL del repo y firma de ejemplo. Se borra antes de buscar.
const ADMITIDO_EN_TODOS = [
  new RegExp('github\\.com/' + AUTOR + '/[A-Za-z0-9._-]+', 'g'),
  new RegExp('Authored By: ' + AUTOR + '\\.com', 'g'),
  new RegExp(AUTOR + '/uaeh-harness', 'g'),
];

function esDelAutor(rel) {
  const base = path.basename(rel);
  if (ARCHIVOS_DEL_AUTOR.has(base)) return true;
  return /(^|\/)\.claude-plugin\/(plugin|marketplace)\.json$/.test(rel) || /^README(\.[a-z]{2})?\.md$/.test(base);
}

function listarConGit() {
  const correr = (args) => {
    const r = spawnSync('git', args, { cwd: RAIZ, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  };
  const vistos = new Set();
  for (const f of [...correr(['ls-files', '-z']).join('').split('\0'), ...correr(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).join('').split('\0'), ...correr(['ls-files', '--others', '--exclude-standard', '-z']).join('').split('\0')]) {
    if (f) vistos.add(f.replace(/\\/g, '/'));
  }
  return [...vistos].sort();
}

function listarDisco(dir, acumulado = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listarDisco(p, acumulado);
    else acumulado.push(path.relative(RAIZ, p).replace(/\\/g, '/'));
  }
  return acumulado;
}

function esBinario(rel, buf) {
  if (EXT_BINARIAS.has(path.extname(rel).toLowerCase())) return true;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Clave de comparación de rutas absolutas (Windows no distingue mayúsculas).
const claveRuta = (abs) => (process.platform === 'win32' ? path.resolve(abs).toLowerCase() : path.resolve(abs));
const huellaLf = (buf) => crypto.createHash('sha256').update(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
const sinBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// Terceros idénticos a su origen (ver la cabecera) → { archivos, nombres }:
//   archivos  Set de claves de ruta absoluta de los archivos eximidos;
//   nombres   Map clave de cada UPSTREAM.json → nombres de archivo admitidos en él (clave y «origen» de lo eximido).
// carpetas: las de [terceros] (relativas a raiz); sin ellas se leen de tools/manifiesto-importacion.txt de raiz.
// Todo lo que no se puede leer o no cuadra se queda SIN eximir.
function exentosDeTerceros(raiz = RAIZ, carpetas = null) {
  const terceros = { archivos: new Set(), nombres: new Map() };
  if (!carpetas) {
    try {
      const { leerManifiesto } = require('./importar-lista-blanca.cjs');
      carpetas = leerManifiesto(path.join(raiz, 'tools', 'manifiesto-importacion.txt')).terceros || [];
    } catch { return terceros; }
  }
  for (const dir of carpetas) {
    const rutaUp = path.resolve(raiz, dir, 'UPSTREAM.json');
    let up;
    try { up = JSON.parse(sinBom(fs.readFileSync(rutaUp, 'utf8'))); } catch { continue; }
    if (!up || typeof up.archivos !== 'object' || !up.archivos) continue;
    const nombres = [];
    for (const [rel, info] of Object.entries(up.archivos)) {
      const partes = String(rel).split('/');
      if (!rel || path.isAbsolute(rel) || partes.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\'))) continue;
      if (rel === 'UPSTREAM.json' || partes[0] === 'PATCHES') continue;
      if (!info || !/^[0-9a-f]{64}$/.test(String(info.sha256 || '')) || info.parches !== undefined || info.sha256_upstream !== undefined) continue;
      const abs = path.resolve(raiz, dir, ...partes);
      let buf;
      try { buf = fs.readFileSync(abs); } catch { continue; }
      if (huellaLf(buf) !== info.sha256) continue;
      terceros.archivos.add(claveRuta(abs));
      nombres.push(rel);
      if (typeof info.origen === 'string' && info.origen) nombres.push(info.origen);
    }
    // Primero los de más caracteres: «a/b/x.md» antes que «x.md».
    if (nombres.length) terceros.nombres.set(claveRuta(rutaUp), [...new Set(nombres)].sort((a, b) => b.length - a.length));
  }
  return terceros;
}

function revisarArchivo(rel, terceros = null) {
  const hallazgos = [];
  // resolve, no join: una ruta explícita de otra unidad (p. ej. el temporal en C: con el repo en D:) llega absoluta.
  const abs = path.resolve(RAIZ, rel);
  if (terceros && terceros.archivos.has(claveRuta(abs))) return hallazgos;
  const nombresAdmitidos = (terceros && terceros.nombres.get(claveRuta(abs))) || [];
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return hallazgos; }
  if (esBinario(rel, buf)) return hallazgos;
  const texto = buf.toString('utf8');
  const delAutor = esDelAutor(rel);
  const lineas = texto.split('\n');
  for (let i = 0; i < lineas.length; i++) {
    let l = lineas[i];
    // La lista privada no admite excepciones por línea, y se busca también con los literales unidos: un nombre
    // armado por partes ('ab' + 'cd') se lee a simple vista igual que escrito entero.
    const unida = l.replace(/['"`]\s*\+\s*['"`]/g, '');
    for (const p of cargarPrivados().patrones) {
      const re = new RegExp(p.source, p.flags.includes('i') ? p.flags : p.flags + 'i');
      const m = re.exec(l) || re.exec(unida);
      if (m) hallazgos.push({ archivo: rel, linea: i + 1, patron: '(lista privada)', texto: m[0], contexto: l.trim().slice(0, 120) });
    }
    if (/uaeh-lint:\s*permitir/.test(l)) continue;
    for (const re of ADMITIDO_EN_TODOS) l = l.replace(re, '');
    for (const n of nombresAdmitidos) l = l.split(`"${n}"`).join('""');
    if (delAutor) l = l.replace(new RegExp(AUTOR + '(\\.com)?', 'gi'), '').replace(new RegExp('Sal' + 'loum Inc\\.?', 'g'), '');
    for (const p of PATRONES) {
      const re = new RegExp(p.source, p.flags.includes('i') ? p.flags : p.flags + 'i');
      const m = re.exec(l);
      if (m) hallazgos.push({ archivo: rel, linea: i + 1, patron: p.source, texto: m[0], contexto: l.trim().slice(0, 120) });
    }
  }
  return hallazgos;
}

function lint(opciones = {}) {
  let archivos;
  if (opciones.rutas && opciones.rutas.length) {
    archivos = [];
    for (const r of opciones.rutas) {
      const abs = path.resolve(RAIZ, r);
      if (!fs.existsSync(abs)) continue;
      if (fs.statSync(abs).isDirectory()) archivos.push(...listarDisco(abs));
      else archivos.push(path.relative(RAIZ, abs).replace(/\\/g, '/'));
    }
  } else {
    try { archivos = listarConGit(); } catch (e) {
      if (!opciones.todo) throw e;
      archivos = [];
    }
    if (opciones.todo) archivos = [...new Set([...archivos, ...listarDisco(RAIZ)])].sort();
  }
  // opciones.exentos: lo de exentosDeTerceros() calculado por quien llama (verificar-publicacion, con su raíz).
  const exentos = opciones.exentos || exentosDeTerceros();
  const hallazgos = [];
  let terceros = 0;
  for (const rel of archivos) {
    if (exentos.archivos.has(claveRuta(path.resolve(RAIZ, rel)))) terceros++;
    hallazgos.push(...revisarArchivo(rel, exentos));
  }
  const privados = cargarPrivados();
  return { archivos: archivos.length, terceros, hallazgos, privados: { patrones: privados.patrones.length, origen: privados.origen, avisos: privados.avisos } };
}

function main(argv) {
  const opciones = { json: false, todo: false, rutas: [] };
  for (const a of argv) {
    if (a === '--json') opciones.json = true;
    else if (a === '--todo') opciones.todo = true;
    else if (a.startsWith('--')) { console.error(`argumento desconocido: ${a}`); return 2; }
    else opciones.rutas.push(a);
  }
  let r;
  try { r = lint(opciones); } catch (e) { console.error(`lint-publicacion: ${e.message}`); return 2; }
  if (opciones.json) { console.log(JSON.stringify(r, null, 2)); return r.hallazgos.length ? 1 : 0; }
  for (const h of r.hallazgos) console.log(`${h.archivo}:${h.linea}: «${h.texto}»  ←  ${h.contexto}`);
  for (const a of r.privados.avisos) console.log(`AVISO: ${a}`);
  console.log(r.privados.origen
    ? `lista privada: ${r.privados.patrones} patrón(es) de ${r.privados.origen}`
    : 'AVISO: sin lista privada (variable UAEH_LINT_PRIVADO o tools/lista-negra.local.txt): solo se revisó la lista pública.');
  const deTerceros = r.terceros ? `; ${r.terceros} de ellos, de terceros idénticos a su origen, eximidos` : '';
  console.log(r.hallazgos.length
    ? `lint-publicacion: ${r.hallazgos.length} hallazgo(s) en ${r.archivos} archivo(s)${deTerceros}. Nada de esto puede publicarse.`
    : `lint-publicacion: OK (${r.archivos} archivos revisados, 0 hallazgos${deTerceros}).`);
  return r.hallazgos.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { lint, revisarArchivo, exentosDeTerceros, cargarPrivados, fijarPrivados, PATRONES, RAIZ };
