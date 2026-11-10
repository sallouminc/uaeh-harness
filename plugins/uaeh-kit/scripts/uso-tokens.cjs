#!/usr/bin/env node
// uso-tokens.cjs — suma el uso de tokens de las transcripciones de Claude Code de los últimos N días.
//
// Qué mide
//   · Tokens por modelo (los subagentes llevan el prefijo «sub:»), por proyecto (los 12 mayores) y las
//     sesiones principales más pesadas, con el contexto de su primer turno: lo que pesa solo arrancar.
//   · Casi todo el gasto de una sesión larga es RELEER contexto (cache leída), no escribir. Aquí se ve.
//
// Cómo se corre
//   node uso-tokens.cjs [dias] [--json]
//     dias    ventana en días, número mayor que 0 (por defecto 7)
//     --json  imprime { dias, porModelo, porProyecto, sesiones, arranques } en lugar de las tablas
//   Lee las transcripciones de USO_RAIZ si está definida; si no, de <carpeta de Claude Code>/projects.
//
// Qué cuenta como subagente: todo lo que vive en una carpeta «subagents» y toda línea marcada isSidechain.
// Los mensajes repetidos (mismo id dentro de un archivo) cuentan una sola vez. Una línea sin marca de
// tiempo se conserva (el archivo ya pasó el filtro por fecha de modificación).
//
// Privacidad: solo lee los campos de uso (usage), el modelo, el id del mensaje, la marca de tiempo y la
// bandera de subagente. Nunca imprime contenido de conversaciones ni nombres de archivo.
//
// Códigos de salida: 0 correcto (también cuando no hay datos) · 1 uso incorrecto.
'use strict';

const fs = require('fs');
const path = require('path');
const { claudeHome, ahora } = require('./lib/comun.cjs');

const DIA_MS = 864e5;
const MIN_TURNOS_PRINCIPAL = 5; // una sesión «principal» tiene al menos 5 turnos propios (sin subagentes)
const TOPE_FILAS = 12;

const num = (v) => (Number.isFinite(v) ? v : 0);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function raizTranscripciones() {
  return process.env.USO_RAIZ || path.join(claudeHome(), 'projects');
}

function sumar(mapa, clave, u) {
  let o = mapa.get(clave);
  if (!o) {
    o = { turnos: 0, entrada: 0, cacheLeida: 0, cacheEscrita: 0, salida: 0 };
    mapa.set(clave, o);
  }
  o.turnos++;
  o.entrada += num(u.input_tokens);
  o.cacheLeida += num(u.cache_read_input_tokens);
  o.cacheEscrita += num(u.cache_creation_input_tokens);
  o.salida += num(u.output_tokens);
}

function entradasOrdenadas(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name));
  } catch { return []; }
}

// Lee una transcripción y la suma en `datos`. Los archivos sin tocar dentro de la ventana ni se abren.
function leerArchivo(ruta, proyecto, esSub, desde, datos) {
  let lineas;
  try {
    if (fs.statSync(ruta).mtimeMs < desde) return;
    lineas = fs.readFileSync(ruta, 'utf8').split('\n');
  } catch { datos.omitidos++; return; }

  const vistos = new Set();
  const ses = { proyecto, turnos: 0, cacheLeida: 0, primerContexto: 0, maxContexto: 0, modelos: [] };
  for (const linea of lineas) {
    if (!linea.includes('"usage"')) continue;
    let j; try { j = JSON.parse(linea); } catch { continue; }
    const m = j && j.message;
    if (!m || typeof m !== 'object' || !m.usage || typeof m.usage !== 'object' || typeof m.model !== 'string' || !m.model) continue;
    const id = m.id || j.uuid;
    if (id) { if (vistos.has(id)) continue; vistos.add(id); }
    const t = j.timestamp ? Date.parse(j.timestamp) : NaN;
    if (t < desde) continue; // NaN (sin marca de tiempo) no es menor: la línea se conserva
    const u = m.usage;
    const lateral = esSub || j.isSidechain === true;
    sumar(datos.porModelo, (lateral ? 'sub:' : '') + m.model, u);
    sumar(datos.porProyecto, proyecto, u);
    if (lateral) continue; // las sesiones principales solo cuentan su propio hilo
    const contexto = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    ses.turnos++;
    ses.cacheLeida += num(u.cache_read_input_tokens);
    if (!ses.modelos.includes(m.model)) ses.modelos.push(m.model);
    if (!ses.primerContexto) ses.primerContexto = contexto;
    ses.maxContexto = Math.max(ses.maxContexto, contexto);
  }
  if (ses.turnos) datos.sesiones.push(ses);
}

function recorrerCarpeta(dir, proyecto, esSub, desde, datos) {
  for (const e of entradasOrdenadas(dir)) {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) { recorrerCarpeta(ruta, proyecto, esSub || e.name === 'subagents', desde, datos); continue; }
    if (e.name.endsWith('.jsonl')) leerArchivo(ruta, proyecto, esSub, desde, datos);
  }
}

