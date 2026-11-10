#!/usr/bin/env node
// hooks/vigia-contexto.js — vigía de contexto del kit UAEH (capa 1). Avisa; no bloquea nunca.
//
// Por qué existe: en una sesión larga casi todo el gasto de tokens es RELEER el contexto en cada turno, y
// dos cosas lo disparan: conversaciones que crecen hasta el tope de compactación y archivos CLAUDE.md
// enormes que se cargan enteros en cada turno y en cada subagente. Este hook avisa de las dos:
//
//   node vigia-contexto.js prompt   (UserPromptSubmit) → el contexto pasó del 80 % o del 90 % del tope
//                                                        de compactación: conviene cerrar el bloque
//   node vigia-contexto.js inicio   (SessionStart)     → algún CLAUDE.md pasa de LIMITE_CLAUDE_MD (comun.cjs)
//
// Los umbrales salen del tope que resuelve scripts/ventana-contexto.cjs (la misma fuente que usa la barra
// de estado). Avisa UNA vez por umbral y por sesión (marcas en <tmp>/uaeh-vigia-contexto). Si algo falla,
// calla y sale con 0: un vigía nunca debe estorbar el trabajo. Sin nada que avisar no escribe nada.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FRACCIONES_AVISO = [0.8, 0.9];           // del tope en el que la conversación se compacta sola
const TOPE_SI_FALLA = 400000;                  // si el módulo del tope no carga: avisar antes, nunca después
const BYTES_FINAL_TRANSCRIPT = 2 * 1024 * 1024; // del transcript solo se lee el final: ahí está el último uso

// Tope de compactación para este modelo (0 = sin tope propio → el de Claude Code con ventana de 1M).
function topeDeCompactacion(modelo, cwd) {
  try {
    const v = require(path.join(__dirname, '..', 'scripts', 'ventana-contexto.cjs'));
    const tope = v.topeCompactacion(modelo, { cwd }) || v.COMPACTA_SIN_TOPE;
    return tope > 0 ? tope : TOPE_SI_FALLA;
  } catch { return TOPE_SI_FALLA; }
}

// Anota «ya avisado» (una marca por sesión y umbral). Si no puede anotarla, avisa igual: más vale un aviso
// repetido que ninguno.
function yaAvisado(sesion, clave) {
  try {
    const dir = path.join(os.tmpdir(), 'uaeh-vigia-contexto');
    fs.mkdirSync(dir, { recursive: true });
    const marca = path.join(dir, `${String(sesion).replace(/[^\w-]/g, '')}-${clave}`);
    if (fs.existsSync(marca)) return true;
    fs.writeFileSync(marca, String(Date.now()));
    return false;
  } catch { return false; }
}

// Contexto del último turno principal = lo que la próxima respuesta va a releer.
// Suma entrada + caché leída + caché escrita; ignora las líneas de subagentes (isSidechain).
function contextoActual(transcript) {
  const fd = fs.openSync(transcript, 'r');
  try {
    const tam = fs.fstatSync(fd).size;
    const leer = Math.min(tam, BYTES_FINAL_TRANSCRIPT);
    const buf = Buffer.alloc(leer);
    const leidos = fs.readSync(fd, buf, 0, leer, tam - leer);
    const lineas = buf.toString('utf8', 0, leidos).split('\n');
    for (let i = lineas.length - 1; i >= 0; i--) {
      const l = lineas[i];
      if (!l.includes('"usage"') || l.includes('"isSidechain":true')) continue;
      try {
        const linea = JSON.parse(l);
        if (linea.isSidechain === true) continue;
        const m = linea.message;
        const u = m.usage;
        return {
          tok: (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0),
          modelo: m.model || '',
        };
      } catch { /* línea cortada por el inicio de la ventana, o sin usage: sigue hacia atrás */ }
    }
  } finally { fs.closeSync(fd); }
  return { tok: 0, modelo: '' };
}

// Carpeta de trabajo de la sesión: cwd del evento, o workspace.current_dir, o la del proceso.
function cwdDeEntrada(e) {
  if (typeof e.cwd === 'string' && e.cwd) return e.cwd;
  const espacio = e.workspace;
  if (espacio && typeof espacio.current_dir === 'string' && espacio.current_dir) return espacio.current_dir;
  return process.cwd();
}

