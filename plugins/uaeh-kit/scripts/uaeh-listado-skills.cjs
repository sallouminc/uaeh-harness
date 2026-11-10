#!/usr/bin/env node
// uaeh-listado-skills.cjs — mide el listado de skills que Claude Code inyecta al arrancar una sesión
// (el adjunto «skill_listing» de la transcripción).
//
// Para qué sirve: ese listado viaja en el contexto de cada sesión, así que cada descripción de skill
// pesa en todos los turnos. Aquí se ve cuántos caracteres ocupa, cuántas skills llevan descripción,
// cuáles son las líneas más largas (presupuesto de descripciones) y si ciertas skills aparecen y con qué.
//
// Cómo se corre
//   node uaeh-listado-skills.cjs <archivo.jsonl> [--nombres a,b,c] [--json]
//   node uaeh-listado-skills.cjs --ultima [carpeta] [--nombres a,b,c] [--json]
//     --ultima   usa la transcripción más reciente que tenga listado. Sin carpeta busca, en todas sus
//                subcarpetas, en USO_RAIZ si está definida o, si no, en <carpeta de Claude Code>/projects.
//                Las carpetas «subagents» se omiten para no confundir una sesión con sus subagentes.
//     --nombres  skills cuya presencia se informa además de las uae-*, que siempre se informan con o sin
//                prefijo de plugin (uae-loop y uaeh-harness:uae-loop cuentan igual)
//     --json     salida de máquina; añade masLargas: las 10 líneas de skill más largas { nombre, caracteres }
// Lee por bloques, línea a línea (una transcripción puede pesar decenas de MB) y se detiene en el primer
// listado, que es el inicial y completo; los siguientes son avisos incrementales.
//
// Privacidad: imprime conteos y nombres de skills. Nunca las descripciones ni contenido de conversaciones.
//
// Códigos de salida: 0 correcto · 1 uso incorrecto o archivo ilegible · 2 no hay ningún listado.
'use strict';

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { claudeHome } = require('./lib/comun.cjs');

const BLOQUE = 1 << 20; // bytes que se leen de una vez
const TOPE_MAS_LARGAS = 10;
const ES_UAE = /^(?:[\w-]+:)?uae-/; // uae-* con o sin prefijo de plugin: uae-loop, uaeh-harness:uae-loop
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function raizTranscripciones() {
  return process.env.USO_RAIZ || path.join(claudeHome(), 'projects');
}

function parseArgs(argv) {
  const o = { archivo: null, ultima: null, nombres: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--ultima') {
      const sig = argv[i + 1];
      if (sig !== undefined && !sig.startsWith('--')) { o.ultima = sig || true; i++; } else o.ultima = true; // true = carpeta por defecto
    } else if (a === '--nombres') o.nombres = String(argv[++i] || '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a.startsWith('--')) throw new Error('argumento desconocido: ' + a);
    else o.archivo = a;
  }
  if (!o.archivo && !o.ultima) throw new Error('falta <archivo.jsonl> o --ultima [carpeta]');
  return o;
}

