#!/usr/bin/env node
// UAEH — guardia de cierre. Convierte en obligatorio lo que el método ya pedía por escrito y en la práctica se
// saltaba (medido: 5 veces en cuatro días de uso real): registrar la tarea al llegar los veredictos y no cerrar
// lista blanca sin revisión.
//
//   revisor   (SubagentStop, matcher uae-verifier|uae-security): anota que corrió un revisor en esta sesión.
//   commit    (PreToolUse, matcher Bash|PowerShell): si el comando hace `git commit` y toca archivos de lista
//             blanca, lo anota y le avisa a Claude (additionalContext). Nunca niega ni auto-aprueba.
//   cierre    (Stop): bloquea UNA sola vez por pendiente y por sesión:
//               1) corrieron revisores y la tarea no está en uaeh/registro.jsonl;
//               2) hubo commit de lista blanca y ningún revisor corrió.
//             Con stop_hook_active no bloquea nunca (sin bucles).
//   directo   --sesion <id> "motivo"   → el commit de lista blanca era un falso positivo; queda con huella.
//   descartar --sesion <id> "motivo"   → los revisores fueron una re-verificación ya registrada; queda con huella.
//
// Estado por sesión: <UAEH_HOME>/sesiones/<session_id>.json. Huellas: <UAEH_HOME>/excepciones.jsonl.
// Apagar sin tocar settings: crear el archivo <UAEH_HOME>/guardia-cierre.apagada.
// Siempre a prueba de fallos: cualquier error → exit 0 y silencio (se anota en guardia-cierre.log).
// Lista blanca: sale de uaeh.config.json (listaBlanca.agregar / categorias / excluirRutas / excluirExtensiones; ver
// scripts/lib/config.cjs). De fábrica solo trae patrones genéricos de dinero, cuentas, base de datos y producción.
// Residuales declarados: no analiza `git commit <rutas>` explícitas ni `cd` con comillas raras; los patrones
// de lista blanca son por nombre de archivo (pueden dar falsos positivos: cuesta una línea con `directo`).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REVISORES = new Set(['uae-verifier', 'uae-security']);
const MAX_ENTRADAS = 20;
// Rutas ABSOLUTAS a los scripts hermanos, con «/» y entre comillas dobles en los mensajes para pegarlas tal cual en
// cualquier shell: el hook vive en la caché del plugin y los scripts se localizan entre sí con __dirname.
const SCRIPT_REGISTRO = path.join(__dirname, '..', 'scripts', 'uaeh-registro.cjs').replace(/\\/g, '/');
const SCRIPT_GUARDIA = path.join(__dirname, 'uaeh-guardia-cierre.js').replace(/\\/g, '/');

// Bibliotecas del plugin (scripts/lib), cargadas al pedirlas por primera vez: si faltan o no cargan, el error cae en el
// try general del arranque (exit 0 y guardia-cierre.log) en vez de romper el hook al cargarse.
const DIR_LIB = path.join(__dirname, '..', 'scripts', 'lib');
let comunLib = null;
let configLib = null;
const comun = () => comunLib || (comunLib = require(path.join(DIR_LIB, 'comun.cjs')));
const config = () => configLib || (configLib = require(path.join(DIR_LIB, 'config.cjs')));

