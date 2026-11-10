#!/usr/bin/env node
// uso-herramientas.cjs — cuenta qué agentes, skills y workflows se invocaron en los últimos N días.
//
// Qué mide
//   · Agentes lanzados (herramientas Agent o Task), por subagent_type; sin tipo = «(general-purpose)».
//   · Modelo pedido al lanzar cada agente; si no se pidió ninguno = «(hereda)».
//   · Skills invocadas (herramienta Skill), por nombre.
//   · Cuántos workflows se lanzaron (herramienta Workflow).
// Sirve para saber qué piezas de un método se usan de verdad y cuáles solo ocupan lugar en el listado.
//
// Cómo se corre
//   node uso-herramientas.cjs [dias]     dias: número mayor que 0 (por defecto 30)
//   Lee las transcripciones de USO_RAIZ si está definida; si no, de <carpeta de Claude Code>/projects,
//   incluidas las carpetas de subagentes (un agente puede lanzar a otros).
//
// Una línea con marca de tiempo anterior a la ventana no cuenta aunque su archivo sea reciente; una
// línea sin marca de tiempo se conserva. No se deduplican bloques: Claude Code escribe uno por línea.
//
// Privacidad: solo lee el nombre de la herramienta, el tipo de agente, el modelo pedido y el nombre de
// la skill. Nunca los prompts, argumentos ni contenido de conversaciones.
//
// Códigos de salida: 0 correcto (también cuando no hay datos) · 1 uso incorrecto.
'use strict';

const fs = require('fs');
const path = require('path');
const { claudeHome, ahora } = require('./lib/comun.cjs');

const DIA_MS = 864e5;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function raizTranscripciones() {
  return process.env.USO_RAIZ || path.join(claudeHome(), 'projects');
}

// Nombre válido (texto no vacío) o '' si el campo falta o tiene otro tipo.
const nombre = (v) => (typeof v === 'string' && v.trim() ? v : '');

// Recorre <raiz> y cuenta las invocaciones. Una raíz inexistente da todo en cero.
function medir(raiz, dias, ahoraMs) {
  const desde = ahoraMs - dias * DIA_MS;
  const agentes = new Map();
  const modelosPedidos = new Map();
  const skills = new Map();
  let workflows = 0;
  let omitidos = 0;
  const contar = (mapa, clave) => mapa.set(clave, (mapa.get(clave) || 0) + 1);

  const recorrer = (dir) => {
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name)); } catch { return; }
    for (const e of entradas) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { recorrer(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      let lineas;
      try {
        if (fs.statSync(p).mtimeMs < desde) continue;
        lineas = fs.readFileSync(p, 'utf8').split('\n');
      } catch { omitidos++; continue; }
      for (const l of lineas) {
        if (!l.includes('"tool_use"')) continue;
        let j; try { j = JSON.parse(l); } catch { continue; }
        const t = j && j.timestamp ? Date.parse(j.timestamp) : NaN;
        if (t < desde) continue; // sin marca de tiempo (NaN) se conserva
        const bloques = j && j.message && Array.isArray(j.message.content) ? j.message.content : [];
        for (const b of bloques) {
          if (!b || b.type !== 'tool_use') continue;
          const entrada = b.input && typeof b.input === 'object' ? b.input : {};
          if (b.name === 'Agent' || b.name === 'Task') {
            contar(agentes, nombre(entrada.subagent_type) || '(general-purpose)');
            contar(modelosPedidos, nombre(entrada.model) || '(hereda)');
          } else if (b.name === 'Skill') {
            const s = nombre(entrada.skill);
            if (s) contar(skills, s);
          } else if (b.name === 'Workflow') workflows++;
        }
      }
    }
  };
  recorrer(raiz);
  return {
    agentes: Object.fromEntries(agentes),
    modelosPedidos: Object.fromEntries(modelosPedidos),
    skills: Object.fromEntries(skills),
    workflows,
    omitidos,
  };
}

function top(obj) {
  const filas = Object.entries(obj)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .map(([k, v]) => `${String(v).padStart(5)}  ${k}`);
  return filas.length ? filas.join('\n') : '(ninguno)';
}

function informe(r, dias) {
  return [
    `=== Agentes invocados (${dias} días) ===`,
    top(r.agentes),
    '',
    '=== Modelo pedido al lanzar agentes ===',
    top(r.modelosPedidos),
    '',
    '=== Skills invocadas ===',
    top(r.skills),
    '',
    `Workflows: ${r.workflows}`,
  ].join('\n');
}

function parsearArgumentos(argv) {
  if (argv.length > 1) throw new Error(`argumento de más: ${argv[1]}`);
  const dias = argv.length ? Number(argv[0]) : 30;
  if (!(dias > 0) || !Number.isFinite(dias)) throw new Error('dias debe ser un número mayor que 0');
  return { dias };
}

function main(argv) {
  let o;
  try { o = parsearArgumentos(argv); } catch (e) {
    process.stderr.write(`Error: ${e.message}\nUso: node uso-herramientas.cjs [dias>0]\n`);
    return 1;
  }
  const r = medir(raizTranscripciones(), o.dias, ahora().getTime());
  console.log(informe(r, o.dias));
  if (r.omitidos) process.stderr.write(`Aviso: ${r.omitidos} archivo(s) no se pudieron leer y se omitieron.\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { medir, informe, parsearArgumentos, raizTranscripciones, main };
