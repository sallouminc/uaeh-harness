#!/usr/bin/env node
// lib/config.cjs — configuración del arnés UAEH (plugin uaeh-harness) sobre lib/comun.cjs.
//
// Una sola configuración de usuario: <uaehHome>/uaeh.config.json (nunca de proyecto: las guardas no pueden
// depender de un archivo que el propio repo revisado podría cambiar). Precedencia, de mayor a menor:
//   bandera de línea de comandos > variable UAEH_* > archivo > valor por defecto.
// Nunca lanza por configuración rota: devuelve los valores por defecto y lo anota en `avisos`.
//
// Variables de entorno que pisan el archivo (las demás UAEH_* las leen sus propios scripts):
//   UAEH_COMMIT_CREDITO  permitir | prohibir      → commits.credito
//   UAEH_COMMIT_FIRMA    texto                    → commits.firma
//   UAEH_RUNS_DIR        carpeta                  → datos.runs
//   UAEH_WSL_DISTRO      nombre de la distro      → wsl.distro
//   UAEH_WSL_USER        usuario de la distro     → wsl.usuario
//   UAEH_GIT_HOOKS       carpeta                  → dónde vive la guarda de git (rutaGitHooks); por defecto, el espejo
//   UAEH_TZ              zona IANA                → la lee comun.zonaHoraria()
'use strict';

const path = require('path');
const comun = require(path.join(__dirname, 'comun.cjs'));

// Nombre de la carpeta del espejo de este plugin dentro de <uaehHome>/estable/. El kit (capa 1) escribe en la raíz
// de estable/; el arnés escribe en su propia subcarpeta para que las dos copias nunca se pisen (cada una con su VERSION).
const NOMBRE_ESPEJO = 'uaeh-harness';

const CONFIG_DEFECTO = Object.freeze({
  version: 1,
  idioma: 'auto',
  zonaHoraria: '',
  commits: { credito: 'permitir', firma: '' },
  listaBlanca: { excluirRutas: [], excluirExtensiones: [], categorias: {}, agregar: {} },
  arnes: { extra: [] },
  reglas: { inyectar: true },
  statusline: { estadoClaude: false, guardarLimites: false },
  datos: { runs: '', retencion: { completasDias: 30, borrarDias: 365, mantenerUltimas: 3, avisoGB: 5 } },
  wsl: { distro: 'Ubuntu-24.04', usuario: '' },
  codex: {
    habilitado: false,
    consentimiento: '',
    modelos: {
      profundo: { modelo: 'gpt-6-astra', esfuerzo: 'high' },
      equilibrado: { modelo: 'gpt-6-sol', esfuerzo: 'medium' },
      rapido: { modelo: 'gpt-6-luna', esfuerzo: 'medium' },
    },
    timeoutDiffMin: 10,
    timeoutCompletaMin: 40,
  },
  visual: { catalogo: '' },
  preflight: { jurisdiccion: '' },
});

// Claves que existieron en versiones anteriores y ya no hacen nada: se toleran en el archivo del usuario (sin aviso de
// «desconocida») y se descartan al cargar, para que ningún código vuelva a depender de ellas.
const OBSOLETAS = Object.freeze([['codex', 'exigir'], ['visual', 'viewports'], ['proyectos']]);

const CREDITOS = new Set(['permitir', 'prohibir']);
const ESFUERZOS = new Set(['low', 'medium', 'high', 'xhigh']);