function uaehHome() {
  return comun().uaehHome();
}
function ahora() {
  return comun().ahora().toISOString();
}
function apagada() {
  return fs.existsSync(path.join(uaehHome(), 'guardia-cierre.apagada'));
}
function log(op, err) {
  try {
    fs.mkdirSync(uaehHome(), { recursive: true });
    fs.appendFileSync(path.join(uaehHome(), 'guardia-cierre.log'), `${new Date().toISOString()} ${op}: ${(err && err.stack) || err}\n`);
  } catch { /* silencio */ }
}
function leerStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}
function idSeguro(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(id);
}
function rutaEstado(sesion) {
  return path.join(uaehHome(), 'sesiones', sesion + '.json');
}
function leerEstado(sesion) {
  try { return JSON.parse(fs.readFileSync(rutaEstado(sesion), 'utf8')); } catch { return null; }
}
function estadoNuevo(sesion) {
  return { sesion, creado: ahora(), revisores: [], listaBlanca: [], cerrados: [], avisos: {}, excepciones: [] };
}
function guardarEstado(st) {
  const f = rutaEstado(st.sesion);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 1));
  fs.renameSync(tmp, f);
}
function leerJsonl(f) {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function fechaMs(s) {
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}
// Hora (HH:MM) en la zona configurada: UAEH_TZ, zonaHoraria de la configuración o, si no, la del sistema.
function hhmm(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '?';
  const c = comun();
  return c.isoZona(d, c.zonaHoraria(config().cargarConfig().config)).slice(11, 16);
}

// ---------- revisor (SubagentStop) ----------
// Nombre del agente sin el prefijo del plugin («uaeh-harness:uae-verifier» → «uae-verifier»): lo resuelve hooks/_identidad.js.
function tipoAgente(e) {
  return require(path.join(__dirname, '_identidad.js')).tipoAgente(e);
}
function opRevisor() {
  const e = leerStdin();
  if (!e || !idSeguro(e.session_id) || !REVISORES.has(tipoAgente(e))) return 0;
  const st = leerEstado(e.session_id) || estadoNuevo(e.session_id);
  st.revisores.push({ agente: tipoAgente(e), agent_id: String(e.agent_id || ''), fecha: ahora() });
  if (st.revisores.length > MAX_ENTRADAS) st.revisores = st.revisores.slice(-MAX_ENTRADAS);
  guardarEstado(st);
  return 0;
}

// ---------- commit (PreToolUse) ----------
function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}
function lineas(s) {
  return String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
function sinComillas(t) {
  return t.replace(/^["']+|["']+$/g, '');
}
function segmentoCommit(cmd) {
  // Primer tramo (sin | ; &&) que contiene `git … commit`.
  for (const seg of cmd.split(/\|\||&&|;|\|/)) {
    if (/\bgit\b[^\n]*?\bcommit\b/.test(seg)) return seg;
  }
  return null;
}
function carpetaDelComando(cmd, cwd) {
  const m = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd);
  if (m) return path.resolve(cwd, sinComillas(m[1]));
  const cd = /(^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd);
  if (cd) return path.resolve(cwd, sinComillas(cd[2]));
  return cwd;
}
function rutasDeGitAdd(cmd, dir, raiz) {
  const out = new Set();
  const re = /\bgit\b[^|;&\n]*?\badd\b([^|;&\n]*)/g;
  let m;
  while ((m = re.exec(cmd))) {
    const toks = m[1].match(/"[^"]*"|'[^']*'|\S+/g) || [];
    for (const tok0 of toks) {
      const tok = sinComillas(tok0);
      if (tok === '-A' || tok === '--all' || tok === '.' || tok === '-u' || tok === '--update') {
        for (const l of lineas(git(dir, ['status', '--porcelain']))) out.add(l.slice(3).replace(/^.* -> /, ''));
      } else if (!tok.startsWith('-')) {
        out.add(path.relative(raiz, path.resolve(dir, tok)));
      }
    }
  }
  return [...out];
}
// Clasifica con la lista blanca de la configuración (uaeh.config.json → listaBlanca; lib/config.cjs) y devuelve
// [{ archivo, categoria }] con el nombre legible de la categoría. Se arma al hacer falta, no al arrancar: casi todos los
// comandos que pasan por este hook no son un commit.
function clasificar(archivos) {
  const cfg = config();
  return cfg.clasificar(archivos, cfg.listaBlanca(cfg.cargarConfig().config));
}
// Ruta real de una carpeta (larga, con las mayúsculas del disco). Un cwd con nombre corto 8.3 (RUNNER~1 por la carpeta de usuario) y la
// raíz que devuelve git (larga) no se pueden comparar ni relativizar entre sí sin esto.
function rutaReal(p) {
  try { return fs.realpathSync.native(p); } catch { return p; }
}
function archivosDelCommit(cmd, cwd) {
  const seg = segmentoCommit(cmd);
  if (!seg) return null;
  const dir = rutaReal(carpetaDelComando(cmd, cwd));
  let raiz;
  try { raiz = lineas(git(dir, ['rev-parse', '--show-toplevel']))[0]; } catch { return null; }
  if (!raiz) return null;
  raiz = rutaReal(raiz);
  const set = new Set();
  const agregar = (r) => { const n = String(r).replace(/\\/g, '/').replace(/^\.\//, ''); if (n) set.add(n); };
  lineas(git(dir, ['diff', '--cached', '--name-only'])).forEach(agregar);
  if (/(^|\s)(-a|--all|-am|-aM)\b/.test(seg)) lineas(git(dir, ['diff', '--name-only'])).forEach(agregar);
  rutasDeGitAdd(cmd, dir, raiz).forEach(agregar);
  return { raiz, archivos: [...set] };
}
function opCommit() {
  const e = leerStdin();
  const cmd = e && e.tool_input && e.tool_input.command;
  if (!e || typeof cmd !== 'string' || !/\bgit\b/.test(cmd) || !/\bcommit\b/.test(cmd)) return 0;
  const cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : process.cwd();
  const res = archivosDelCommit(cmd, cwd);
  if (!res) return 0;
  const hallados = clasificar(res.archivos);
  if (!hallados.length) return 0;
  const sesion = idSeguro(e.session_id) ? e.session_id : null;
  if (sesion) {
    const st = leerEstado(sesion) || estadoNuevo(sesion);
    st.listaBlanca.push({ fecha: ahora(), repo: res.raiz, archivos: hallados.slice(0, MAX_ENTRADAS) });
    if (st.listaBlanca.length > MAX_ENTRADAS) st.listaBlanca = st.listaBlanca.slice(-MAX_ENTRADAS);
    guardarEstado(st);
  }
  const lista = resumenHallados(hallados);
  const msg = `UAEH · lista blanca: este commit toca archivos de lista blanca (${lista}). Regla vigente: tras el commit de ` +
    'trabajo lanza uae-verifier (y uae-security si es dinero o cuentas) sobre ese commit, con mapa de lectura y tope de 15 min, ' +
    'y registra la tarea al recibir los veredictos. Si de verdad NO es lista blanca, anota el motivo: ' +
    `node "${SCRIPT_GUARDIA}" directo "motivo"`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } }));
  return 0;
}
function resumenHallados(hallados) {
  const porCat = {};
  for (const h of hallados) (porCat[h.categoria] = porCat[h.categoria] || []).push(h.archivo);
  return Object.entries(porCat).map(([c, a]) => `${c}: ${a.slice(0, 4).join(', ')}${a.length > 4 ? ` y ${a.length - 4} más` : ''}`).join(' · ');
}

