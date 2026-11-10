#!/usr/bin/env node
// hooks/inyectar-contexto.js — SessionStart del kit UAEH (capa 1: solo informa).
//
// Una vez por sesión y sin llamar al modelo (solo lee disco y arma texto):
//   1. Reglas compactas del método (≈ 900 caracteres), SOLO si todavía no llegan por otra vía: se omiten
//      con reglas.inyectar=false en uaeh.config.json, o si algún CLAUDE.md que Claude Code ya carga (el
//      global, o los de la carpeta del proyecto y sus ancestros) trae el bloque UAEH.
//   2. El mapa del proyecto (tasks/context-map.md o context-map.md, buscado desde el cwd hacia arriba
//      la de trabajo y hasta 4 por encima) para que la sesión arranque sin redescubrir el proyecto. Sin mapa, sugiere crearlo.
//   3. MARCA_CONTEXTO como primer texto: el doctor la busca en las transcripciones y así prueba que la
//      inyección llegó de verdad al modelo.
//
// Contrato: lee por stdin el JSON de Claude Code (trae `cwd`) y escribe en stdout
//   { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }
// que es el único formato que Claude Code inyecta. Nunca rompe la sesión: todo va en try/catch y la
// salida es siempre 0. Idioma de los textos: `idioma` de uaeh.config.json (es | en).
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_MAP_CHARS = 7500;  // tope para no inflar el contexto si el mapa creciera de más
const NIVELES_BUSQUEDA = 5;  // el cwd y 4 carpetas hacia arriba (proyectos anidados)

const TEXTOS = {
  es: {
    reglas: [
      'MÉTODO UAEH (capa 1, informativo):',
      '· Cabina limpia: lo que meta mucho texto y no necesites ver crudo va a un subagente que devuelve solo la conclusión; buscar/rastrear en muchos archivos → agente Explore.',
      '· Juntar pasos: lo que no depende del resultado anterior va en el mismo mensaje (llamadas en paralelo) o en un solo comando; el mismo cambio en 3+ archivos → script. Depurar sí va paso a paso.',
      '· Contexto chico: 1 sesión = 1 bloque de trabajo; si el vigía avisa (80 % del tope), termina, guarda y abre sesión nueva.',
      '· Lee lo que dice el mapa de contexto (tasks/context-map.md), no explores a ciegas. Al cerrar un bloque: actualiza el estado en CLAUDE.md (reemplazar, no acumular; ≤ 40K caracteres), tasks/todo.md y tasks/lessons.md.',
      '· Verificar antes de declarar terminado: abre el artefacto real; sin pruebas ejecutadas se dice «sin pruebas», no «funciona».',
    ].join('\n'),
    encabezadoMapa: (ruta) => `📍 MAPA DE ESTE PROYECTO (${ruta}):`,
    mapaTruncado: '\n…[mapa truncado: ver tasks/context-map.md completo]',
    sinMapa: '📍 Este proyecto no tiene tasks/context-map.md. Si es un proyecto real, créalo con /uaeh-kit:setup proyecto para que las próximas sesiones arranquen sin recontexto.',
  },
  en: {
    reglas: [
      'UAEH METHOD (layer 1, informative):',
      "· Clean cockpit: anything that pulls a lot of text you don't need raw goes to a subagent that returns only its conclusion; searching many files → the Explore agent.",
      "· Batch steps: whatever doesn't depend on the previous result goes in the same message (parallel calls) or one command; the same change in 3+ files → a script. Debugging stays step by step.",
      '· Small context: 1 session = 1 block of work; when the watchdog warns (80 % of the cap), finish, save and open a new session.',
      "· Read what the context map says (tasks/context-map.md); don't explore blindly. When closing a block: update the state in CLAUDE.md (replace, don't pile up; ≤ 40K chars), tasks/todo.md and tasks/lessons.md.",
      '· Verify before declaring done: open the real artifact; with no tests executed say "untested", never "works".',
    ].join('\n'),
    encabezadoMapa: (ruta) => `📍 CONTEXT MAP OF THIS PROJECT (${ruta}):`,
    mapaTruncado: '\n…[map truncated: see the full tasks/context-map.md]',
    sinMapa: '📍 This project has no tasks/context-map.md. If it is a real project, create it with /uaeh-kit:setup proyecto so future sessions start without re-discovery.',
  },
};

