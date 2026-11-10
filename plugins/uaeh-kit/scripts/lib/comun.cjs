#!/usr/bin/env node
// lib/comun.cjs — utilidades compartidas por hooks, scripts y barra de estado del kit UAEH.
//
// Reglas de esta biblioteca:
//   · Sin dependencias externas. Node ≥ 20.
//   · Nunca lanza por configuración rota: devuelve valores por defecto y lo anota en `avisos`.
//   · Las rutas de estado salen de aquí y de ningún otro sitio:
//       claudeHome()  = CLAUDE_CONFIG_DIR o ~/.claude          (donde vive Claude Code)
//       uaehHome()    = UAEH_HOME o <claudeHome>/uaeh          (estado del método: config, caché, espejo)
//       estableDir()  = <uaehHome>/estable                     (copia con ruta fija para lo que no puede
//                                                               depender de la versión del plugin)
//   · La hora se pide siempre a ahora(): las pruebas la fijan con UAEH_AHORA (ISO 8601).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Marca que el hook de contexto antepone a lo que inyecta. El doctor la busca en las
// transcripciones para demostrar que la inyección llegó de verdad al modelo.
const MARCA_CONTEXTO = '[uaeh-kit ctx v1]';

// Marcadores del bloque de reglas dentro de un CLAUDE.md (lo escribe instalar.cjs claude-md).
const BLOQUE_INICIO = /<!--\s*UAEH:BEGIN(?:\s+v([0-9][^\s>]*))?\s*-->/;
const BLOQUE_FIN = /<!--\s*UAEH:END\s*-->/;

const LIMITE_CLAUDE_MD = 40000; // caracteres (~11K tokens). Se relee en cada turno y en cada subagente.

function limpiar(v) {
  return typeof v === 'string' && v.trim() ? path.resolve(v.trim()) : null;
}

function claudeHome() {
  return limpiar(process.env.CLAUDE_CONFIG_DIR) || path.join(os.homedir(), '.claude');
}

function codexHome() {
  return limpiar(process.env.CODEX_HOME) || path.join(os.homedir(), '.codex');
}

function uaehHome() {
  return limpiar(process.env.UAEH_HOME) || path.join(claudeHome(), 'uaeh');
}

function estableDir() {
  return path.join(uaehHome(), 'estable');
}

function cacheDir() {
  return path.join(uaehHome(), 'cache');
}

function raizPlugin() {
  return path.resolve(__dirname, '..', '..');
}

// Versión declarada en .claude-plugin/plugin.json del plugin que contiene esta biblioteca
// (o del espejo: instalar.cjs deja un archivo VERSION junto a la copia).
function versionPlugin() {
  const manifiesto = leerJson(path.join(raizPlugin(), '.claude-plugin', 'plugin.json'));
  if (manifiesto && typeof manifiesto.version === 'string') return manifiesto.version;
  try { return fs.readFileSync(path.join(raizPlugin(), 'VERSION'), 'utf8').trim() || '0.0.0'; } catch { return '0.0.0'; }
}

function leerTexto(ruta) {
  try {
    let raw = fs.readFileSync(ruta, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // tolera BOM
    return raw;
  } catch { return null; }
}

function leerJson(ruta) {
  const raw = leerTexto(ruta);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function escribirJson(ruta, obj) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ── Tiempo ────────────────────────────────────────────────────────────────────────────

// Fecha «actual». UAEH_AHORA (ISO 8601) la fija en pruebas; si no parsea, se ignora.
function ahora() {
  const fijo = process.env.UAEH_AHORA;
  if (fijo) {
    const t = Date.parse(fijo);
    if (!Number.isNaN(t)) return new Date(t);
  }
  return new Date();
}

function zonaValida(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }); return true; } catch { return false; }
}

// Zona efectiva: UAEH_TZ > uaeh.config.json zonaHoraria > zona local del sistema.
// Sin argumento lee la configuración del usuario (una lectura de JSON); `null` la salta a propósito (solo entorno/sistema).
function zonaHoraria(config) {
  const deEnv = process.env.UAEH_TZ;
  if (zonaValida(deEnv)) return deEnv.trim();
  if (config === undefined) { try { config = cargarConfig().config; } catch { config = null; } }
  const deConfig = config && config.zonaHoraria;
  if (zonaValida(deConfig)) return deConfig.trim();
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function dosDigitos(n) { return String(n).padStart(2, '0'); }

// Partes de una fecha en una zona IANA, sin librerías: Intl con formato numérico.
function partesEnZona(fecha, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const x of f.formatToParts(fecha)) if (x.type !== 'literal') p[x.type] = x.value;
  return p;
}

// Desfase en minutos de la zona respecto a UTC en ese instante (positivo al este de Greenwich).
function desfaseMinutos(fecha, tz) {
  const p = partesEnZona(fecha, tz);
  const comoUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((comoUtc - fecha.getTime()) / 60000);
}

function textoDesfase(min) {
  const signo = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  return `${signo}${dosDigitos(Math.floor(abs / 60))}:${dosDigitos(abs % 60)}`;
}

// ISO 8601 con desfase local de la zona: 2026-10-30T22:15:03-05:00
function isoZona(fecha = ahora(), tz) {
  const zona = zonaValida(tz) ? tz : zonaHoraria();
  const p = partesEnZona(fecha, zona);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${textoDesfase(desfaseMinutos(fecha, zona))}`;
}

// Legible: 2026-10-30 22:15 (America/Mexico_City)
function legibleZona(fecha = ahora(), tz) {
  const zona = zonaValida(tz) ? tz : zonaHoraria();
  const p = partesEnZona(fecha, zona);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} (${zona})`;
}