// ---------- cierre (Stop) ----------
function registroTieneDesde(desdeIso) {
  const desde = fechaMs(desdeIso) - 60 * 1000;
  return leerJsonl(path.join(uaehHome(), 'registro.jsonl')).some((l) => fechaMs(l.fecha) >= desde);
}
function selloOrquestadorDesde(desdeIso) {
  const desde = fechaMs(desdeIso) - 60 * 1000;
  return leerJsonl(path.join(uaehHome(), 'integridad', 'registro.jsonl')).some((l) => !l.agente && l.resultado && fechaMs(l.fecha) >= desde);
}
function opCierre() {
  const e = leerStdin();
  if (!e || e.stop_hook_active === true || !idSeguro(e.session_id)) return 0;
  const st = leerEstado(e.session_id);
  if (!st) return 0;
  const motivos = [];
  let cambio = false;

  if (st.revisores.length) {
    const desde = st.revisores[0].fecha;
    if (registroTieneDesde(desde)) {
      st.cerrados.push({ fecha: ahora(), como: 'registro', revisores: st.revisores, listaBlanca: st.listaBlanca });
      st.revisores = [];
      st.listaBlanca = [];
      cambio = true;
    } else if (!st.avisos.registro) {
      st.avisos.registro = ahora();
      cambio = true;
      const n = {};
      for (const r of st.revisores) n[r.agente] = (n[r.agente] || 0) + 1;
      const conteo = Object.entries(n).map(([a, c]) => `${a} ×${c}`).join(', ');
      let m = `UAEH · guardia de cierre: en esta sesión corrieron revisores (${conteo}; el primero a las ${hhmm(desde)}) y la tarea NO está ` +
        'en el registro. Antes de cerrar, regístrala (una línea por tarea, con el estado de ESTE momento aunque sea PENDING_HUMAN_REVIEW):\n' +
        `node "${SCRIPT_REGISTRO}" --proyecto <carpeta> --ruta <build|deep> --riesgo <alto|critico> --ciclos <n> --minutos <desde la hora de inicio> ` +
        '--escalamiento "<ninguno|detalle>" --estado <PASS_TECHNICAL|PENDING_HUMAN_REVIEW|FAIL|UNKNOWN|BLOCKED_SECURITY> --tarea "<resumen de hasta 120 caracteres>"';
      if (!selloOrquestadorDesde(desde)) {
        m += '\nAdemás no consta el sello del orquestador (uaeh-integridad.cjs foto/comparar) después de esa hora: sin sello INTACTO el veredicto vale UNKNOWN, no PASS.';
      }
      m += `\nSi fue una re-verificación de una tarea ya registrada: node "${SCRIPT_GUARDIA}" descartar --sesion ${st.sesion} "motivo"`;
      motivos.push(m);
    }
  }

  if (st.listaBlanca.length && !st.revisores.length && !st.avisos.listaBlanca && !motivos.length) {
    st.avisos.listaBlanca = ahora();
    cambio = true;
    const todos = [].concat(...st.listaBlanca.map((b) => b.archivos));
    motivos.push('UAEH · guardia de cierre: en esta sesión hubo un commit que toca archivos de lista blanca (' + resumenHallados(todos) +
      ') y no corrió ningún revisor. La regla: uae-verifier (y uae-security si es dinero o cuentas) sobre ese commit, con tope de 15 min, ' +
      'y después el registro. Si de verdad no es lista blanca, anota el motivo y cierra: ' +
      `node "${SCRIPT_GUARDIA}" directo --sesion ${st.sesion} "motivo"`);
  }

  if (cambio) guardarEstado(st);
  if (motivos.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: motivos.join('\n\n') }));
  return 0;
}