// ── Lista blanca por defecto ──────────────────────────────────────────────────────────
// Patrones por NOMBRE de archivo (ruta relativa al repo, normalizada a minúsculas y con «/»). Pueden dar
// falsos positivos: cuesta una línea con «directo "motivo"» en la guardia de cierre. Las categorías se identifican
// por una clave estable (sin acentos) y se muestran con su nombre legible.
const CATEGORIAS_DEFECTO = [
  ['dinero', 'dinero', ['pric|precio|plan(es)?[-_./]|suscri|subscri|pago|payment|cobro|billing|checkout|stripe|revenuecat|comision|commission|factur|invoice|tarifa|contable|mrr']],
  ['cuentas', 'cuentas', ['auth|login|sesion|session|password|contrase|token|jwt|permis|rbac|acceso|invitaci|(^|[^a-z])otp|totp|biometr|huella|passkey|middleware']],
  ['baseDeDatos', 'base de datos', ['migra|schema|esquema|\\.sql$|supabase/|prisma/|drizzle|(^|/|[-_])rls([-_./]|$)']],
  ['produccion', 'producción', ['vercel\\.json$|deploy|despleg|publicar|\\.github/workflows|dockerfile|(^|/)\\.env']],
];
const EXCLUIR_RUTAS_DEFECTO = ['tasks', 'docs', 'output', 'builds', 'node_modules', '.git', 'respaldo', 'respaldos', 'captura', 'capturas'];
const EXCLUIR_EXTENSIONES_DEFECTO = ['md', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'mp4', 'mov', 'ico', 'lock', 'css', 'scss', 'map'];