// ── Configuración del usuario: <uaehHome>/uaeh.config.json ───────────────────────────
// La capa 1 usa pocas claves; el resto se conserva tal cual para las capas siguientes.

const CONFIG_DEFECTO = Object.freeze({
  version: 1,
  idioma: 'auto',          // auto | es | en
  zonaHoraria: '',         // IANA; vacío = la del sistema
  reglas: { inyectar: true },
  statusline: { estadoClaude: false, guardarLimites: false },
});

const CLAVES_CONOCIDAS = new Set([
  'version', 'idioma', 'zonaHoraria', 'commits', 'listaBlanca', 'arnes', 'reglas', 'statusline',
  'datos', 'wsl', 'codex', 'visual', 'preflight', 'proyectos',
]);

function rutaConfig() {
  return path.join(uaehHome(), 'uaeh.config.json');
}

function fusionar(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = fusionar(out[k], v);
    else out[k] = v;
  }
  return out;
}

// Devuelve { config, avisos:[], existe:boolean, ruta }. Nunca lanza.
function cargarConfig(ruta = rutaConfig()) {
  const avisos = [];
  const raw = leerTexto(ruta);
  if (raw == null) return { config: fusionar(CONFIG_DEFECTO, {}), avisos, existe: false, ruta };
  let usuario;
  try { usuario = JSON.parse(raw); } catch (e) {
    avisos.push(`uaeh.config.json no parsea (${e.message}); se usan los valores por defecto.`);
    return { config: fusionar(CONFIG_DEFECTO, {}), avisos, existe: true, ruta };
  }
  if (!usuario || typeof usuario !== 'object' || Array.isArray(usuario)) {
    avisos.push('uaeh.config.json no es un objeto; se usan los valores por defecto.');
    return { config: fusionar(CONFIG_DEFECTO, {}), avisos, existe: true, ruta };
  }
  for (const k of Object.keys(usuario)) if (!CLAVES_CONOCIDAS.has(k)) avisos.push(`clave desconocida en uaeh.config.json: "${k}" (se ignora).`);
  if (usuario.idioma != null && !['auto', 'es', 'en'].includes(usuario.idioma)) {
    avisos.push(`idioma "${usuario.idioma}" no reconocido; se usa "auto".`);
    usuario = { ...usuario, idioma: 'auto' };
  }
  if (usuario.zonaHoraria && !zonaValida(usuario.zonaHoraria)) {
    avisos.push(`zonaHoraria "${usuario.zonaHoraria}" no es una zona IANA válida; se usa la del sistema.`);
    usuario = { ...usuario, zonaHoraria: '' };
  }
  return { config: fusionar(CONFIG_DEFECTO, usuario), avisos, existe: true, ruta };
}

// Idioma efectivo de los textos que ve el usuario: 'es' | 'en'. 'auto' → español en v1.
function idioma(config) {
  const v = config && config.idioma;
  return v === 'en' ? 'en' : 'es';
}

// ── CLAUDE.md ─────────────────────────────────────────────────────────────────────────

// CLAUDE.md que Claude Code carga para un cwd: desde cwd hacia arriba hasta la raíz del disco
// (Claude Code lee todos los ancestros, incluido un CLAUDE.md suelto en la carpeta de usuario).
// El global (<claudeHome>/CLAUDE.md) no es ancestro y se trata aparte. `tope` (pruebas) corta la subida.
function claudeMdDelProyecto(cwd, opciones = {}) {
  let dir = path.resolve(cwd || process.cwd());
  const tope = opciones.tope ? path.resolve(opciones.tope).toLowerCase() : null;
  const encontrados = [];
  for (let i = 0; i < 64; i++) {
    const f = path.join(dir, 'CLAUDE.md');
    if (fs.existsSync(f)) encontrados.push(f);
    if (tope && dir.toLowerCase() === tope) break;
    const padre = path.dirname(dir);
    if (padre === dir) break;
    dir = padre;
  }
  return encontrados;
}

// ¿El texto contiene el bloque UAEH? Devuelve { presente, version } (version puede ser null).
function bloqueUaeh(texto) {
  if (typeof texto !== 'string') return { presente: false, version: null };
  const m = BLOQUE_INICIO.exec(texto);
  if (!m || !BLOQUE_FIN.test(texto)) return { presente: false, version: null };
  return { presente: true, version: m[1] || null };
}

// ── Hooks ─────────────────────────────────────────────────────────────────────────────

// JSON que Claude Code sí inyecta: solo hookSpecificOutput.additionalContext llega al modelo.
function salidaHook(evento, contexto, extra) {
  const out = { hookSpecificOutput: { hookEventName: evento, additionalContext: contexto } };
  return Object.assign(out, extra || {});
}

// Lee todo stdin de forma síncrona y lo parsea como JSON; ante cualquier fallo, {}.
function leerStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw && raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}

module.exports = {
  MARCA_CONTEXTO, BLOQUE_INICIO, BLOQUE_FIN, LIMITE_CLAUDE_MD, CONFIG_DEFECTO, CLAVES_CONOCIDAS,
  claudeHome, codexHome, uaehHome, estableDir, cacheDir, raizPlugin, versionPlugin,
  leerTexto, leerJson, escribirJson,
  ahora, zonaValida, zonaHoraria, isoZona, legibleZona, desfaseMinutos,
  rutaConfig, cargarConfig, idioma, fusionar,
  claudeMdDelProyecto, bloqueUaeh,
  salidaHook, leerStdinJson,
};
