#!/usr/bin/env node
// uso-pasos.cjs — mide cuántos pasos se gastan «uno por uno» en las sesiones principales de Claude Code
// de los últimos N días.
//
// Por qué importa: cada paso del modelo relee toda la conversación, así que lo que no depende del
// resultado anterior debe ir en el mismo mensaje (herramientas en paralelo) o en un solo comando.
// Este script mide si esa regla se cumple, y cuánto de lo releído (cache leída) pesa cada mala práctica:
//   · cadenas de 4+ pasos seguidos con una sola herramienta suelta (Bash, PowerShell, Read, Grep, Glob);
//   · ediciones una por una (5+ pasos seguidos que solo editan o escriben);
//   · pasos con varias herramientas en paralelo (lo deseable);
//   · comandos idénticos repetidos dentro de la misma sesión.
//
// Cómo se corre
//   node uso-pasos.cjs [dias]     dias: número mayor que 0 (por defecto 7)
//   Lee las transcripciones de USO_RAIZ si está definida; si no, de <carpeta de Claude Code>/projects.
//
// Solo se miden las sesiones principales: los mensajes de subagentes (isSidechain) se ignoran.
// Un mensaje que Claude Code reparte en varias líneas (una por bloque) se junta por su id.
//
// Privacidad: solo lee el uso, los nombres de herramienta y el texto de los comandos, y este último
// únicamente para contar repetidos. Nunca imprime comandos ni contenido de conversaciones.
//
// Códigos de salida: 0 correcto (también cuando no hay datos) · 1 uso incorrecto.
'use strict';

const fs = require('fs');
const path = require('path');
const { claudeHome, ahora } = require('./lib/comun.cjs');

const DIA_MS = 864e5;
const SUELTAS = new Set(['Bash', 'PowerShell', 'Read', 'Grep', 'Glob']);
const EDICION = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MIN_CADENA = 4;   // pasos sueltos seguidos para contar como cadena
const MIN_EDICION = 5;  // pasos de edición seguidos para contar como «uno por uno»
// Medición del autor del método sobre su propio uso (oct-2026): punto de comparación, no una meta fija.
const REFERENCIA = { cadenas: 34.1, paralelo: 30.5, porPaso: 289 };

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function raizTranscripciones() {
  return process.env.USO_RAIZ || path.join(claudeHome(), 'projects');
}

// Pasos (mensajes del asistente) de una sesión, en orden. Devuelve null si el archivo no se pudo leer.
function turnosDeSesion(archivo, desde) {
  let lineas;
  try { lineas = fs.readFileSync(archivo, 'utf8').split('\n'); } catch { return null; }
  const msgs = new Map();
  let orden = 0;
  for (const linea of lineas) {
    if (!linea.includes('"assistant"')) continue;
    let o; try { o = JSON.parse(linea); } catch { continue; }
    if (!o || o.type !== 'assistant' || !o.message || !o.message.id || o.isSidechain) continue;
    const t = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (t < desde) continue; // sin marca de tiempo (NaN) se conserva: el archivo ya pasó el filtro por fecha
    const id = o.message.id;
    if (!msgs.has(id)) msgs.set(id, { herr: [], cmds: [], ids: new Set(), leido: 0, orden: orden++ });
    const m = msgs.get(id);
    const leidoLinea = o.message.usage && Number.isFinite(o.message.usage.cache_read_input_tokens) ? o.message.usage.cache_read_input_tokens : 0;
    m.leido = Math.max(m.leido, leidoLinea);
    for (const c of Array.isArray(o.message.content) ? o.message.content : []) {
      if (c && c.type === 'tool_use') {
        // Claude Code escribe una línea por bloque; si un bloque se repite, se cuenta una vez por su id.
        if (c.id) { if (m.ids.has(c.id)) continue; m.ids.add(c.id); }
        m.herr.push(c.name);
        if (c.input && typeof c.input.command === 'string') m.cmds.push(c.input.command.replace(/\s+/g, ' ').trim());
      }
    }
  }
  return [...msgs.values()].sort((a, b) => a.orden - b.orden);
}

