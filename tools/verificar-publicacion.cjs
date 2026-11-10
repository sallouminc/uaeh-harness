#!/usr/bin/env node
// tools/verificar-publicacion.cjs — verificación completa antes de publicar.
//
// Revisa lo que git publicaría: los archivos rastreados (git ls-files, que ya incluye lo preparado con
// git add) y, con --con-nuevos, también los nuevos que git no ignora. Cada comprobación imprime líneas
// «OK|AVISO|FALLÓ  comprobación — detalle» y al final un resumen. Cualquier FALLÓ = exit 1.
//
// Uso: node tools/verificar-publicacion.cjs [--json] [--con-nuevos] [--raiz <dir>]
//   --json        salida de máquina: { archivos, comprobaciones:[{id,estado,detalle,items}], totales }
//   --con-nuevos  suma los archivos nuevos no ignorados (sirve antes del primer git add)
//   --raiz <dir>  verifica otro repositorio git (pruebas); por defecto, este. El manifiesto se lee de
//                 <dir>/tools/manifiesto-importacion.txt y, como la lista negra resuelve rutas contra la
//                 raíz de ESTE repo, <dir> debe estar en la misma unidad (Windows).
//
// Comprobaciones (el nombre es el identificador estable):
//   lista-negra  nombres, rutas de máquina y clientes: ejecuta lint() de tools/lint-publicacion.cjs (exime los archivos
//                de [terceros] idénticos a la huella de su UPSTREAM.json, calculados con la raíz verificada)
//   prohibidos   *.bak*, *.log, *.jsonl, .env, .env.*, *.pem, *.key, settings.local.json,
//                .credentials.json y cualquier ruta bajo node_modules/
//   json         todo *.json parsea
//   shell        todo *.sh y todo lo que cuelga de plugins/*/git-hooks/ y plugins/*/wsl/bin/: sin CR y
//                con primera línea #!/bin/sh, #!/usr/bin/env bash o #!/usr/bin/env sh. Bajo plugins/*/wsl/ (programas
//                que instala root en /opt/uaeh) vale además el intérprete FIJO #!/bin/bash, y en wsl/bin/
//                #!/usr/bin/python3 -I: ahí el PATH de quien llama no debe elegir el intérprete
//   bom          ningún archivo de texto empieza con BOM UTF-8
//   fin-de-linea la copia de trabajo de cada archivo rastreado tiene el fin de línea que pide su eol= de .gitattributes
//                (git ls-files --eol). Solo AVISO: git normaliza al preparar y lo publicado no cambia, pero las pruebas
//                locales leerían bytes distintos de los del CI (pasa cuando un editor reescribe el archivo en LF)
//   tamano       ningún archivo pesa más de 200 KB salvo los de [grandes-permitidos]
//   manifiesto   todo archivo rastreado bajo plugins/ figura en tools/manifiesto-importacion.txt, como
//                destino de [importados], en [nuevos] o dentro de una carpeta de [terceros]; si no: «sin origen declarado»
//   terceros     cada carpeta de [terceros] (plugins/<p>/vendor/<nombre>) trae LICENSE y un UPSTREAM.json con
//                origen, licencia, commit y la huella (sha256 con LF) de cada archivo; todo archivo de la carpeta
//                está declarado ahí (salvo UPSTREAM.json y PATCHES/), con la misma huella, y nada declarado falta
//   version      si existen tags v*, un plugin cuyo directorio cambió desde el último tag debe subir la
//                version de su .claude-plugin/plugin.json («subir version»); sin tags → AVISO
// Un archivo que ya no existe en el disco (borrado y aún no preparado) no se revisa.
// Códigos de salida: 0 = sin FALLÓ (los AVISO no cuentan) · 1 = al menos un FALLÓ · 2 = uso incorrecto
//   o la carpeta no es un repositorio git.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const MAX_BYTES = 200 * 1024;
const SHEBANGS_VALIDOS = new Set(['#!/bin/sh', '#!/usr/bin/env bash', '#!/usr/bin/env sh']);
const SHEBANGS_WSL = new Set(['#!/bin/bash']);
const SHEBANGS_WSL_BIN = new Set(['#!/bin/bash', '#!/usr/bin/python3 -I']);
const RE_SHELL_POR_RUTA = /^plugins\/[^/]+\/(?:git-hooks|wsl\/bin)\//;
const RE_WSL = /^plugins\/[^/]+\/wsl\//;
const RE_WSL_BIN = /^plugins\/[^/]+\/wsl\/bin\//;
const EXT_BINARIAS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.pptx', '.docx', '.xlsx', '.woff', '.woff2', '.ttf', '.zip', '.gz', '.xz', '.tar']);

