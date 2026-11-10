#!/usr/bin/env node
// scripts/ventana-contexto.cjs — única fuente del tope de compactación del kit UAEH.
//
// Lo leen la barra de estado y el vigía de contexto (hooks/vigia-contexto.js). Si cada uno llevara su
// propio número, el aviso de «cierra el bloque» se desfasaría del tope real en que la conversación se
// compacta sola.
//
// Orden de lectura (el primer valor > 0 gana; un archivo ilegible o sin el dato se salta):
//   1. variable CLAUDE_CODE_AUTO_COMPACT_WINDOW            (acepta 700000, 700k, 1M)
//   2. <cwd>/.claude/settings.local.json                   (ajustes locales del proyecto)
//   3. <cwd>/.claude/settings.json                         (ajustes del proyecto)
//   4. <claudeHome>/settings.json                          (ajustes del usuario)
//   En cada archivo se mira primero modelSettings[<modelo>].autoCompactWindow, luego el mismo con el
//   modelo sin su sufijo («claude-opus-5-5[1m]» → «claude-opus-5-5») y por último el autoCompactWindow
//   de nivel superior. Nada aplicable, o «auto» → 0 = sin tope propio: con modelos de ventana de 1M,
//   Claude Code compacta cerca de COMPACTA_SIN_TOPE.
// El flag --autocompact de la línea de comandos no se puede ver desde aquí.
//
// Uso:  node ventana-contexto.cjs [modelo]   → imprime el tope en tokens
'use strict';

const path = require('path');
const { claudeHome, leerJson } = require(path.join(__dirname, 'lib', 'comun.cjs'));

const COMPACTA_SIN_TOPE = 967000; // modelos con ventana de 1M compactan en ~967K por defecto

// 700000 · "700000" · "700k" · "1M" · 700 (se lee como miles) → tokens. Lo demás → 0.
function aTokens(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.round(v <= 1000 ? v * 1000 : v);
  }
  if (typeof v === 'string') {
    const m = v.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
    if (!m) return 0;
    const n = Number(m[1]);
    const t = m[2] === 'm' ? n * 1e6 : m[2] === 'k' ? n * 1e3 : (n <= 1000 ? n * 1e3 : n);
    return t > 0 ? Math.round(t) : 0;
  }
  return 0;
}

// Tokens que UN settings.json fija para este modelo; 0 si no trae ninguno válido.
function valorEnAjustes(ajustes, modelo) {
  if (!ajustes || typeof ajustes !== 'object') return 0;
  const id = String(modelo || '');
  const sinSufijo = id.replace(/\[[^\]]*\]$/, ''); // claude-opus-5-5[1m] → claude-opus-5-5
  const porModelo = ajustes.modelSettings && typeof ajustes.modelSettings === 'object' ? ajustes.modelSettings : {};
  for (const k of new Set([id, sinSufijo])) {
    if (!k || !Object.hasOwn(porModelo, k)) continue;
    const propios = porModelo[k];
    const v = aTokens(propios && typeof propios === 'object' ? propios.autoCompactWindow : undefined);
    if (v > 0) return v;
  }
  return aTokens(ajustes.autoCompactWindow);
}

// Archivos de ajustes por orden de prioridad. Con `settings` explícito (pruebas) se lee solo ese.
function archivosDeAjustes(opciones) {
  if (opciones.settings) return [opciones.settings];
  const cwd = path.resolve(opciones.cwd || process.cwd());
  return [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(claudeHome(), 'settings.json'),
  ];
}

// Tope de compactación en tokens para este modelo; 0 si nada lo fija (Claude Code usa entonces el suyo).
// opciones = { env, cwd, settings }:
//   env       variables de entorno a consultar (por defecto process.env)
//   cwd       carpeta del proyecto cuyos .claude/settings*.json se leen (por defecto process.cwd())
//   settings  solo para pruebas: ruta de UN settings.json que sustituye a los tres archivos de arriba
function topeCompactacion(modelo, opciones = {}) {
  const o = opciones || {};
  const env = o.env || process.env;
  const deEnv = aTokens(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (deEnv > 0) return deEnv;

  let archivos = [];
  try { archivos = archivosDeAjustes(o); } catch { /* ruta no resoluble: no hay archivos que leer */ }
  for (const archivo of archivos) {
    const v = valorEnAjustes(leerJson(archivo), modelo);
    if (v > 0) return v;
  }
  return 0;
}

module.exports = { topeCompactacion, aTokens, COMPACTA_SIN_TOPE };

if (require.main === module) {
  process.stdout.write(String(topeCompactacion(process.argv[2])) + '\n');
}