function medir(raiz, dias, ahoraMs) {
  const desde = ahoraMs - dias * DIA_MS;
  const r = {
    sesiones: 0, turnos: 0, leido: 0, conHerr: 0, paralelos: 0,
    cadenas: { n: 0, turnos: 0, leido: 0 }, edicion: { n: 0, turnos: 0, leido: 0 }, repetidos: { n: 0, leido: 0 },
    omitidos: 0,
  };
  let proyectos = [];
  try { proyectos = fs.readdirSync(raiz, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(cmp); } catch { return r; }
  for (const proyecto of proyectos) {
    let archivos = [];
    try { archivos = fs.readdirSync(path.join(raiz, proyecto)).filter((f) => f.endsWith('.jsonl')).sort(cmp); } catch { continue; }
    for (const f of archivos) {
      const p = path.join(raiz, proyecto, f);
      let modificado;
      try { modificado = fs.statSync(p).mtimeMs; } catch { r.omitidos++; continue; }
      if (modificado < desde) continue;
      const lista = turnosDeSesion(p, desde);
      if (lista === null) { r.omitidos++; continue; }
      if (!lista.length) continue;
      r.sesiones++;
      const vistos = new Set();
      let cadena = [];
      let edicion = [];
      const cerrar = (racha, minimo, destino) => {
        if (racha.length >= minimo) {
          destino.n++; destino.turnos += racha.length;
          destino.leido += racha.reduce((s, m) => s + m.leido, 0);
        }
      };
      for (const m of lista) {
        r.turnos++; r.leido += m.leido;
        if (!m.herr.length) continue;
        r.conHerr++;
        if (m.herr.length > 1) r.paralelos++;
        if (m.herr.length === 1 && SUELTAS.has(m.herr[0])) cadena.push(m); else { cerrar(cadena, MIN_CADENA, r.cadenas); cadena = []; }
        if (m.herr.every((h) => EDICION.has(h))) edicion.push(m); else { cerrar(edicion, MIN_EDICION, r.edicion); edicion = []; }
        for (const c of m.cmds) {
          if (vistos.has(c)) { r.repetidos.n++; r.repetidos.leido += m.leido; } else vistos.add(c);
        }
      }
      cerrar(cadena, MIN_CADENA, r.cadenas);
      cerrar(edicion, MIN_EDICION, r.edicion);
    }
  }
  return r;
}

function pct(a, b) {
  return b ? (100 * a / b).toFixed(1) : '0.0';
}

function informe(r, dias) {
  const M = (n) => (n / 1e6).toFixed(0) + 'M';
  const porPaso = r.turnos ? Math.round(r.leido / r.turnos / 1e3) : 0;
  return [
    `Últimos ${dias} días · ${r.sesiones} sesiones principales · ${r.turnos} pasos · releído ${M(r.leido)} · ${porPaso}K por paso`,
    `Pasos con herramientas en paralelo: ${pct(r.paralelos, r.conHerr)} % (${r.paralelos} de ${r.conHerr})`,
    `Cadenas de ${MIN_CADENA}+ comandos o lecturas sueltos: ${r.cadenas.n} · ${pct(r.cadenas.turnos, r.turnos)} % de los pasos · ${pct(r.cadenas.leido, r.leido)} % de lo releído`,
    `Ediciones uno por uno (${MIN_EDICION}+ seguidas): ${r.edicion.n} · ${pct(r.edicion.leido, r.leido)} % de lo releído`,
    `Comandos idénticos repetidos en la misma sesión: ${r.repetidos.n} · ${pct(r.repetidos.leido, r.leido)} % de lo releído`,
    `Referencia del autor del método (oct-2026): cadenas ${REFERENCIA.cadenas} % de lo releído · paralelo ${REFERENCIA.paralelo} % · ${REFERENCIA.porPaso}K por paso. ` +
      'Meta: menos cadenas y más paralelo sin bajar la calidad.',
  ].join('\n');
}

function parsearArgumentos(argv) {
  if (argv.length > 1) throw new Error(`argumento de más: ${argv[1]}`);
  const dias = argv.length ? Number(argv[0]) : 7;
  if (!(dias > 0) || !Number.isFinite(dias)) throw new Error('dias debe ser un número mayor que 0');
  return { dias };
}

function main(argv) {
  let o;
  try { o = parsearArgumentos(argv); } catch (e) {
    process.stderr.write(`Error: ${e.message}\nUso: node uso-pasos.cjs [dias>0]\n`);
    return 1;
  }
  const r = medir(raizTranscripciones(), o.dias, ahora().getTime());
  console.log(informe(r, o.dias));
  if (r.omitidos) process.stderr.write(`Aviso: ${r.omitidos} archivo(s) no se pudieron leer y se omitieron.\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { turnosDeSesion, medir, informe, pct, parsearArgumentos, raizTranscripciones, REFERENCIA, SUELTAS, EDICION, main };
