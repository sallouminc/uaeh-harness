#!/usr/bin/env node
// UAEH — registro de tareas: agrega una línea JSON a <UAEH_HOME>/registro.jsonl
// Uso: node uaeh-registro.cjs --proyecto <nombre> --ruta quick|build|deep --riesgo bajo|medio|alto|critico --ciclos <n>
//        --estado <estado> [--minutos <n>] [--escalamiento <texto>] [--visual <tipo>] [--tarea <texto>]
// La fecha de cada línea sale de la zona efectiva: UAEH_TZ > zonaHoraria de uaeh.config.json > la del sistema.
'use strict';

const fs = require('fs');
const path = require('path');
const comun = require(path.join(__dirname, 'lib', 'comun.cjs'));
const { ahora, isoZona, uaehHome } = comun;

const RUTAS = ['quick', 'build', 'deep'];
const RIESGOS = ['bajo', 'medio', 'alto', 'critico'];
const ESTADOS = ['PASS_TECHNICAL', 'PASS_RELEASE_READY', 'PENDING_HUMAN_REVIEW', 'BLOCKED_SECURITY', 'FAIL', 'UNKNOWN'];
const VISUALES = ['none', 'create-public-ui', 'product-ui', 'redesign-existing', 'reference-to-code', 'audit-only', 'motion-3d', 'video'];

function falla(msg) {
  process.stderr.write(`uaeh-registro: ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const o = { escalamiento: 'ninguno', visual: 'none' };
const permitidas = ['proyecto', 'ruta', 'riesgo', 'ciclos', 'minutos', 'escalamiento', 'estado', 'visual', 'tarea'];
// Los skills hablan de riesgo high/critical: se aceptan y se guardan en español, como el resto del registro.
const RIESGO_ALIAS = { low: 'bajo', medium: 'medio', high: 'alto', critical: 'critico', 'crítico': 'critico' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) falla(`argumento inesperado: ${a}`);
  const k = a.slice(2);
  if (!permitidas.includes(k)) falla(`opción desconocida: ${a}`);
  const v = args[i + 1];
  if (v === undefined || (v.startsWith('--') && permitidas.includes(v.slice(2)))) falla(`falta el valor de ${a}`);
  o[k] = v;
  i++;
}

for (const k of ['proyecto', 'ruta', 'riesgo', 'ciclos', 'estado']) if (o[k] === undefined || o[k] === '') falla(`falta --${k}`);
if (RIESGO_ALIAS[o.riesgo]) o.riesgo = RIESGO_ALIAS[o.riesgo];
if (!RUTAS.includes(o.ruta)) falla(`--ruta inválida "${o.ruta}" (${RUTAS.join('|')})`);
if (!RIESGOS.includes(o.riesgo)) falla(`--riesgo inválido "${o.riesgo}" (${RIESGOS.join('|')})`);
if (!ESTADOS.includes(o.estado)) falla(`--estado inválido "${o.estado}" (${ESTADOS.join('|')})`);
if (!VISUALES.includes(o.visual)) falla(`--visual inválido "${o.visual}" (${VISUALES.join('|')})`);
if (!/^\d+$/.test(String(o.ciclos))) falla('--ciclos debe ser un entero >= 0');
if (o.minutos !== undefined && !/^\d{1,4}$/.test(String(o.minutos))) falla('--minutos debe ser un entero entre 0 y 9999');
if (o.tarea !== undefined && o.tarea.length > 120) falla('--tarea admite máximo 120 caracteres');
if (!o.escalamiento.trim()) falla('--escalamiento no puede estar vacío (usa "ninguno")');

const linea = {
  // La zona efectiva se pasa explícita: comun.isoZona(fecha) a secas solo mira UAEH_TZ y la zona del sistema.
  fecha: isoZona(ahora(), comun.zonaHoraria(comun.cargarConfig().config)),
  proyecto: o.proyecto,
  ruta: o.ruta,
  riesgo: o.riesgo,
  ciclos: parseInt(o.ciclos, 10),
  escalamiento: o.escalamiento,
  estado: o.estado,
  visual: o.visual
};
if (o.minutos !== undefined) linea.minutos = parseInt(o.minutos, 10);
if (o.tarea !== undefined) linea.tarea = o.tarea;

const home = uaehHome();
fs.mkdirSync(home, { recursive: true });
const f = path.join(home, 'registro.jsonl');
fs.appendFileSync(f, JSON.stringify(linea) + '\n');
console.log(f);
