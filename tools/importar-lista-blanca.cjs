#!/usr/bin/env node
// tools/importar-lista-blanca.cjs — importación por manifiesto, nunca por carpeta.
//
// Las piezas del kit nacen en la configuración personal de su autor (la carpeta de Claude Code y la de
// Codex), donde conviven credenciales, transcripciones y datos ajenos. Aquí solo entra lo que está
// nombrado, archivo por archivo, en [importados] de tools/manifiesto-importacion.txt: cada línea dice de
// dónde sale un archivo y a dónde va. No existe importación por carpeta ni por comodín.
//
// Uso: node tools/importar-lista-blanca.cjs [--aplicar] [--forzar] [--solo <destino>]
//        [--manifiesto <ruta>] [--raiz <dir>] [--raiz-k <dir>] [--raiz-x <dir>]
//   (sin opciones)  EN SECO: por entrada imprime IGUAL | DISTINTO | FALTA-ORIGEN | FALTA-DESTINO.
//                   El contenido se compara sin distinguir CRLF de LF ni la presencia de BOM.
//   --aplicar       copia SOLO las entradas cuyo destino no existe (FALTA-DESTINO).
//   --forzar        junto con --aplicar, pisa también los destinos que difieren (DISTINTO). Los destinos
//                   se editan a mano después de importar y no deben perderse: sin --forzar jamás se pisan.
//   --solo <dest>   limita todo a la entrada cuyo destino es <dest> (ruta relativa al repo, con «/»).
//   --manifiesto    otro manifiesto (por defecto <raiz>/tools/manifiesto-importacion.txt).
//   --raiz          raíz del repo donde viven los destinos (por defecto, este repo).
//   --raiz-k / --raiz-x  sustituyen K/ y X/ (pruebas). Por defecto K/ es la carpeta de configuración de
//                   Claude Code (claudeHome() de plugins/uaeh-kit/scripts/lib/comun.cjs si existe; si no,
//                   CLAUDE_CONFIG_DIR o ~/.claude) y X/ es CODEX_HOME o ~/.codex.
// Formato del manifiesto: ver la cabecera de tools/manifiesto-importacion.txt. Nunca borra nada.
// Códigos de salida: 0 = el manifiesto parseó (aunque haya DISTINTO o FALTA-*) · 1 = una copia falló al
//   aplicar · 2 = uso incorrecto o manifiesto ilegible.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const RUTA_COMUN = path.join(RAIZ, 'plugins', 'uaeh-kit', 'scripts', 'lib', 'comun.cjs');
const SECCIONES = { importados: 'importados', nuevos: 'nuevos', 'grandes-permitidos': 'grandes', terceros: 'terceros' };
// Una carpeta de terceros vive en plugins/<plugin>/vendor/<nombre> (sin «/» final).
const RE_TERCEROS = /^plugins\/[^/]+\/vendor\/[^/]+$/;
const ESTADOS = ['IGUAL', 'DISTINTO', 'FALTA-ORIGEN', 'FALTA-DESTINO'];

class UsoIncorrecto extends Error {}

// ── Manifiesto ─────────────────────────────────────────────────────────────────────────

// Texto sin el BOM UTF-8 inicial, si lo tiene.
function quitarBom(texto) {
  return texto.charCodeAt(0) === 0xFEFF ? texto.slice(1) : texto;
}

function normalizarRuta(texto) {
  return String(texto).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '');
}