// Lee <raiz>/<proyecto>/**/*.jsonl y devuelve el uso acumulado sin ordenar ni recortar:
// { porModelo: Map, porProyecto: Map, sesiones: [...], omitidos }. Una raíz inexistente da datos vacíos.
function recorrer(raiz, dias, ahoraMs) {
  const desde = ahoraMs - dias * DIA_MS;
  const datos = { porModelo: new Map(), porProyecto: new Map(), sesiones: [], omitidos: 0 };
  for (const e of entradasOrdenadas(raiz)) {
    if (e.isDirectory()) recorrerCarpeta(path.join(raiz, e.name), e.name, false, desde, datos);
  }
  return datos;
}

const totalTokens = (v) => v.entrada + v.cacheLeida + v.cacheEscrita;

function ordenarPorUso(mapa) {
  return [...mapa.entries()].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]) || cmp(a[0], b[0]));
}

// Ordena y deriva lo que muestran las tablas. Es también la forma exacta de --json.
// Las sesiones listadas son las principales con al menos 5 turnos, de mayor a menor cache leída;
// «arranques» resume su primer contexto (mediana = elemento central superior; p90 = índice floor(0.9·n)).
function resumir(datos, dias) {
  const principales = datos.sesiones
    .filter((s) => s.turnos >= MIN_TURNOS_PRINCIPAL)
    .sort((a, b) => b.cacheLeida - a.cacheLeida || cmp(a.proyecto, b.proyecto));
  const primeros = principales.map((s) => s.primerContexto).sort((a, b) => a - b);
  return {
    dias,
    porModelo: Object.fromEntries(ordenarPorUso(datos.porModelo)),
    porProyecto: Object.fromEntries(ordenarPorUso(datos.porProyecto)),
    sesiones: principales.map((s) => ({
      proyecto: s.proyecto, turnos: s.turnos, cacheLeida: s.cacheLeida,
      primerContexto: s.primerContexto, maxContexto: s.maxContexto, modelos: s.modelos.slice(),
    })),
    arranques: {
      mediana: primeros.length ? primeros[Math.floor(primeros.length / 2)] : null,
      p90: primeros.length ? primeros[Math.floor(primeros.length * 0.9)] : null,
      sesiones: primeros.length,
    },
  };
}

// Texto de las tres tablas a partir de un resumen (lo que devuelve resumir).
function informe(resumen) {
  const M = (n) => (n / 1e6).toFixed(1) + 'M';
  const k = (n) => (n / 1000).toFixed(0);
  const fila = (nombre, v) => `${nombre.padEnd(48).slice(0, 48)} turnos ${String(v.turnos).padStart(6)} | leida-cache ${M(v.cacheLeida).padStart(8)} | escrita-cache ${M(v.cacheEscrita).padStart(7)} | entrada ${M(v.entrada).padStart(6)} | salida ${M(v.salida).padStart(6)}`;
  const tabla = (obj, tope) => {
    const filas = Object.entries(obj).map(([nombre, v]) => fila(nombre, v)).slice(0, tope || Infinity);
    return filas.length ? filas.join('\n') : '(sin datos)';
  };
  const sesiones = resumen.sesiones.slice(0, TOPE_FILAS).map((s) =>
    `${s.proyecto.slice(0, 40).padEnd(40)} turnos ${String(s.turnos).padStart(5)} | 1er turno ${k(s.primerContexto).padStart(4)}k | máx ${k(s.maxContexto).padStart(4)}k | leída ${M(s.cacheLeida)} | ${s.modelos.join(',')}`);
  const lineas = [
    `=== Últimos ${resumen.dias} días · por modelo (sub: = subagentes) ===`,
    tabla(resumen.porModelo),
    '',
    `=== Por proyecto (top ${TOPE_FILAS}) ===`,
    tabla(resumen.porProyecto, TOPE_FILAS),
    '',
    '=== Sesiones principales más pesadas (contexto del 1er turno = lo que pesa arrancar) ===',
    sesiones.length ? sesiones.join('\n') : '(sin datos)',
  ];
  const a = resumen.arranques;
  if (a.sesiones) lineas.push('', `Contexto al arrancar una sesión: mediana ${k(a.mediana)}k · p90 ${k(a.p90)}k · sesiones ${a.sesiones}`);
  return lineas.join('\n');
}

function parsearArgumentos(argv) {
  const o = { dias: 7, json: false };
  let diasDado = false;
  for (const a of argv) {
    if (a === '--json') o.json = true;
    else if (a.startsWith('--')) throw new Error(`argumento desconocido: ${a}`);
    else if (diasDado) throw new Error(`argumento de más: ${a}`);
    else { o.dias = Number(a); diasDado = true; }
  }
  if (!(o.dias > 0) || !Number.isFinite(o.dias)) throw new Error('dias debe ser un número mayor que 0');
  return o;
}

function main(argv) {
  let o;
  try { o = parsearArgumentos(argv); } catch (e) {
    process.stderr.write(`Error: ${e.message}\nUso: node uso-tokens.cjs [dias>0] [--json]\n`);
    return 1;
  }
  const datos = recorrer(raizTranscripciones(), o.dias, ahora().getTime());
  const resumen = resumir(datos, o.dias);
  console.log(o.json ? JSON.stringify(resumen, null, 2) : informe(resumen));
  if (datos.omitidos) process.stderr.write(`Aviso: ${datos.omitidos} archivo(s) no se pudieron leer y se omitieron.\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { recorrer, resumir, informe, parsearArgumentos, raizTranscripciones, main };