class UsoIncorrecto extends Error {}

// Texto sin el BOM UTF-8 inicial, si lo tiene.
function quitarBom(texto) {
  return texto.charCodeAt(0) === 0xFEFF ? texto.slice(1) : texto;
}

// ── Git y archivos ─────────────────────────────────────────────────────────────────────

function git(raiz, args) {
  return spawnSync('git', args, { cwd: raiz, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function esArchivoRegular(abs) {
  try { return fs.lstatSync(abs).isFile(); } catch { return false; }
}

// Existe y no es una carpeta (git lista los submódulos como carpetas). Un enlace simbólico cuenta: sus
// comprobaciones por nombre deben aplicarse aunque su contenido no se lea.
function existeSinSerCarpeta(abs) {
  try { return !fs.lstatSync(abs).isDirectory(); } catch { return false; }
}

// Rutas relativas (con «/») de lo que se publicaría y sigue existiendo en el disco.
function listarArchivos(raiz, conNuevos) {
  const consultas = [['ls-files', '-z'], ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']];
  if (conNuevos) consultas.push(['ls-files', '--others', '--exclude-standard', '-z']);
  const vistos = new Set();
  consultas.forEach((args, i) => {
    const r = git(raiz, args);
    if (r.error || r.status !== 0) {
      if (i === 0) throw new UsoIncorrecto(`«${raiz}» no es un repositorio git que se pueda listar (${((r.error && r.error.message) || r.stderr || '').trim()})`);
      return;
    }
    for (const f of r.stdout.split('\0')) if (f) vistos.add(f.replace(/\\/g, '/'));
  });
  return [...vistos].filter((rel) => existeSinSerCarpeta(path.join(raiz, rel))).sort();
}

function esBinario(rel, buf) {
  if (EXT_BINARIAS.has(path.extname(rel).toLowerCase())) return true;
  return buf.subarray(0, 8000).includes(0);
}

function leerJsonSeguro(ruta) {
  try { return JSON.parse(quitarBom(fs.readFileSync(ruta, 'utf8'))); } catch { return null; }
}

// Manifiesto del repo verificado: { datos, error }. El analizador es el de importar-lista-blanca.
function cargarManifiesto(raiz) {
  try {
    const { leerManifiesto } = require('./importar-lista-blanca.cjs');
    return { datos: leerManifiesto(path.join(raiz, 'tools', 'manifiesto-importacion.txt')), error: null };
  } catch (e) {
    return { datos: null, error: e.message };
  }
}

function crearContexto(raiz, conNuevos) {
  const archivos = listarArchivos(raiz, conNuevos);
  const cache = new Map();
  return {
    raiz,
    archivos,
    manifiesto: cargarManifiesto(raiz),
    leer(rel) {
      if (!cache.has(rel)) {
        let buf = null;
        try { buf = fs.readFileSync(path.join(raiz, rel)); } catch { /* ilegible: se salta */ }
        cache.set(rel, buf);
      }
      return cache.get(rel);
    },
    tamano(rel) {
      try { return fs.statSync(path.join(raiz, rel)).size; } catch { return 0; }
    },
  };
}

// ── Comprobaciones ─────────────────────────────────────────────────────────────────────
// Cada una devuelve { detalle, items:[{estado, archivo?, detalle}] }; sin items = OK con ese detalle.

function fallo(detalle, archivo) {
  return { estado: 'FALLÓ', archivo, detalle };
}

function comprobarListaNegra(ctx) {
  const regulares = ctx.archivos.filter((rel) => esArchivoRegular(path.join(ctx.raiz, rel)));
  if (!regulares.length) return { detalle: 'sin archivos que revisar', items: [] };
  let lint, exentosDeTerceros;
  try { ({ lint, exentosDeTerceros } = require('./lint-publicacion.cjs')); } catch (e) {
    return { detalle: '', items: [fallo(`no se pudo cargar tools/lint-publicacion.cjs: ${e.message}`)] };
  }
  // El lint resuelve las rutas contra la raíz de ESTE repo; en Windows no puede leer otra unidad y
  // dejaría pasar todo en silencio. Mejor fallar en voz alta.
  const lejos = regulares.find((rel) => path.isAbsolute(path.relative(RAIZ, path.join(ctx.raiz, rel))));
  if (lejos) return { detalle: '', items: [fallo(`la raíz verificada está en otra unidad que este repositorio: la lista negra no puede leerla (${lejos})`)] };
  let r;
  try {
    // Terceros idénticos a su origen, según el manifiesto de la raíz verificada (ilegible → nada se exime).
    const exentos = exentosDeTerceros(ctx.raiz, ctx.manifiesto.error ? [] : (ctx.manifiesto.datos.terceros || []));
    r = lint({ rutas: regulares.map((rel) => path.join(ctx.raiz, rel)), exentos });
  } catch (e) {
    return { detalle: '', items: [fallo(`lint-publicacion falló: ${e.message}`)] };
  }
  const items = r.hallazgos.map((h) => fallo(
    `línea ${h.linea}: «${h.texto}»  ←  ${h.contexto}`,
    path.relative(ctx.raiz, path.resolve(RAIZ, h.archivo)).replace(/\\/g, '/'),
  ));
  const deTerceros = r.terceros ? ` (${r.terceros} de terceros idénticos a su origen, eximidos)` : '';
  const privada = r.privados && r.privados.origen ? `; lista privada: ${r.privados.patrones} patrón(es)` : '; SIN lista privada (solo la pública)';
  return { detalle: `${r.archivos} archivo(s) revisados, 0 hallazgos${deTerceros}${privada}`, items };
}

// Motivo por el que una ruta nunca debe publicarse, o null.
function motivoProhibido(rel) {
  const base = path.posix.basename(rel).toLowerCase();
  if (rel.split('/').includes('node_modules')) return 'carpeta node_modules/';
  if (base.includes('.bak')) return '*.bak*';
  if (base.endsWith('.log')) return '*.log';
  if (base.endsWith('.jsonl')) return '*.jsonl';
  if (base === '.env' || base.startsWith('.env.')) return '.env / .env.*';
  if (base.endsWith('.pem')) return '*.pem';
  if (base.endsWith('.key')) return '*.key';
  if (base === 'settings.local.json') return 'settings.local.json';
  if (base === '.credentials.json') return '.credentials.json';
  return null;
}

function comprobarProhibidos(ctx) {
  const items = [];
  for (const rel of ctx.archivos) {
    const motivo = motivoProhibido(rel);
    if (motivo) items.push(fallo(`ruta o extensión prohibida (${motivo})`, rel));
  }
  return { detalle: `${ctx.archivos.length} archivo(s) sin extensiones ni rutas prohibidas`, items };
}

function comprobarJson(ctx) {
  const jsons = ctx.archivos.filter((rel) => /\.json$/i.test(rel));
  const items = [];
  for (const rel of jsons) {
    const buf = ctx.leer(rel);
    if (!buf) continue;
    try { JSON.parse(quitarBom(buf.toString('utf8'))); } catch (e) { items.push(fallo(`no es JSON válido (${e.message})`, rel)); }
  }
  return { detalle: `${jsons.length} archivo(s) .json parsean`, items };
}

function comprobarShell(ctx) {
  const scripts = ctx.archivos.filter((rel) => /\.sh$/i.test(rel) || RE_SHELL_POR_RUTA.test(rel));
  const items = [];
  for (const rel of scripts) {
    const buf = ctx.leer(rel);
    if (!buf) continue;
    if (buf.includes(0x0d)) items.push(fallo('contiene CR (fin de línea CRLF): debe ser LF', rel));
    const primera = buf.toString('utf8').split('\n', 1)[0].replace(/\r$/, '').trimEnd();
    const fijo = RE_WSL_BIN.test(rel) ? SHEBANGS_WSL_BIN : RE_WSL.test(rel) ? SHEBANGS_WSL : null;
    if (!SHEBANGS_VALIDOS.has(primera) && !(fijo && fijo.has(primera))) {
      const extra = fijo ? ` (o, en wsl/, ${[...fijo].join(' o ')})` : '';
      items.push(fallo(`primera línea «${primera.slice(0, 60)}» inválida: debe ser #!/bin/sh, #!/usr/bin/env bash o #!/usr/bin/env sh${extra}`, rel));
    }
  }
  return { detalle: `${scripts.length} script(s) con LF y shebang válido`, items };
}

function comprobarBom(ctx) {
  const items = [];
  let revisados = 0;
  for (const rel of ctx.archivos) {
    const buf = ctx.leer(rel);
    if (!buf || esBinario(rel, buf)) continue;
    revisados++;
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) items.push(fallo('empieza con BOM UTF-8: guárdalo como UTF-8 sin BOM', rel));
  }
  return { detalle: `${revisados} archivo(s) de texto sin BOM`, items };
}

function comprobarFinDeLinea(ctx) {
  const r = git(ctx.raiz, ['ls-files', '--eol', '-z']);
  if (r.error || r.status !== 0) return { detalle: '', items: [{ estado: 'AVISO', detalle: 'git ls-files --eol falló: no se pudo comparar el fin de línea' }] };
  const enLista = new Set(ctx.archivos);
  const items = [];
  let revisados = 0;
  // Cada entrada: «i/<índice> w/<copia> attr/<atributos>\t<ruta>»; w/ vacío = no está en el disco, none/-text = sin fin de línea.
  for (const entrada of r.stdout.split('\0')) {
    const tab = entrada.indexOf('\t');
    if (tab < 0) continue;
    const rel = entrada.slice(tab + 1).replace(/\\/g, '/');
    const m = /^i\/\S*\s+w\/(\S*)\s+attr\/(.*)$/.exec(entrada.slice(0, tab).trimEnd());
    if (!m || !enLista.has(rel)) continue;
    const pide = /(?:^|\s)eol=(crlf|lf)(?:\s|$)/.exec(m[2]);
    const copia = m[1];
    if (!pide || !['lf', 'crlf', 'mixed'].includes(copia)) continue;
    revisados++;
    if (copia === pide[1]) continue;
    const quiere = pide[1].toUpperCase();
    const detalle = copia === 'mixed'
      ? `la copia de trabajo mezcla LF y CRLF; .gitattributes pide ${quiere}`
      : `la copia de trabajo está en ${copia.toUpperCase()} y .gitattributes pide ${quiere}: reescríbela en ${quiere} y vuelve a prepararla con git add (el contenido publicado no cambia; el CI ya la ve así)`;
    items.push({ estado: 'AVISO', archivo: rel, detalle });
  }
  return { detalle: `${revisados} archivo(s) con el fin de línea que pide .gitattributes`, items };
}

function comprobarTamano(ctx) {
  const permitidos = new Set(ctx.manifiesto.datos ? ctx.manifiesto.datos.grandes : []);
  const items = [];
  for (const rel of ctx.archivos) {
    const bytes = ctx.tamano(rel);
    if (bytes > MAX_BYTES && !permitidos.has(rel)) {
      items.push(fallo(`pesa ${Math.ceil(bytes / 1024)} KB (máximo ${MAX_BYTES / 1024} KB); si es a propósito, lístalo en [grandes-permitidos] de tools/manifiesto-importacion.txt`, rel));
    }
  }
  return { detalle: `ningún archivo pasa de ${MAX_BYTES / 1024} KB`, items };
}

function comprobarManifiesto(ctx) {
  const deplugins = ctx.archivos.filter((rel) => rel.startsWith('plugins/'));
  if (ctx.manifiesto.error) {
    const estado = deplugins.length ? 'FALLÓ' : 'AVISO';
    return { detalle: '', items: [{ estado, detalle: `manifiesto ilegible: ${ctx.manifiesto.error}` }] };
  }
  const declarados = new Set([...ctx.manifiesto.datos.importados.map((e) => e.destino), ...ctx.manifiesto.datos.nuevos]);
  const terceros = ctx.manifiesto.datos.terceros || [];
  const items = deplugins
    .filter((rel) => !declarados.has(rel) && !terceros.some((d) => rel.startsWith(d + '/')))
    .map((rel) => fallo('sin origen declarado: añádelo a [importados] o a [nuevos] de tools/manifiesto-importacion.txt', rel));
  return { detalle: `${deplugins.length} archivo(s) bajo plugins/ con origen declarado`, items };
}

function huellaLf(buf) {
  return crypto.createHash('sha256').update(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function comprobarTerceros(ctx) {
  if (ctx.manifiesto.error) return { detalle: 'manifiesto ilegible (ver «manifiesto»)', items: [] };
  const carpetas = ctx.manifiesto.datos.terceros || [];
  if (!carpetas.length) return { detalle: 'sin carpetas de terceros declaradas', items: [] };
  const items = [];
  let revisados = 0;
  for (const dir of carpetas) {
    const dentro = ctx.archivos.filter((rel) => rel.startsWith(dir + '/')).map((rel) => rel.slice(dir.length + 1));
    if (!dentro.length) { items.push(fallo('carpeta declarada en [terceros] sin archivos', dir)); continue; }
    const buf = ctx.leer(`${dir}/UPSTREAM.json`);
    let up = null;
    try { up = buf ? JSON.parse(quitarBom(buf.toString('utf8'))) : null; } catch { /* abajo */ }
    if (!up || typeof up.archivos !== 'object' || !up.archivos) { items.push(fallo('falta UPSTREAM.json o no parsea (con «archivos»)', `${dir}/UPSTREAM.json`)); continue; }
    if (!/^https:\/\//.test(String(up.origen || ''))) items.push(fallo('UPSTREAM.json sin «origen» https', `${dir}/UPSTREAM.json`));
    if (!String(up.licencia || '').trim()) items.push(fallo('UPSTREAM.json sin «licencia»', `${dir}/UPSTREAM.json`));
    if (!/^[0-9a-f]{40}$/.test(String(up.commit || ''))) items.push(fallo('UPSTREAM.json sin «commit» de 40 caracteres hexadecimales', `${dir}/UPSTREAM.json`));
    if (!dentro.includes('LICENSE')) items.push(fallo('carpeta de terceros sin LICENSE', dir));
    for (const rel of dentro) {
      if (rel === 'UPSTREAM.json' || rel.startsWith('PATCHES/')) continue;
      const info = up.archivos[rel];
      if (!info) { items.push(fallo('no declarado en UPSTREAM.json', `${dir}/${rel}`)); continue; }
      const contenido = ctx.leer(`${dir}/${rel}`);
      revisados++;
      if (!contenido || huellaLf(contenido) !== info.sha256) items.push(fallo('huella distinta de la de UPSTREAM.json', `${dir}/${rel}`));
    }
    for (const rel of Object.keys(up.archivos)) if (!dentro.includes(rel)) items.push(fallo('declarado en UPSTREAM.json pero no está en el repo', `${dir}/${rel}`));
  }
  return { detalle: `${carpetas.length} carpeta(s) de terceros · ${revisados} archivo(s) con su huella de origen`, items };
}

function comprobarVersion(ctx) {
  const etiquetas = git(ctx.raiz, ['tag', '--list', 'v*', '--sort=-v:refname']);
  const tags = etiquetas.status === 0 ? etiquetas.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  if (!tags.length) return { detalle: '', items: [{ estado: 'AVISO', detalle: 'sin tags todavía: no hay versión publicada contra la cual comparar' }] };
  const ultimo = tags[0];
  const plugins = [...new Set(ctx.archivos.filter((rel) => rel.startsWith('plugins/')).map((rel) => rel.split('/')[1]))].sort();
  const items = [];
  for (const p of plugins) {
    const manifiesto = `plugins/${p}/.claude-plugin/plugin.json`;
    const actual = leerJsonSeguro(path.join(ctx.raiz, manifiesto));
    if (!actual) { items.push({ estado: 'AVISO', archivo: `plugins/${p}`, detalle: 'sin .claude-plugin/plugin.json legible: no se puede comparar la version' }); continue; }
    const dif = git(ctx.raiz, ['diff', '--quiet', ultimo, '--', `plugins/${p}`]);
    if (dif.status === 0) continue; // sin cambios desde el tag
    if (dif.status !== 1) { items.push({ estado: 'AVISO', archivo: `plugins/${p}`, detalle: `git diff contra ${ultimo} falló: no se pudo comparar` }); continue; }
    const previo = git(ctx.raiz, ['show', `${ultimo}:${manifiesto}`]);
    if (previo.status !== 0) continue; // el plugin es posterior al tag: no hay version previa
    let versionPrevia = null;
    try { versionPrevia = JSON.parse(quitarBom(previo.stdout)).version; } catch { /* ilegible: no se compara */ }
    if (versionPrevia != null && versionPrevia === actual.version) {
      items.push(fallo(`cambió desde ${ultimo} pero su version sigue en ${actual.version}: subir version`, `plugins/${p}`));
    }
  }
  return { detalle: `${plugins.length} plugin(s) comparados con ${ultimo}`, items };
}

const COMPROBACIONES = [
  ['lista-negra', comprobarListaNegra],
  ['prohibidos', comprobarProhibidos],
  ['json', comprobarJson],
  ['shell', comprobarShell],
  ['bom', comprobarBom],
  ['fin-de-linea', comprobarFinDeLinea],
  ['tamano', comprobarTamano],
  ['manifiesto', comprobarManifiesto],
  ['terceros', comprobarTerceros],
  ['version', comprobarVersion],
];

function estadoDe(items) {
  if (items.some((i) => i.estado === 'FALLÓ')) return 'FALLÓ';
  return items.some((i) => i.estado === 'AVISO') ? 'AVISO' : 'OK';
}

// → { archivos, comprobaciones:[{id,estado,detalle,items}], totales:{ok,avisos,fallaron} }
function verificar({ raiz = RAIZ, conNuevos = false } = {}) {
  const abs = path.resolve(raiz);
  let esCarpeta = false;
  try { esCarpeta = fs.statSync(abs).isDirectory(); } catch { /* no existe */ }
  if (!esCarpeta) throw new UsoIncorrecto(`no existe la carpeta «${abs}»`);
  const ctx = crearContexto(abs, conNuevos);
  const comprobaciones = COMPROBACIONES.map(([id, funcion]) => {
    let r;
    try { r = funcion(ctx); } catch (e) { r = { detalle: '', items: [fallo(`error inesperado: ${e.message}`)] }; }
    return { id, estado: estadoDe(r.items), detalle: r.detalle, items: r.items };
  });
  const cuenta = (estado) => comprobaciones.filter((c) => c.estado === estado).length;
  return { archivos: ctx.archivos.length, comprobaciones, totales: { ok: cuenta('OK'), avisos: cuenta('AVISO'), fallaron: cuenta('FALLÓ') } };
}

// ── Línea de comandos ──────────────────────────────────────────────────────────────────

function main(argv) {
  const o = { json: false, conNuevos: false, raiz: RAIZ };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--con-nuevos') o.conNuevos = true;
    else if (a === '--raiz') {
      if (i + 1 >= argv.length) { console.error('verificar-publicacion: falta el valor de --raiz'); return 2; }
      o.raiz = argv[++i];
    } else { console.error(`argumento desconocido: ${a}`); return 2; }
  }
  let r;
  try { r = verificar(o); } catch (e) {
    console.error(`verificar-publicacion: ${e.message}`);
    return 2;
  }
  const t = r.totales;
  if (o.json) { console.log(JSON.stringify(r, null, 2)); return t.fallaron ? 1 : 0; }
  for (const c of r.comprobaciones) {
    if (!c.items.length) console.log(`OK  ${c.id} — ${c.detalle}`);
    else for (const i of c.items) console.log(`${i.estado}  ${c.id} — ${i.archivo ? `${i.archivo}: ` : ''}${i.detalle}`);
  }
  const resumen = `${t.fallaron} comprobación(es) con FALLÓ, ${t.avisos} con AVISO, ${t.ok} OK · ${r.archivos} archivo(s) revisados`;
  console.log(`verificar-publicacion: ${t.fallaron ? 'FALLÓ' : 'OK'} — ${resumen}.${t.fallaron ? ' Nada de esto puede publicarse.' : ''}`);
  return t.fallaron ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = {
  MAX_BYTES, listarArchivos, motivoProhibido, comprobarListaNegra, comprobarProhibidos, comprobarJson, comprobarShell,
  comprobarBom, comprobarFinDeLinea, comprobarTamano, comprobarManifiesto, comprobarVersion, verificar, main,
};