// UserPromptSubmit: ¿el contexto ya pasó de un umbral que todavía no se avisó en esta sesión?
function avisoDeContexto(comun, e, cwd) {
  if (typeof e.transcript_path !== 'string' || !fs.existsSync(e.transcript_path)) return null;
  const { tok, modelo } = contextoActual(e.transcript_path);
  const tope = topeDeCompactacion(modelo, cwd);
  const umbrales = FRACCIONES_AVISO.map((f) => Math.round(tope * f));
  const umbral = [...umbrales].reverse().find((u) => tok >= u);
  const sesion = e.session_id || 'sin-sesion';
  if (!umbral || yaAvisado(sesion, `ctx${umbral}`)) return null;

  const k = Math.round(tok / 1000);
  const pct = Math.round((tok / tope) * 100);
  return comun.salidaHook(
    'UserPromptSubmit',
    `VIGÍA DE CONTEXTO: esta conversación ya relee ~${k}K tokens en cada turno. ` +
      'Termina la tarea en curso; al cerrar el bloque guarda el estado (CLAUDE.md, tasks/todo.md, tasks/lessons.md) ' +
      'y avisa al usuario, en una línea, de que abra una sesión nueva para lo siguiente. ' +
      'No abras trabajo nuevo grande en esta sesión.',
    {
      systemMessage: `Contexto en ${k}K tokens (${pct} % del tope): conviene cerrar este bloque (guardar el estado) y abrir sesión nueva. Se compacta sola en ${Math.round(tope / 1000)}K.`,
    },
  );
}

// CLAUDE.md a medir: los del proyecto (cwd y ancestros) más el global, sin repetir ninguno.
function claudeMdAMedir(comun, cwd) {
  const lista = [...comun.claudeMdDelProyecto(cwd)];
  const global = path.join(comun.claudeHome(), 'CLAUDE.md');
  if (fs.existsSync(global)) lista.push(global);
  const vistos = new Set();
  return lista.filter((f) => {
    const clave = process.platform === 'win32' ? path.resolve(f).toLowerCase() : path.resolve(f);
    if (vistos.has(clave)) return false;
    vistos.add(clave);
    return true;
  });
}

// SessionStart: ¿algún CLAUDE.md pasa del presupuesto?
function avisoDeClaudeMd(comun, cwd) {
  const gordos = [];
  for (const f of claudeMdAMedir(comun, cwd)) {
    const texto = comun.leerTexto(f);
    if (texto != null && texto.length > comun.LIMITE_CLAUDE_MD) gordos.push({ f, n: texto.length });
  }
  if (!gordos.length) return null;
  // ≈ 3.6 caracteres por token
  const lista = gordos.map((x) => `${x.f} (${Math.round(x.n / 1000)}K caracteres ≈ ${Math.round(x.n / 3600)}K tokens)`).join('; ');
  return comun.salidaHook(
    'SessionStart',
    `VIGÍA DE CONTEXTO: CLAUDE.md por encima del presupuesto de ${comun.LIMITE_CLAUDE_MD / 1000}K caracteres: ${lista}. ` +
      'Se relee en cada turno y en cada subagente. Al cerrar este bloque, mueve la bitácora fechada a tasks/bitacora.md ' +
      '(textual, sin borrar nada) y deja en CLAUDE.md solo reglas, trampas vigentes, comandos y estado actual. ' +
      'Para hacerlo paso a paso: /uaeh-kit:dieta.',
  );
}

function decidir() {
  const comun = require(path.join(__dirname, '..', 'scripts', 'lib', 'comun.cjs'));
  const entrada = comun.leerStdinJson();
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const modo = process.argv[2];
  if (modo === 'prompt') return avisoDeContexto(comun, e, cwdDeEntrada(e));
  if (modo === 'inicio') return avisoDeClaudeMd(comun, cwdDeEntrada(e));
  return null;
}

let salida = null;
try { salida = decidir(); } catch { /* un vigía nunca estorba */ }
if (salida) {
  try {
    process.stdout.on('error', () => { /* tubería cerrada: no hay a quién avisar */ });
    process.stdout.write(JSON.stringify(salida));
  } catch { /* nada */ }
}
process.exitCode = 0;