// Una ruta del manifiesto es relativa, no sale de su raíz con «..» y no acaba en «/»: se importa
// archivo por archivo.
function rutaSegura(rel) {
  if (!rel || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every((parte) => parte !== '' && parte !== '..');
}

// Texto del manifiesto → { importados:[{origen,destino}], nuevos:[], grandes:[], terceros:[] }. Lanza UsoIncorrecto
// con «nombre:línea» ante cualquier línea mal formada: callar un error de tipeo ocultaría procedencias.
function parsearManifiesto(texto, nombre = 'manifiesto') {
  const salida = { importados: [], nuevos: [], grandes: [], terceros: [] };
  const declarados = new Set();
  let seccion = null;
  const lineas = quitarBom(String(texto)).split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const donde = `${nombre}:${i + 1}`;
    const linea = lineas[i].replace(/(^|\s)#.*$/, '').trim();
    if (!linea) continue;
    const cabecera = /^\[([^\]]*)\]$/.exec(linea);
    if (cabecera) {
      seccion = SECCIONES[cabecera[1].trim().toLowerCase()];
      if (!seccion) throw new UsoIncorrecto(`${donde}: sección desconocida «${cabecera[1]}» (válidas: [importados], [nuevos], [grandes-permitidos], [terceros])`);
      continue;
    }
    if (!seccion) throw new UsoIncorrecto(`${donde}: entrada fuera de una sección`);
    if (seccion === 'importados') {
      const partes = linea.split(/\s*->\s*/);
      if (partes.length !== 2) throw new UsoIncorrecto(`${donde}: se esperaba «K/origen -> destino»`);
      const origen = normalizarRuta(partes[0]);
      const destino = normalizarRuta(partes[1]);
      if (!/^[KX]\//.test(origen) || !rutaSegura(origen.slice(2))) throw new UsoIncorrecto(`${donde}: el origen «${partes[0]}» debe empezar con K/ o X/ y ser una ruta relativa de un archivo`);
      if (!rutaSegura(destino)) throw new UsoIncorrecto(`${donde}: el destino «${partes[1]}» debe ser una ruta relativa de un archivo, sin «..»`);
      if (declarados.has(destino)) throw new UsoIncorrecto(`${donde}: el destino «${destino}» ya está declarado`);
      declarados.add(destino);
      salida.importados.push({ origen, destino });
    } else {
      const ruta = normalizarRuta(linea);
      if (!rutaSegura(ruta)) throw new UsoIncorrecto(`${donde}: «${linea}» debe ser una ruta relativa de un archivo, sin «..»`);
      if (seccion === 'nuevos') {
        if (declarados.has(ruta)) throw new UsoIncorrecto(`${donde}: «${ruta}» ya está declarado`);
        declarados.add(ruta);
      }
      if (seccion === 'terceros') {
        if (!RE_TERCEROS.test(ruta)) throw new UsoIncorrecto(`${donde}: «${ruta}» debe ser una carpeta plugins/<plugin>/vendor/<nombre>`);
        if (salida.terceros.includes(ruta)) throw new UsoIncorrecto(`${donde}: «${ruta}» ya está declarado`);
      }
      salida[seccion].push(ruta);
    }
  }
  return salida;
}

function leerManifiesto(ruta) {
  let texto;
  try { texto = fs.readFileSync(ruta, 'utf8'); } catch (e) {
    throw new UsoIncorrecto(`no se pudo leer el manifiesto «${ruta}» (${e.code || e.message})`);
  }
  return parsearManifiesto(texto, path.basename(ruta));
}

// ── Raíces ─────────────────────────────────────────────────────────────────────────────

function intentar(fn) {
  try { return fn(); } catch { return null; }
}

function absolutoONulo(valor) {
  return typeof valor === 'string' && valor.trim() ? path.resolve(valor.trim()) : null;
}

// K/ → carpeta de configuración de Claude Code · X/ → carpeta de Codex · repo → donde viven los destinos.
function resolverRaices(opciones = {}) {
  const comun = intentar(() => require(RUTA_COMUN));
  const deComun = (nombre) => (comun && typeof comun[nombre] === 'function' ? intentar(() => comun[nombre]()) : null);
  return {
    k: absolutoONulo(opciones.raizK) || deComun('claudeHome') || absolutoONulo(process.env.CLAUDE_CONFIG_DIR) || path.join(os.homedir(), '.claude'),
    x: absolutoONulo(opciones.raizX) || deComun('codexHome') || absolutoONulo(process.env.CODEX_HOME) || path.join(os.homedir(), '.codex'),
    repo: absolutoONulo(opciones.raiz) || RAIZ,
  };
}

function dentroDe(raiz, ruta) {
  const rel = path.relative(raiz, ruta);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function resolverEntrada(entrada, raices) {
  const raizOrigen = entrada.origen.startsWith('K/') ? raices.k : raices.x;
  const origen = path.resolve(raizOrigen, entrada.origen.slice(2));
  const destino = path.resolve(raices.repo, entrada.destino);
  if (!dentroDe(raizOrigen, origen)) throw new UsoIncorrecto(`el origen «${entrada.origen}» queda fuera de su carpeta`);
  if (!dentroDe(raices.repo, destino)) throw new UsoIncorrecto(`el destino «${entrada.destino}» queda fuera del repositorio`);
  return { origen, destino };
}

// ── Comparación y copia ─────────────────────────────────────────────────────────────────

function esArchivo(ruta) {
  try { return fs.statSync(ruta).isFile(); } catch { return false; }
}

function esBinario(buf) {
  return buf.subarray(0, 8000).includes(0);
}

// Para comparar: sin BOM UTF-8 y con LF. Los binarios se comparan tal cual.
function normalizarContenido(buf) {
  if (esBinario(buf)) return buf;
  let b = buf;
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
  return Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

function contenidoIgual(a, b) {
  return normalizarContenido(a).equals(normalizarContenido(b));
}

// 'IGUAL' | 'DISTINTO' | 'FALTA-ORIGEN' | 'FALTA-DESTINO'. Un origen que no es un archivo (p. ej. una
// carpeta) cuenta como FALTA-ORIGEN: no se importa por carpeta.
function estadoDeEntrada({ origen, destino }) {
  if (!esArchivo(origen)) return 'FALTA-ORIGEN';
  if (!fs.existsSync(destino)) return 'FALTA-DESTINO';
  if (!esArchivo(destino)) return 'DISTINTO';
  return contenidoIgual(fs.readFileSync(origen), fs.readFileSync(destino)) ? 'IGUAL' : 'DISTINTO';
}

// Evalúa todas las entradas (o solo la de `solo`) y, con `aplicar`, copia lo permitido. Devuelve
// { entradas:[{origen,destino,estado,accion,error}], nuevos, grandes }. `accion`: COPIADO | PISADO |
// OMITIDO | ERROR | null (en seco o sin nada que hacer).
function importar({ manifiesto, raices, aplicar = false, forzar = false, solo = null }) {
  const datos = leerManifiesto(manifiesto);
  let entradas = datos.importados;
  if (solo) {
    const buscado = normalizarRuta(solo);
    entradas = entradas.filter((e) => e.destino === buscado);
    if (!entradas.length) throw new UsoIncorrecto(`--solo: ningún destino del manifiesto coincide con «${buscado}»`);
  }
  const resultados = entradas.map((entrada) => {
    const rutas = resolverEntrada(entrada, raices);
    const estado = estadoDeEntrada(rutas);
    const r = { origen: entrada.origen, destino: entrada.destino, estado, accion: null, error: null };
    if (!aplicar) return r;
    if (estado === 'DISTINTO' && !forzar) { r.accion = 'OMITIDO'; return r; }
    if (estado !== 'FALTA-DESTINO' && estado !== 'DISTINTO') return r;
    try {
      fs.mkdirSync(path.dirname(rutas.destino), { recursive: true });
      fs.copyFileSync(rutas.origen, rutas.destino);
      r.accion = estado === 'DISTINTO' ? 'PISADO' : 'COPIADO';
    } catch (err) {
      r.accion = 'ERROR';
      r.error = err.code || err.message;
    }
    return r;
  });
  return { entradas: resultados, nuevos: datos.nuevos.length, grandes: datos.grandes.length };
}

// ── Línea de comandos ──────────────────────────────────────────────────────────────────

const OPCIONES_CON_VALOR = new Map([
  ['--solo', 'solo'], ['--manifiesto', 'manifiesto'], ['--raiz', 'raiz'], ['--raiz-k', 'raizK'], ['--raiz-x', 'raizX'],
]);

function leerArgumentos(argv) {
  const o = { aplicar: false, forzar: false, solo: null, manifiesto: null, raiz: null, raizK: null, raizX: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--aplicar') o.aplicar = true;
    else if (a === '--forzar') o.forzar = true;
    else if (OPCIONES_CON_VALOR.has(a)) {
      if (i + 1 >= argv.length) throw new UsoIncorrecto(`falta el valor de ${a}`);
      o[OPCIONES_CON_VALOR.get(a)] = argv[++i];
    } else throw new UsoIncorrecto(`argumento desconocido: ${a}`);
  }
  return o;
}

function textoAccion(r) {
  if (!r.accion) return '';
  if (r.accion === 'OMITIDO') return '  → OMITIDO (el destino existe y difiere; usa --forzar para pisarlo)';
  if (r.accion === 'ERROR') return `  → ERROR (${r.error})`;
  return `  → ${r.accion}`;
}

function main(argv) {
  try {
    const o = leerArgumentos(argv);
    const raices = resolverRaices(o);
    const manifiesto = o.manifiesto ? path.resolve(o.manifiesto) : path.join(raices.repo, 'tools', 'manifiesto-importacion.txt');
    const r = importar({ manifiesto, raices, aplicar: o.aplicar, forzar: o.forzar, solo: o.solo });

    console.log(o.aplicar
      ? `importar-lista-blanca: APLICANDO · copia lo que falta${o.forzar ? ' y pisa lo que difiere (--forzar)' : ''}`
      : 'importar-lista-blanca: EN SECO · no se escribe nada (usa --aplicar para copiar lo que falta)');
    if (o.forzar && !o.aplicar) console.log('importar-lista-blanca: --forzar solo tiene efecto junto con --aplicar.');
    console.log(`  K/ = ${raices.k}`);
    console.log(`  X/ = ${raices.x}`);
    console.log(`  destinos en ${raices.repo}`);
    for (const e of r.entradas) console.log(`${e.estado.padEnd('FALTA-DESTINO'.length)}  ${e.origen} -> ${e.destino}${textoAccion(e)}`);

    const cuenta = (estado) => r.entradas.filter((e) => e.estado === estado).length;
    const porEstado = ESTADOS.map((estado) => `${cuenta(estado)} ${estado}`).join(' · ');
    const hechas = (accion) => r.entradas.filter((e) => e.accion === accion).length;
    const cola = o.aplicar
      ? `${hechas('COPIADO')} copiado(s), ${hechas('PISADO')} pisado(s), ${hechas('OMITIDO')} omitido(s), ${hechas('ERROR')} con error.`
      : 'nada escrito.';
    console.log(`importar-lista-blanca: ${r.entradas.length} entrada(s) — ${porEstado} · ${cola}`);
    return hechas('ERROR') ? 1 : 0;
  } catch (e) {
    console.error(`importar-lista-blanca: ${e.message}`);
    return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = {
  RE_TERCEROS, leerManifiesto, parsearManifiesto, normalizarRuta, resolverRaices, resolverEntrada, estadoDeEntrada,
  contenidoIgual, importar, main, UsoIncorrecto,
};