// ---------- directo / descartar (línea de comandos) ----------
function opExcepcion(tipo, args) {
  let sesion = process.env.CLAUDE_CODE_SESSION_ID || '';
  const resto = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sesion') { sesion = args[i + 1] || ''; i++; } else resto.push(args[i]);
  }
  const motivo = resto.join(' ').trim();
  if (!idSeguro(sesion) || motivo.length < 5) {
    process.stderr.write(`Uso: node uaeh-guardia-cierre.js ${tipo} [--sesion <id>] "motivo de al menos 5 caracteres"\n` +
      '(sin --sesion toma CLAUDE_CODE_SESSION_ID)\n');
    return 1;
  }
  const st = leerEstado(sesion) || estadoNuevo(sesion);
  const huella = { fecha: ahora(), sesion, tipo, motivo };
  if (tipo === 'directo') { huella.archivos = [].concat(...st.listaBlanca.map((b) => b.archivos)); st.listaBlanca = []; delete st.avisos.listaBlanca; }
  else { huella.revisores = st.revisores; st.cerrados.push({ fecha: ahora(), como: 'descartado', motivo, revisores: st.revisores }); st.revisores = []; delete st.avisos.registro; }
  st.excepciones.push(huella);
  guardarEstado(st);
  fs.appendFileSync(path.join(uaehHome(), 'excepciones.jsonl'), JSON.stringify(huella) + '\n');
  process.stdout.write(`Anotado (${tipo}) en ${path.join(uaehHome(), 'excepciones.jsonl')} para la sesión ${sesion}.\n`);
  return 0;
}

function main() {
  const op = process.argv[2];
  const args = process.argv.slice(3);
  if (apagada()) {
    if (op === 'directo' || op === 'descartar') process.stdout.write('La guardia de cierre está apagada (archivo guardia-cierre.apagada); nada que anotar.\n');
    return 0;
  }
  if (op === 'revisor') return opRevisor();
  if (op === 'commit') return opCommit();
  if (op === 'cierre') return opCierre();
  if (op === 'directo' || op === 'descartar') return opExcepcion(op, args);
  process.stderr.write('Uso: uaeh-guardia-cierre.js revisor | commit | cierre | directo [--sesion <id>] "motivo" | descartar [--sesion <id>] "motivo"\n');
  return op === undefined ? 1 : 0;
}

let codigo = 0;
try { codigo = main(); } catch (err) { log(process.argv[2], err); codigo = 0; }
process.exitCode = codigo;