function escapar(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function textoNoVacio(v) { return typeof v === 'string' && v.trim() !== ''; }

function listaDeTextos(v, avisos, nombre) {
  if (v == null) return [];
  if (!Array.isArray(v)) { avisos.push(`${nombre} debe ser una lista de textos; se ignora.`); return []; }
  const salida = [];
  for (const x of v) {
    if (textoNoVacio(x)) salida.push(x.trim());
    else avisos.push(`${nombre} trae un valor que no es texto; se ignora.`);
  }
  return salida;
}

// Compila un patrón escrito por el usuario (fuente de expresión regular, insensible a mayúsculas). Inválido → null + aviso.
function compilar(fuente, avisos, nombre) {
  try { return new RegExp(fuente, 'i'); } catch (e) {
    avisos.push(`${nombre}: el patrón «${fuente}» no es una expresión regular válida (${e.message}); se ignora.`);
    return null;
  }
}

// ── Carga ─────────────────────────────────────────────────────────────────────────────

function aplicarEntorno(config, env, avisos) {
  const out = comun.fusionar(config, {});
  const credito = env.UAEH_COMMIT_CREDITO;
  if (textoNoVacio(credito)) {
    if (CREDITOS.has(credito.trim())) out.commits = { ...out.commits, credito: credito.trim() };
    else avisos.push(`UAEH_COMMIT_CREDITO="${credito}" no es permitir|prohibir; se ignora.`);
  }
  if (typeof env.UAEH_COMMIT_FIRMA === 'string') out.commits = { ...out.commits, firma: env.UAEH_COMMIT_FIRMA.trim() };
  if (textoNoVacio(env.UAEH_RUNS_DIR)) out.datos = { ...out.datos, runs: path.resolve(env.UAEH_RUNS_DIR.trim()) };
  if (textoNoVacio(env.UAEH_WSL_DISTRO)) out.wsl = { ...out.wsl, distro: env.UAEH_WSL_DISTRO.trim() };
  if (textoNoVacio(env.UAEH_WSL_USER)) out.wsl = { ...out.wsl, usuario: env.UAEH_WSL_USER.trim() };
  return out;
}

function validar(config, avisos) {
  const c = comun.fusionar(config, {});
  if (!CREDITOS.has(c.commits.credito)) {
    avisos.push(`commits.credito "${c.commits.credito}" no es permitir|prohibir; se usa "permitir".`);
    c.commits = { ...c.commits, credito: 'permitir' };
  }
  if (typeof c.commits.firma !== 'string') {
    avisos.push('commits.firma debe ser texto; se deja vacía.');
    c.commits = { ...c.commits, firma: '' };
  }
  if (!Array.isArray(c.arnes.extra) || !c.arnes.extra.every((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string')) {
    avisos.push('arnes.extra debe ser una lista de [carpeta, patrón, recursivo?]; se ignora.');
    c.arnes = { ...c.arnes, extra: [] };
  } else if (c.arnes.extra.some((e) => !path.isAbsolute(e[0]) || /^~/.test(e[0]))) {
    // Una carpeta relativa se mediría en sitios distintos según el cwd: solo rutas absolutas.
    const malas = c.arnes.extra.filter((e) => !path.isAbsolute(e[0]) || /^~/.test(e[0])).map((e) => e[0]);
    avisos.push(`arnes.extra solo admite carpetas con ruta absoluta; se ignoran: ${malas.join(', ')}.`);
    c.arnes = { ...c.arnes, extra: c.arnes.extra.filter((e) => path.isAbsolute(e[0]) && !/^~/.test(e[0])) };
  }
  if (typeof c.wsl.distro !== 'string' || !/^[A-Za-z0-9._-]+$/.test(c.wsl.distro)) {
    avisos.push(`wsl.distro "${c.wsl.distro}" no es un nombre de distro válido; se usa "${CONFIG_DEFECTO.wsl.distro}".`);
    c.wsl = { ...c.wsl, distro: CONFIG_DEFECTO.wsl.distro };
  }
  if (typeof c.wsl.usuario !== 'string' || (c.wsl.usuario && !/^[a-z_][a-z0-9_-]{0,31}$/.test(c.wsl.usuario)) || c.wsl.usuario === 'root') {
    avisos.push(`wsl.usuario "${c.wsl.usuario}" no es válido (minúsculas, sin root); se deja vacío.`);
    c.wsl = { ...c.wsl, usuario: '' };
  }
  if (typeof c.codex.habilitado !== 'boolean') {
    avisos.push('codex.habilitado debe ser true|false; se usa false.');
    c.codex = { ...c.codex, habilitado: false };
  }
  if (typeof c.codex.consentimiento !== 'string') {
    avisos.push('codex.consentimiento debe ser texto (la fecha del consentimiento); se deja vacío.');
    c.codex = { ...c.codex, consentimiento: '' };
  }
  for (const clave of ['timeoutDiffMin', 'timeoutCompletaMin']) {
    const v = c.codex[clave];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 240) {
      avisos.push(`codex.${clave} debe ser un número de minutos entre 1 y 240; se usa ${CONFIG_DEFECTO.codex[clave]}.`);
      c.codex = { ...c.codex, [clave]: CONFIG_DEFECTO.codex[clave] };
    }
  }
  for (const [seccion, clave] of OBSOLETAS) {
    if (clave == null) { if (seccion in c) delete c[seccion]; continue; }
    if (c[seccion] && typeof c[seccion] === 'object' && clave in c[seccion]) { const copia = { ...c[seccion] }; delete copia[clave]; c[seccion] = copia; }
  }
  const modelos = { ...c.codex.modelos };
  for (const nivel of ['profundo', 'equilibrado', 'rapido']) {
    const m = modelos[nivel];
    const d = CONFIG_DEFECTO.codex.modelos[nivel];
    if (!m || typeof m !== 'object' || !textoNoVacio(m.modelo) || !ESFUERZOS.has(m.esfuerzo)) {
      avisos.push(`codex.modelos.${nivel} incompleto (modelo + esfuerzo low|medium|high|xhigh); se usa ${d.modelo}/${d.esfuerzo}.`);
      modelos[nivel] = { ...d };
    }
  }
  c.codex = { ...c.codex, modelos };
  if (typeof c.datos.runs !== 'string') { avisos.push('datos.runs debe ser texto; se deja vacío.'); c.datos = { ...c.datos, runs: '' }; }
  const catalogo = c.visual && c.visual.catalogo;
  if (typeof catalogo !== 'string' || (catalogo.trim() && (!path.isAbsolute(catalogo.trim()) || /^~/.test(catalogo.trim())))) {
    // Igual que arnes.extra: una ruta relativa apuntaría a sitios distintos según el cwd.
    avisos.push('visual.catalogo debe ser la ruta absoluta de un archivo (o vacío: catalogo-visual.md en la carpeta de estado); se ignora.');
    c.visual = { ...c.visual, catalogo: '' };
  }
  return c;
}

// Ruta del archivo de configuración según un entorno dado (igual que comun.rutaConfig(), pero sin leer process.env:
// sirve para evaluar la configuración de otro entorno sin lanzar un proceso).
function rutaConfigDe(env) {
  if (!env || env === process.env) return comun.rutaConfig();
  const limpio = (v) => (typeof v === 'string' && v.trim() ? path.resolve(v.trim()) : null);
  const casa = limpio(env.USERPROFILE) || limpio(env.HOME) || require('os').homedir();
  const claude = limpio(env.CLAUDE_CONFIG_DIR) || path.join(casa, '.claude');
  const uaeh = limpio(env.UAEH_HOME) || path.join(claude, 'uaeh');
  return path.join(uaeh, 'uaeh.config.json');
}

// Devuelve { config, avisos:[], existe:boolean, ruta }. Nunca lanza.
//   opciones.ruta  otro archivo (pruebas) · opciones.env  otro entorno (por defecto process.env; también decide la ruta)
function cargarConfig(opciones = {}) {
  const env = opciones.env || process.env;
  const base = comun.cargarConfig(opciones.ruta || rutaConfigDe(env));
  const avisos = base.avisos.slice();
  let config = comun.fusionar(CONFIG_DEFECTO, base.config);
  config = aplicarEntorno(config, env, avisos);
  config = validar(config, avisos);
  return { config, avisos, existe: base.existe, ruta: base.ruta };
}

// ── Derivados ─────────────────────────────────────────────────────────────────────────

// Tope en minutos de una corrida del auditor Codex según el modo ('diff' | 'completa'), cuando no se pasa --timeout-min.
function topeCodexMin(config, modo) {
  const clave = modo === 'diff' ? 'timeoutDiffMin' : 'timeoutCompletaMin';
  const v = config && config.codex && config.codex[clave];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 240 ? v : CONFIG_DEFECTO.codex[clave];
}

// Política de commits: { credito: 'permitir'|'prohibir', prohibir: boolean, firma: '' | texto }.
function politicaCommits(config) {
  const c = (config && config.commits) || CONFIG_DEFECTO.commits;
  const credito = CREDITOS.has(c.credito) ? c.credito : 'permitir';
  return { credito, prohibir: credito === 'prohibir', firma: typeof c.firma === 'string' ? c.firma.trim() : '' };
}

// Lista blanca efectiva: { excluir: RegExp[], categorias: [{ clave, nombre, re }] , avisos:[] }.
//   listaBlanca.excluirRutas       nombres de carpeta que no cuentan (se suman a los de defecto)
//   listaBlanca.excluirExtensiones extensiones que no cuentan (se suman)
//   listaBlanca.categorias         { clave: [patrones] } REEMPLAZA los patrones de esa categoría (clave de defecto o nueva)
//   listaBlanca.agregar            { clave: [patrones] } AÑADE patrones a una categoría (de defecto o nueva)
function listaBlanca(config) {
  const avisos = [];
  const lb = (config && config.listaBlanca) || {};
  const rutas = [...EXCLUIR_RUTAS_DEFECTO, ...listaDeTextos(lb.excluirRutas, avisos, 'listaBlanca.excluirRutas')];
  const exts = [...EXCLUIR_EXTENSIONES_DEFECTO, ...listaDeTextos(lb.excluirExtensiones, avisos, 'listaBlanca.excluirExtensiones')];
  const excluir = [
    new RegExp('(^|/)(' + rutas.map(escapar).join('|') + ')/', 'i'),
    new RegExp('\\.(' + exts.map((e) => escapar(e.replace(/^\./, ''))).join('|') + ')$', 'i'),
  ];

  const mapa = new Map(); // clave → { clave, nombre, fuentes:[] }
  for (const [clave, nombre, fuentes] of CATEGORIAS_DEFECTO) mapa.set(clave, { clave, nombre, fuentes: fuentes.slice() });
  const objeto = (v, nombre) => {
    if (v == null) return {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) { avisos.push(`${nombre} debe ser un objeto { categoria: [patrones] }; se ignora.`); return {}; }
    return v;
  };
  for (const [clave, patrones] of Object.entries(objeto(lb.categorias, 'listaBlanca.categorias'))) {
    const fuentes = listaDeTextos(patrones, avisos, `listaBlanca.categorias.${clave}`);
    const previo = mapa.get(clave);
    mapa.set(clave, { clave, nombre: previo ? previo.nombre : clave, fuentes });
  }
  for (const [clave, patrones] of Object.entries(objeto(lb.agregar, 'listaBlanca.agregar'))) {
    const fuentes = listaDeTextos(patrones, avisos, `listaBlanca.agregar.${clave}`);
    const previo = mapa.get(clave) || { clave, nombre: clave, fuentes: [] };
    mapa.set(clave, { ...previo, fuentes: [...previo.fuentes, ...fuentes] });
  }
  const categorias = [];
  for (const { clave, nombre, fuentes } of mapa.values()) {
    const partes = fuentes.map((f) => compilar(f, avisos, `listaBlanca (${clave})`) && `(?:${f})`).filter(Boolean);
    if (!partes.length) continue; // categoría vaciada a propósito o sin patrones válidos
    categorias.push({ clave, nombre, re: new RegExp(partes.join('|'), 'i') });
  }
  return { excluir, categorias, avisos };
}

// Clasifica rutas (relativas al repo) → [{ archivo, categoria }] con el nombre legible de la categoría.
function clasificar(rutas, lista) {
  const l = lista || listaBlanca(cargarConfig().config);
  const hallados = [];
  for (const a of rutas || []) {
    const n = String(a).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    if (!n || l.excluir.some((r) => r.test(n))) continue;
    for (const c of l.categorias) {
      if (c.re.test(n)) { hallados.push({ archivo: a, categoria: c.nombre }); break; }
    }
  }
  return hallados;
}

// Espejo de ruta fija de ESTE plugin: <uaehHome>/estable/uaeh-harness (git-hooks/ y hooks/ hermanas).
function espejoHarness() {
  return path.join(comun.estableDir(), NOMBRE_ESPEJO);
}

// Carpeta de la guarda de git que debe estar en core.hooksPath: UAEH_GIT_HOOKS o <espejo>/git-hooks.
function rutaGitHooks(env = process.env) {
  const v = env.UAEH_GIT_HOOKS;
  return textoNoVacio(v) ? path.resolve(v.trim()) : path.join(espejoHarness(), 'git-hooks');
}

// Modelos de Codex por nivel: { profundo:{modelo,esfuerzo}, equilibrado:{…}, rapido:{…} }.
function modelosCodex(config) {
  const m = (config && config.codex && config.codex.modelos) || {};
  const out = {};
  for (const nivel of ['profundo', 'equilibrado', 'rapido']) out[nivel] = { ...CONFIG_DEFECTO.codex.modelos[nivel], ...(m[nivel] || {}) };
  return out;
}

module.exports = {
  NOMBRE_ESPEJO, CONFIG_DEFECTO, CATEGORIAS_DEFECTO, EXCLUIR_RUTAS_DEFECTO, EXCLUIR_EXTENSIONES_DEFECTO,
  rutaConfigDe, cargarConfig, politicaCommits, listaBlanca, clasificar, espejoHarness, rutaGitHooks, modelosCodex,
  topeCodexMin, OBSOLETAS,
};