// Devuelve el primer listado (el inicial, completo) del archivo, o null. Lee en bloques y para al encontrarlo.
function buscarListado(archivo) {
  const fd = fs.openSync(archivo, 'r');
  const buf = Buffer.alloc(BLOQUE);
  const decoder = new StringDecoder('utf8'); // un carácter multibyte puede quedar partido entre dos bloques
  let resto = '';
  let encontrado = null;
  const procesar = (linea) => {
    if (encontrado || linea.indexOf('"skill_listing"') < 0) return;
    let obj; try { obj = JSON.parse(linea); } catch { return; }
    const at = obj && obj.attachment;
    if (at && at.type === 'skill_listing' && typeof at.content === 'string') encontrado = at; // el primero es el inicial
  };
  try {
    let n;
    while (!encontrado && (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      resto += decoder.write(buf.subarray(0, n));
      let ini = 0;
      let p;
      while (!encontrado && (p = resto.indexOf('\n', ini)) >= 0) { procesar(resto.slice(ini, p)); ini = p + 1; }
      resto = resto.slice(ini);
    }
    if (!encontrado) { resto += decoder.end(); if (resto) procesar(resto); }
  } finally { fs.closeSync(fd); }
  return encontrado;
}

function analizar(at, nombresExtra) {
  const lineas = at.content.split(/\r?\n/).filter((l) => /^\s*- /.test(l));
  let conDesc = 0, sinDesc = 0, charsDesc = 0, propiasCon = 0, propiasSin = 0, propiasChars = 0;
  const desc = new Map();
  const largas = [];
  for (const l of lineas) {
    const m = /^\s*- (\S+?)(?::\s+(.*))?$/.exec(l);
    if (!m) continue;
    const tiene = m[2] !== undefined && m[2].trim() !== '';
    desc.set(m[1], tiene);
    largas.push({ nombre: m[1], caracteres: l.length });
    if (tiene) { conDesc++; charsDesc += l.length; } else sinDesc++;
    if (!m[1].includes(':')) { // skills propias (sin prefijo plugin:)
      if (tiene) { propiasCon++; propiasChars += l.length; } else propiasSin++;
    }
  }
  const interesan = [...new Set([...[...desc.keys()].filter((k) => ES_UAE.test(k)), ...nombresExtra])];
  const skills = Object.fromEntries(interesan.map((nom) => [nom, desc.has(nom) ? (desc.get(nom) ? 'con descripción' : 'sin descripción') : 'ausente']));
  largas.sort((a, b) => b.caracteres - a.caracteres || cmp(a.nombre, b.nombre));
  return {
    caracteres: at.content.length,
    skillCount: at.skillCount,
    conDescripcion: conDesc,
    sinDescripcion: sinDesc,
    caracteresConDescripcion: charsDesc,
    propias: { conDescripcion: propiasCon, sinDescripcion: propiasSin, caracteresConDescripcion: propiasChars },
    skills,
    masLargas: largas.slice(0, TOPE_MAS_LARGAS),
  };
}

// Todas las transcripciones bajo `dir`, con sus subcarpetas, salvo las de subagentes.
function listarTranscripciones(dir, acumulado = []) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acumulado; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'subagents') listarTranscripciones(p, acumulado); }
    else if (e.name.endsWith('.jsonl')) acumulado.push(p);
  }
  return acumulado;
}

// La transcripción más reciente (por fecha de modificación) que tenga listado, o null.
function elegirUltima(dir) {
  const archivos = [];
  for (const p of listarTranscripciones(dir)) {
    try { archivos.push({ p, t: fs.statSync(p).mtimeMs }); } catch { /* desapareció a mitad: se ignora */ }
  }
  archivos.sort((a, b) => b.t - a.t || cmp(a.p, b.p));
  for (const a of archivos) {
    let at = null;
    try { at = buscarListado(a.p); } catch { /* ilegible: se prueba con la siguiente */ }
    if (at) return { archivo: a.p, at };
  }
  return null;
}

function esCarpeta(ruta) {
  try { return fs.statSync(ruta).isDirectory(); } catch { return false; }
}

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) {
    console.error('Error: ' + e.message);
    console.error('Uso: node uaeh-listado-skills.cjs <archivo.jsonl> | --ultima [carpeta]  [--nombres a,b,c] [--json]');
    return 1;
  }
  let archivo = null;
  let at = null;
  if (o.ultima) {
    const explicita = typeof o.ultima === 'string';
    const dir = explicita ? path.resolve(o.ultima) : raizTranscripciones();
    if (explicita && !esCarpeta(dir)) { console.error(`Error: ${o.ultima} no es una carpeta.`); return 1; }
    const r = elegirUltima(dir);
    if (r) { archivo = r.archivo; at = r.at; }
  } else {
    archivo = o.archivo;
    try { at = buscarListado(archivo); } catch (e) { console.error(`Error: no se pudo leer ${archivo} (${e.code || e.message})`); return 1; }
  }
  if (!at) { console.log('No se encontró ningún listado de skills (skill_listing).'); return 2; }
  const r = { archivo, ...analizar(at, o.nombres) };
  if (o.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(`Archivo: ${r.archivo}`);
  console.log(`Caracteres totales: ${r.caracteres}`);
  console.log(`skillCount: ${r.skillCount}`);
  console.log(`Con descripción: ${r.conDescripcion}`);
  console.log(`Sin descripción: ${r.sinDescripcion}`);
  console.log(`Caracteres de líneas con descripción: ${r.caracteresConDescripcion}`);
  console.log(`Solo skills sin prefijo de plugin: con descripción ${r.propias.conDescripcion}, sin ${r.propias.sinDescripcion}, ${r.propias.caracteresConDescripcion} caracteres`);
  for (const [k, v] of Object.entries(r.skills)) console.log(`  ${k}: ${v === 'con descripción' ? 'sí' : 'no'} (${v})`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseArgs, buscarListado, analizar, listarTranscripciones, elegirUltima, raizTranscripciones, main };