// Carpeta de trabajo de la sesión: cwd del evento, o workspace.current_dir, o la del proceso.
function cwdDeEntrada(input) {
  if (typeof input.cwd === 'string' && input.cwd) return input.cwd;
  const espacio = input.workspace;
  if (espacio && typeof espacio.current_dir === 'string' && espacio.current_dir) return espacio.current_dir;
  return process.cwd();
}

// Busca tasks/context-map.md (o context-map.md) en el cwd y subiendo hasta NIVELES_BUSQUEDA carpetas.
function buscarMapa(inicio) {
  let dir = inicio;
  for (let i = 0; i < NIVELES_BUSQUEDA; i++) {
    for (const candidato of [path.join(dir, 'tasks', 'context-map.md'), path.join(dir, 'context-map.md')]) {
      try { if (fs.statSync(candidato).isFile()) return candidato; } catch { /* no existe: sigue */ }
    }
    const padre = path.dirname(dir);
    if (padre === dir) break;
    dir = padre;
  }
  return null;
}

// Texto del mapa sin BOM ni espacios sobrantes, recortado a MAX_MAP_CHARS; null o '' si no hay nada que mostrar.
function leerMapa(comun, archivo, t) {
  const crudo = comun.leerTexto(archivo); // tolera BOM
  if (crudo == null) return null;
  const texto = crudo.trim();
  if (texto.length <= MAX_MAP_CHARS) return texto;
  let corte = MAX_MAP_CHARS;
  const ultimo = texto.charCodeAt(corte - 1);
  if (ultimo >= 0xD800 && ultimo <= 0xDBFF) corte -= 1; // no partir un par sustituto (emoji) por la mitad
  return texto.slice(0, corte) + t.mapaTruncado;
}

// El mapa con su encabezado, o la línea que sugiere crearlo.
function parteMapa(comun, cwd, t) {
  try {
    const archivo = buscarMapa(cwd);
    const mapa = archivo ? leerMapa(comun, archivo, t) : null;
    if (mapa) return `${t.encabezadoMapa(path.relative(cwd, archivo).replace(/\\/g, '/'))}\n\n${mapa}`;
  } catch { /* se trata como «sin mapa» */ }
  return t.sinMapa;
}

// ¿Alguno de los CLAUDE.md que Claude Code carga ya trae el bloque UAEH? Entonces las reglas llegan solas.
function reglasYaCargadas(comun, cwd) {
  try {
    const archivos = [path.join(comun.claudeHome(), 'CLAUDE.md'), ...comun.claudeMdDelProyecto(cwd)];
    return archivos.some((f) => {
      const texto = comun.leerTexto(f);
      return texto != null && comun.bloqueUaeh(texto).presente;
    });
  } catch { return false; }
}

// Arma el JSON de salida. Lanza solo si ni siquiera carga la biblioteca común (plugin dañado).
function construirSalida() {
  const comun = require(path.join(__dirname, '..', 'scripts', 'lib', 'comun.cjs'));
  const entrada = comun.leerStdinJson();
  const input = entrada && typeof entrada === 'object' ? entrada : {};
  const cwd = path.resolve(cwdDeEntrada(input));

  let config = {};
  try { config = comun.cargarConfig().config; } catch { /* valores por defecto */ }
  const t = TEXTOS[comun.idioma(config)];

  const partes = [];
  const quiereReglas = !(config && config.reglas && config.reglas.inyectar === false);
  if (quiereReglas && !reglasYaCargadas(comun, cwd)) partes.push(t.reglas);
  partes.push(parteMapa(comun, cwd, t));

  return JSON.stringify(comun.salidaHook('SessionStart', comun.MARCA_CONTEXTO + '\n' + partes.join('\n\n')));
}

let salida = null;
try { salida = construirSalida(); } catch { /* nunca romper la sesión */ }
if (salida) {
  try {
    process.stdout.on('error', () => { /* tubería cerrada: no hay a quién avisar */ });
    process.stdout.write(salida);
  } catch { /* nada */ }
}
process.exitCode = 0;
