#!/usr/bin/env node
// scripts/doctor-puertas.cjs — diagnóstico de las puertas de la capa 3 del método UAEH (plugin uaeh-harness):
// seguridad (motor de Linux, escáneres, Docker, caja de arena), visual (playwright-cli, navegador, candado del
// verificador de navegador), codex (consentimiento, CLI, sesión, aislamiento) y preflight (huella y sello).
//
// Uso: node doctor-puertas.cjs [--puerta seguridad|visual|codex|preflight]… [--todas] [--rapido] [--vivo] [--json]
//   --puerta  una o varias (repetida o separada por comas); sin --puerta, todas.
//   --rapido  solo lo barato: salta las autopruebas en temporales, el tamaño de las corridas y el catálogo visual.
//             Es la comprobación que hace la puerta de seguridad antes de cada corrida (~5 s con WSL ya despierto).
//   --vivo    además lo caro y real: la prueba de aislamiento de Codex (auditor-codex.cjs --probar-sandbox; consume
//             cuota de Codex, ~2 min) y la autoprueba visual con navegador (probar-visual.cjs --sin-lighthouse, ~2 min).
//   --json    { version, puertas:[{puerta, estado, comprobaciones:[{id, estado, detalle}]}], veredicto, codigo }.
//
// Reglas:
//   · Solo lee. Las autopruebas trabajan en carpetas temporales que se borran. La única escritura es, con --vivo, el
//     resultado de la prueba de Codex en <UAEH_HOME>/cache/doctor-ultimo.json (para recordarlo sin gastar cuota).
//   · Estados de cada comprobación: OK | AVISO | FALLÓ | OMITIDA | NO_INSTALADA | NO_APLICA (OMITIDA = no se midió).
//   · Estado de cada puerta: LISTA (sin FALLÓ ni NO_INSTALADA; puede llevar AVISO) · NO_INSTALADA (falta una pieza:
//     instalar.cjs puertas <puerta>) · NO_LISTA (algo FALLÓ) · APAGADA (Codex sin consentimiento: es opcional).
//   · Veredicto LISTA si todas las puertas pedidas están LISTA o APAGADA. Código: 0 LISTA · 1 NO_LISTA · 2 uso.
//   · Lo que corre en Linux pasa por lib/runner.cjs (WSL en Windows, directo en Linux) con tope de tiempo; nunca root.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const comun = require(path.join(__dirname, 'lib', 'comun.cjs'));
const configLib = require(path.join(__dirname, 'lib', 'config.cjs'));
const runner = require(path.join(__dirname, 'lib', 'runner.cjs'));
const diag = require(path.join(__dirname, 'lib', 'diagnostico.cjs'));

const RAIZ = path.resolve(__dirname, '..');
const PUERTAS = ['seguridad', 'visual', 'codex', 'preflight'];
const ESTADOS_PUERTA = ['LISTA', 'NO_INSTALADA', 'NO_LISTA', 'APAGADA'];
const NODE_MINIMO = 20;
const CODEX_MINIMO = '0.163.0';
const PRESUPUESTO_RUNS_MS = 8000;
const LIBRE_MINIMO_BYTES = 2 * 1024 ** 3;
const SEGUNDOS_ESTADO = 90;
const REFERENCIAS_PREFLIGHT = ['formato', 'checks-por-stack', 'seguridad', 'legal', 'escala'];
const ARCHIVO_ULTIMO = 'doctor-ultimo.json';

// ── Utilidades ────────────────────────────────────────────────────────────────────────────

function primeraLinea(texto) {
  return String(texto || '').replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
}

function lista(items, max = 4) {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} y ${items.length - max} más`;
}

function gb(bytes) { return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }

function temporal(prefijo) { return fs.mkdtempSync(path.join(os.tmpdir(), prefijo)); }

function borrar(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temporal */ } }

// Corre un script de Node del plugin. → { codigo, stdout, stderr, agotado }
function nodeScript(script, args = [], opciones = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: (opciones.segundos || 60) * 1000, windowsHide: true,
    env: opciones.env || process.env, cwd: opciones.cwd || undefined, input: opciones.input == null ? '' : opciones.input,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { codigo: r.status == null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', agotado: !!(r.error && r.error.code === 'ETIMEDOUT') };
}

// `wsl.exe -l -v` escribe en UTF-16LE. → texto o null
function listarWsl() {
  const r = spawnSync('wsl.exe', ['-l', '-v'], { timeout: 20000, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  const buf = r.stdout || Buffer.alloc(0);
  return (buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '');
}

// «NAME STATE VERSION» de `wsl -l -v` → versión de la distro o null.
function versionWslDe(texto, distro) {
  for (const linea of String(texto || '').split(/\r?\n/)) {
    const partes = linea.replace(/^\s*\*/, '').trim().split(/\s+/);
    if (partes.length >= 3 && partes[0].toLowerCase() === String(distro).toLowerCase()) return partes[partes.length - 1];
  }
  return null;
}

// Salida de wsl/estado.sh → { completo, datos: Map(clave → [valores]) }
function parsearEstado(texto) {
  const datos = new Map();
  let completo = false;
  for (const linea of String(texto || '').replace(/\0/g, '').split(/\r?\n/)) {
    if (linea === 'ESTADO_FIN') { completo = true; continue; }
    const m = /^([a-z0-9_]+) (.*)$/.exec(linea);
    if (!m) continue;
    if (!datos.has(m[1])) datos.set(m[1], []);
    datos.get(m[1]).push(m[2]);
  }
  return { completo, datos };
}

// Archivos de una carpeta de vendor/ contra su UPSTREAM.json (sha256 con fines de línea LF). → { ok, malos, total }
function verificarVendor(raiz, nombre) {
  const dir = path.join(raiz, 'vendor', nombre);
  const up = comun.leerJson(path.join(dir, 'UPSTREAM.json'));
  if (!up || !up.archivos || typeof up.archivos !== 'object') return { ok: false, malos: ['UPSTREAM.json ausente o ilegible'], total: 0 };
  const malos = [];
  for (const [rel, info] of Object.entries(up.archivos)) {
    let texto;
    try { texto = fs.readFileSync(path.join(dir, ...rel.split('/')), 'latin1'); } catch { malos.push(`${rel} (falta)`); continue; }
    if (diag.sha256(Buffer.from(texto.replace(/\r\n/g, '\n'), 'latin1')) !== info.sha256) malos.push(`${rel} (cambió)`);
  }
  return { ok: !malos.length, malos, total: Object.keys(up.archivos).length };
}

// ── Contexto ──────────────────────────────────────────────────────────────────────────────

function crearContexto(opciones = {}) {
  const raiz = path.resolve(opciones.raiz || RAIZ);
  const iny = opciones.inyectar || {};
  const cache = new Map();
  const memo = (clave, fn) => { if (!cache.has(clave)) cache.set(clave, fn()); return cache.get(clave); };
  const ctx = {
    raiz,
    rapido: !!opciones.rapido,
    vivo: !!opciones.vivo,
    config: () => memo('config', () => configLib.cargarConfig()),
    plataforma: () => memo('plataforma', () => (iny.plataforma ? iny.plataforma() : runner.plataforma())),
    pines: () => memo('pines', () => comun.leerJson(path.join(raiz, 'wsl', 'herramientas.json')) || {}),
    ejecutarComando: iny.ejecutarComando || diag.ejecutarComando,
    nodeScript: iny.nodeScript || nodeScript,
    listarWsl: iny.listarWsl || listarWsl,
    motor: () => memo('motor', () => (iny.motorListo ? iny.motorListo() : runner.motorListo(ctx.config().config))),
    // Una sola llamada al motor para toda la puerta de seguridad.
    estadoMotor: () => memo('estadoMotor', () => {
      if (!ctx.motor().listo) return null;
      const script = path.join(raiz, 'wsl', 'estado.sh');
      const ruta = runner.aRutaMotor(script, ctx.plataforma().so);
      const r = iny.ejecutarLinux
        ? iny.ejecutarLinux(['bash', ruta], { segundos: SEGUNDOS_ESTADO })
        : runner.ejecutarEnLinux(['bash', ruta], { segundos: SEGUNDOS_ESTADO }, ctx.config().config);
      const p = parsearEstado(r.stdout);
      return { ...p, codigo: r.codigo, agotado: r.agotado, error: primeraLinea(r.stderr) || r.error || '' };
    }),
    dato: (clave) => { const e = ctx.estadoMotor(); return e && e.datos.has(clave) ? e.datos.get(clave)[0] : null; },
    datos: (clave) => { const e = ctx.estadoMotor(); return e && e.datos.has(clave) ? e.datos.get(clave) : []; },
    codex: () => memo('codex', () => {
      try {
        const aud = require(path.join(raiz, 'skills', 'uae-security', 'scripts', 'auditor-codex.cjs'));
        const c = iny.resolverCodex ? iny.resolverCodex() : aud.resolverCodex();
        return { ...c, encontrado: true };
      } catch (e) { return { encontrado: false, motivo: e.message }; }
    }),
    rutaUltimo: () => path.join(comun.cacheDir ? comun.cacheDir() : path.join(comun.uaehHome(), 'cache'), ARCHIVO_ULTIMO),
  };
  return ctx;
}

// Comprobación que depende del estado del motor: sin motor, OMITIDA.
function conMotor(fn) {
  return (ctx) => {
    const e = ctx.estadoMotor();
    if (!e) return { estado: 'OMITIDA', detalle: 'sin motor de Linux: no se pudo medir' };
    if (!e.completo) return { estado: 'FALLÓ', detalle: `wsl/estado.sh no terminó (código ${e.codigo}${e.agotado ? ', tiempo agotado' : ''}${e.error ? `: ${e.error}` : ''})` };
    return fn(ctx);
  };
}

// ── Puerta de seguridad ───────────────────────────────────────────────────────────────────

function segPlataforma(ctx) {
  const p = ctx.plataforma();
  if (p.modo === 'wsl') return { estado: 'OK', detalle: `Windows + WSL2 (distro ${ctx.config().config.wsl.distro})` };
  if (p.modo === 'linux') return { estado: 'OK', detalle: 'Linux nativo' };
  return { estado: 'NO_INSTALADA', detalle: `plataforma ${p.so}: la puerta de seguridad necesita Linux o Windows con WSL2 (las capas 1 y 2 sí funcionan)` };
}

function segMotor(ctx) {
  if (ctx.plataforma().modo === 'no-soportado') return { estado: 'NO_APLICA', detalle: 'plataforma sin motor de Linux' };
  const m = ctx.motor();
  return m.listo
    ? { estado: 'OK', detalle: m.detalle }
    : { estado: 'NO_INSTALADA', detalle: `${m.detalle}; guía: instalar.cjs puertas seguridad` };
}

function segVersionWsl(ctx) {
  if (ctx.plataforma().modo !== 'wsl') return { estado: 'NO_APLICA', detalle: 'solo en Windows' };
  const distro = ctx.config().config.wsl.distro;
  const texto = ctx.listarWsl();
  if (texto == null) return { estado: 'AVISO', detalle: '«wsl -l -v» no respondió' };
  const v = versionWslDe(texto, distro);
  if (v == null) return { estado: 'AVISO', detalle: `la distro ${distro} no aparece en «wsl -l -v» (revisa wsl.distro en uaeh.config.json)` };
  return v === '2'
    ? { estado: 'OK', detalle: `${distro} en WSL 2` }
    : { estado: 'FALLÓ', detalle: `${distro} está en WSL ${v}: Docker necesita WSL 2 (wsl --set-version ${distro} 2)` };
}

const segSistema = conMotor((ctx) => {
  const p = ctx.pines().plataforma || {};
  const arq = ctx.dato('arquitectura');
  const ubuntu = ctx.dato('ubuntu');
  const malos = [];
  if (p.arquitectura && arq !== p.arquitectura) malos.push(`arquitectura ${arq} (los binarios fijados son para ${p.arquitectura})`);
  if (p.ubuntu && ubuntu !== p.ubuntu) malos.push(`Ubuntu «${ubuntu}» (el instalador soporta ${p.ubuntu})`);
  if (!/^Python 3/.test(ctx.dato('python3') || '')) malos.push('sin python3 en Linux (lo usan los instaladores y uaeh-promover)');
  return malos.length
    ? { estado: 'AVISO', detalle: malos.join('; ') }
    : { estado: 'OK', detalle: `Ubuntu ${ubuntu} ${arq} · ${ctx.dato('python3')} · usuario ${ctx.dato('usuario')}` };
});

const segSystemd = conMotor((ctx) => (ctx.dato('pid1') === 'systemd'
  ? { estado: 'OK', detalle: 'systemd es el proceso 1' }
  : { estado: 'AVISO', detalle: `el proceso 1 es «${ctx.dato('pid1')}»: el Docker que instala el instalador necesita systemd ([boot] systemd=true en /etc/wsl.conf y wsl --shutdown)` }));

const segEscaneres = conMotor((ctx) => {
  const p = ctx.pines();
  const piezas = [['gitleaks', 'gitleaks', p.gitleaks], ['osv-scanner', 'osv', p['osv-scanner']], ['semgrep', 'semgrep', p.semgrep]];
  const faltan = []; const distintas = []; const vistas = [];
  for (const [nombre, clave, pin] of piezas) {
    const v = diag.versionDe(ctx.dato(clave));
    if (!v) { faltan.push(nombre); continue; }
    vistas.push(`${nombre} ${v}`);
    if (pin && pin.version && v !== pin.version) distintas.push(`${nombre} ${v} (pin ${pin.version})`);
  }
  if (faltan.length) return { estado: 'NO_INSTALADA', detalle: `falta ${faltan.join(', ')}: instalar.cjs puertas seguridad --aplicar` };
  if (distintas.length) return { estado: 'AVISO', detalle: `versión distinta del pin: ${distintas.join(', ')} (instalar.cjs puertas seguridad --reparar --aplicar)` };
  return { estado: 'OK', detalle: `${vistas.join(' · ')} (= pines)` };
});

const segReglas = conMotor((ctx) => {
  const r = ctx.dato('reglas_semgrep');
  return !r || r === 'no'
    ? { estado: 'NO_INSTALADA', detalle: 'sin reglas de semgrep fijadas en /opt/uaeh/reglas: instalar.cjs puertas seguridad --aplicar' }
    : { estado: 'OK', detalle: `reglas de semgrep del ${path.posix.basename(r)}` };
});

const segDocker = conMotor((ctx) => {
  const d = ctx.dato('docker') || 'no';
  if (/^no: falta el programa/.test(d)) return { estado: 'NO_INSTALADA', detalle: 'sin Docker en Linux: instalar.cjs puertas seguridad --aplicar' };
  if (/^no/.test(d)) {
    const grupo = ctx.dato('grupo_docker') === 'si' ? '' : `; el usuario ${ctx.dato('usuario')} no está en el grupo docker (tras instalar: wsl --terminate <distro>)`;
    return { estado: 'FALLÓ', detalle: `Docker no responde como ${ctx.dato('usuario')}: ${d.replace(/^no:?\s*/, '') || 'sin detalle'}${grupo}. Sin caja de arena nada se confirma (todo quedaría UNKNOWN)` };
  }
  return { estado: 'OK', detalle: `Docker ${d} responde como ${ctx.dato('usuario')}` };
});

const segImagenes = conMotor((ctx) => {
  if (!/^\d/.test(ctx.dato('docker') || '')) return { estado: 'OMITIDA', detalle: 'Docker no responde: no se pudieron listar las imágenes' };
  const locales = new Set(ctx.datos('imagen'));
  const faltan = [];
  for (const [nombre, img] of Object.entries(ctx.pines().imagenes || {})) {
    const repo = String(img.etiqueta || nombre).split(':')[0];
    if (!locales.has(`${repo}@${img.digest}`)) faltan.push(img.etiqueta || nombre);
  }
  return faltan.length
    ? { estado: 'NO_INSTALADA', detalle: `faltan imágenes fijadas por digest: ${faltan.join(', ')} (instalar.cjs puertas seguridad --reparar --aplicar)` }
    : { estado: 'OK', detalle: `${Object.keys(ctx.pines().imagenes || {}).length} imágenes fijadas presentes` };
});

// Líneas «archivo <rel> igual|distinto|falta|sin-origen [dueño:grupo modo]» de estado.sh.
function archivosMotor(ctx, filtro) {
  return ctx.datos('archivo').map((l) => {
    const [rel, estado, permisos, modo] = l.split(' ');
    return { rel, estado, permisos, modo };
  }).filter((a) => filtro(a.rel));
}

const segProgramas = conMotor((ctx) => {
  const archivos = archivosMotor(ctx, (rel) => /^(bin|contenedor|pruebas)\//.test(rel));
  if (!archivos.length) return { estado: 'FALLÓ', detalle: 'estado.sh no informó ningún programa (¿plugin incompleto?)' };
  const faltan = archivos.filter((a) => a.estado === 'falta').map((a) => a.rel);
  const inseguros = archivos.filter((a) => a.estado !== 'falta' && (a.permisos !== 'root:root' || (/^bin\//.test(a.rel) ? a.modo !== '755' : !/^[0-7]?[0-7][0-5][0-5]$/.test(a.modo || ''))))
    .map((a) => `${a.rel} (${a.permisos} ${a.modo})`);
  const distintos = archivos.filter((a) => a.estado === 'distinto').map((a) => a.rel);
  if (faltan.length) return { estado: 'NO_INSTALADA', detalle: `faltan en /opt/uaeh: ${lista(faltan)} (instalar.cjs puertas seguridad --aplicar)` };
  if (inseguros.length) return { estado: 'FALLÓ', detalle: `permisos inseguros (deben ser de root y no escribibles por otros): ${lista(inseguros)}` };
  if (distintos.length) return { estado: 'AVISO', detalle: `desactualizados frente a este plugin: ${lista(distintos)} (instalar.cjs puertas seguridad --actualizar --aplicar)` };
  const enlace = ctx.dato('enlace_sandbox') === 'si' ? '' : '; falta el enlace /usr/local/bin/uaeh-sandbox';
  return { estado: enlace ? 'AVISO' : 'OK', detalle: `${archivos.length} programas de /opt/uaeh iguales al plugin, de root${enlace}` };
});

const segValidadores = conMotor((ctx) => {
  const archivos = archivosMotor(ctx, (rel) => /^validadores\//.test(rel));
  if (!archivos.length) return { estado: 'AVISO', detalle: 'estado.sh no informó validadores' };
  const sinOrigen = archivos.filter((a) => a.estado === 'sin-origen').map((a) => a.rel);
  const faltan = archivos.filter((a) => a.estado === 'falta').map((a) => a.rel);
  const distintos = archivos.filter((a) => a.estado === 'distinto').map((a) => a.rel);
  if (sinOrigen.length) return { estado: 'AVISO', detalle: `el plugin no trae: ${lista(sinOrigen)}` };
  if (faltan.length) return { estado: 'NO_INSTALADA', detalle: `faltan validadores: ${lista(faltan)} (instalar.cjs puertas seguridad --aplicar)` };
  if (distintos.length) return { estado: 'AVISO', detalle: `validadores desactualizados: ${lista(distintos)} (instalar.cjs puertas seguridad --actualizar --aplicar)` };
  return { estado: 'OK', detalle: `${archivos.length} validadores iguales a vendor/security-audit` };
});

function rutaRunsMotor(ctx) {
  const uaehConfig = require(path.join(ctx.raiz, 'scripts', 'uaeh-config.cjs'));
  const base = uaehConfig.runsDir({ config: ctx.config().config });
  return { base, motor: runner.aRutaMotor(base, ctx.plataforma().so) };
}

const segConf = conMotor((ctx) => {
  if (ctx.dato('conf') !== 'si') return { estado: 'NO_INSTALADA', detalle: 'sin /opt/uaeh/uaeh.conf: instalar.cjs puertas seguridad --aplicar' };
  const { motor } = rutaRunsMotor(ctx);
  const base = ctx.dato('conf_base');
  const usuario = ctx.dato('conf_usuario');
  const malos = [];
  if (base !== motor) malos.push(`la caja de arena solo acepta corridas bajo ${base} y la puerta las escribe en ${motor}`);
  if (usuario !== ctx.dato('usuario')) malos.push(`uaeh.conf es del usuario ${usuario} y la puerta corre como ${ctx.dato('usuario')} (wsl.usuario)`);
  const instalado = ctx.dato('instalado') === 'si' ? '' : ' · sin /opt/uaeh/instalado.json (instalado a mano o con un instalador viejo)';
  return malos.length
    ? { estado: 'FALLÓ', detalle: `${malos.join('; ')}: instalar.cjs puertas seguridad --actualizar --aplicar` }
    : { estado: instalado ? 'AVISO' : 'OK', detalle: `uaeh.conf: corridas en ${base}, usuario ${usuario}${instalado}` };
});

function segPythonHost(ctx) {
  const py = ctx.ejecutarComando === diag.ejecutarComando ? runner.comandoPython() : (ctx.ejecutarComando('python3', ['--version']).codigo === 0 ? 'python3' : null);
  return py
    ? { estado: 'OK', detalle: `Python 3 en este equipo (${py}): lo usa cyber-neo en la pasada determinista` }
    : { estado: 'NO_INSTALADA', detalle: 'sin Python 3 en este equipo (python3, python o py): la pasada determinista no puede correr cyber-neo' };
}

function segParche(ctx) {
  const r = ctx.nodeScript(path.join(ctx.raiz, 'scripts', 'aplicar-parche-cyber-neo.cjs'), ['--verificar'], { segundos: 60 });
  if (r.codigo === 0) return { estado: 'OK', detalle: 'cyber-neo del plugin íntegro y parchado (no imprime secretos)' };
  return { estado: 'FALLÓ', detalle: `cyber-neo del plugin ${r.codigo === 3 ? 'SIN el parche que redacta secretos' : 'alterado (DESCONOCIDO)'}: ${primeraLinea(r.stdout) || primeraLinea(r.stderr)}` };
}

function segVendor(ctx) {
  const v = verificarVendor(ctx.raiz, 'security-audit');
  return v.ok
    ? { estado: 'OK', detalle: `vendor/security-audit: ${v.total} archivos iguales a su origen` }
    : { estado: 'FALLÓ', detalle: `vendor/security-audit alterado: ${lista(v.malos)}` };
}

function segRuns(ctx) {
  if (ctx.rapido) return { estado: 'OMITIDA', detalle: 'se mide sin --rapido' };
  const { base } = rutaRunsMotor(ctx);
  if (!fs.existsSync(base)) return { estado: 'OK', detalle: `aún no hay corridas (${base})` };
  const notas = [];
  let estado = 'OK';
  try { fs.accessSync(base, fs.constants.W_OK); } catch { return { estado: 'FALLÓ', detalle: `la carpeta de corridas no es escribible: ${base}` }; }
  try {
    const st = fs.statfsSync(base);
    const libre = Number(st.bavail) * Number(st.bsize);
    notas.push(`${gb(libre)} libres`);
    if (libre < LIBRE_MINIMO_BYTES) estado = 'AVISO';
  } catch { /* statfs no disponible */ }
  let runs = null;
  try { runs = require(path.join(ctx.raiz, 'scripts', 'uaeh-runs.cjs')); } catch { runs = null; }
  if (runs && typeof runs.inventario === 'function') {
    const ret = ctx.config().config.datos.retencion || {};
    const inv = runs.inventario(base, { presupuestoMs: PRESUPUESTO_RUNS_MS, retencion: ret });
    const n = (inv.repos || []).reduce((s, r) => s + (r.runs || []).length, 0);
    notas.unshift(`${n} corridas en ${(inv.repos || []).length} repos, ${inv.cortado ? '≥ ' : ''}${gb(inv.bytes || 0)}`);
    if ((inv.bytes || 0) > (Number(ret.avisoGB) || 5) * 1024 ** 3) {
      estado = 'AVISO';
      notas.push(`más de ${ret.avisoGB || 5} GB: uaeh-runs.cjs limpiar (en seco primero)`);
    }
  }
  return { estado, detalle: `${base}: ${notas.join(' · ')}` };
}

// ── Puerta visual ─────────────────────────────────────────────────────────────────────────

function visNode() {
  const v = process.versions.node;
  return Number(v.split('.')[0]) >= NODE_MINIMO ? { estado: 'OK', detalle: `Node ${v}` } : { estado: 'FALLÓ', detalle: `Node ${v}: se necesita ${NODE_MINIMO} o superior` };
}

function visPlaywrightCli(ctx) {
  const pin = (ctx.pines().visual || {})['@playwright/cli'];
  const r = ctx.ejecutarComando('playwright-cli', ['--version'], { shellWin: true, segundos: 30 });
  if (!r.encontrado || r.codigo !== 0) {
    return { estado: 'NO_INSTALADA', detalle: `sin playwright-cli en el PATH: npm i -g @playwright/cli@${pin} --ignore-scripts (instalar.cjs puertas visual --aplicar)` };
  }
  const v = diag.versionDe(r.stdout + r.stderr);
  if (pin && v !== pin) return { estado: 'AVISO', detalle: `playwright-cli ${v || '?'}: la puerta está probada con ${pin} (instalar.cjs puertas visual --aplicar)` };
  return { estado: 'OK', detalle: `playwright-cli ${v}` };
}

// La configuración de confianza del verificador pide el canal «chrome»: Google Chrome instalado.
function rutasChrome(env = process.env, so = process.platform) {
  if (so === 'win32') {
    return [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)
      .map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (so === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
}

function visChrome(ctx) {
  const plantilla = comun.leerJson(path.join(ctx.raiz, 'templates', 'playwright-cli.config.json')) || {};
  const canal = (((plantilla.browser || {}).launchOptions) || {}).channel || 'chrome';
  if (canal !== 'chrome') return { estado: 'NO_APLICA', detalle: `la configuración de confianza usa el canal «${canal}»` };
  const hallada = rutasChrome().find((r) => fs.existsSync(r));
  return hallada
    ? { estado: 'OK', detalle: `Google Chrome (${hallada})` }
    : { estado: 'NO_INSTALADA', detalle: 'sin Google Chrome: el verificador de navegador abre las pantallas con el canal «chrome»; instálalo desde google.com/chrome' };
}

function visConfigGlobal() {
  const malos = [];
  if (fs.existsSync(path.join(os.homedir(), '.playwright', 'cli.config.json'))) malos.push('existe ~/.playwright/cli.config.json');
  for (const k of Object.keys(process.env)) if (/^PLAYWRIGHT_MCP_/i.test(k) || /^PWTEST_CLI_GLOBAL_CONFIG$/i.test(k)) malos.push(`variable ${k}`);
  return malos.length
    ? { estado: 'FALLÓ', detalle: `${malos.join('; ')}: se fusionaría con la configuración de confianza y el candado del verificador niega «open» mientras exista (muévela o quítala)` }
    : { estado: 'OK', detalle: 'sin configuración global de playwright-cli que se mezcle con la de confianza' };
}

function correrCandado(ctx, hook, agente, comando) {
  const evento = { tool_name: 'Bash', tool_input: { command: comando }, cwd: ctx.raiz, session_id: 'doctor-puertas-0123456789', hook_event_name: 'PreToolUse' };
  if (agente) { evento.agent_type = agente; evento.agent_id = 'doctor-puertas-1'; }
  const r = ctx.nodeScript(hook, [], { input: JSON.stringify(evento), segundos: 30 });
  let negado = false;
  try { negado = JSON.parse(r.stdout || '{}').hookSpecificOutput.permissionDecision === 'deny'; } catch { negado = false; }
  return { negado, codigo: r.codigo };
}

function visCandado(ctx) {
  if (ctx.rapido) return { estado: 'OMITIDA', detalle: 'se prueba sin --rapido' };
  const hook = path.join(ctx.raiz, 'hooks', 'solo-navegador.js');
  if (!fs.existsSync(hook)) return { estado: 'FALLÓ', detalle: 'falta hooks/solo-navegador.js en el plugin' };
  const sesion = '-s=uaeh-doctor-20260101-0000';
  const agente = 'uaeh-harness:browser-verifier';
  const clic = correrCandado(ctx, hook, agente, `playwright-cli ${sesion} click e1`);
  const foto = correrCandado(ctx, hook, agente, `playwright-cli ${sesion} snapshot`);
  const principal = correrCandado(ctx, hook, null, `playwright-cli ${sesion} click e1`);
  const malos = [];
  if (!clic.negado) malos.push('dejó pasar un «click» del verificador de navegador');
  if (foto.negado) malos.push('negó un «snapshot» del verificador');
  if (principal.negado) malos.push('negó un comando de la sesión principal (el candado solo aplica al verificador)');
  return malos.length
    ? { estado: 'FALLÓ', detalle: `candado del verificador de navegador: ${malos.join('; ')}` }
    : { estado: 'OK', detalle: 'candado del verificador de navegador: niega «click», deja «snapshot», no toca la sesión principal' };
}

function visGuias(ctx) {
  const v = verificarVendor(ctx.raiz, 'web-interface-guidelines');
  return v.ok
    ? { estado: 'OK', detalle: `guías de interfaz fijadas: ${v.total} archivos iguales a su origen` }
    : { estado: 'FALLÓ', detalle: `vendor/web-interface-guidelines alterado: ${lista(v.malos)}` };
}

function visCatalogo(ctx) {
  if (ctx.rapido) return { estado: 'OMITIDA', detalle: 'se revisa sin --rapido' };
  const r = ctx.nodeScript(path.join(ctx.raiz, 'skills', 'uae-visual', 'scripts', 'comprobar-catalogo.cjs'), ['--json'], { segundos: 60 });
  let datos = null;
  try { datos = JSON.parse(r.stdout); } catch { datos = null; }
  const ruta = datos && datos.catalogo ? datos.catalogo : 'catálogo vigente';
  if (r.codigo === 0) return { estado: 'OK', detalle: `catálogo coherente con las skills instaladas (${ruta})` };
  const errores = datos && Array.isArray(datos.errores) ? datos.errores.map((e) => (typeof e === 'string' ? e : e.mensaje || JSON.stringify(e))) : [primeraLinea(r.stdout) || primeraLinea(r.stderr)];
  return { estado: 'AVISO', detalle: `catálogo con ${errores.length} problema(s): ${lista(errores, 2)} (comprobar-catalogo.cjs)` };
}

function visAutoprueba(ctx) {
  const script = path.join(ctx.raiz, 'skills', 'uae-visual', 'pruebas', 'probar-visual.cjs');
  if (!fs.existsSync(script)) return { estado: 'FALLÓ', detalle: 'falta la autoprueba visual en el plugin' };
  if (!ctx.vivo) {
    let faltan = null;
    try {
      const pv = require(script);
      faltan = pv.faltantes(path.join(comun.uaehHome(), 'cache', 'visual-fixture', 'node_modules'));
    } catch { faltan = null; }
    if (faltan && faltan.length) return { estado: 'AVISO', detalle: `la autoprueba no podrá correr: faltan ${lista(faltan)} en la caché (instalar.cjs puertas visual --aplicar)` };
    return { estado: 'OMITIDA', detalle: 'dependencias de la autoprueba listas; con --vivo corre contra un navegador real (~2 min)' };
  }
  const r = ctx.nodeScript(script, ['--sin-lighthouse'], { segundos: 900 });
  if (r.codigo === 0) return { estado: 'OK', detalle: 'autoprueba visual con navegador real: sitio malo detectado, sitio bueno aprobado' };
  if (r.codigo === 3) return { estado: 'AVISO', detalle: `autoprueba sin dependencias o sin navegador (no se probó nada): ${primeraLinea(r.stdout)}` };
  return { estado: 'FALLÓ', detalle: `autoprueba visual falló (código ${r.codigo}${r.agotado ? ', tiempo agotado' : ''}): ${primeraLinea(r.stdout.split('\n').reverse().join('\n'))}` };
}

// ── Puerta de Codex ───────────────────────────────────────────────────────────────────────

function codexApagado(ctx) { return ctx.config().config.codex.habilitado !== true; }

function cdxConsentimiento(ctx) {
  const c = ctx.config().config.codex;
  if (c.habilitado !== true) {
    return { estado: 'NO_APLICA', detalle: 'apagado (codex.habilitado=false): no se envía código a OpenAI. Para usarlo: instalar.cjs puertas codex --consiento --aplicar' };
  }
  return { estado: 'OK', detalle: `habilitado${c.consentimiento ? ` (consentimiento del ${c.consentimiento})` : ''}: la copia limpia de cada repo auditado va a OpenAI; tope ${c.timeoutDiffMin} min en diff y ${c.timeoutCompletaMin} min en completa` };
}

function siCodex(fn) {
  return (ctx) => (codexApagado(ctx) ? { estado: 'NO_APLICA', detalle: 'Codex apagado' } : fn(ctx));
}

function versionCodex(ctx) {
  const c = ctx.codex();
  if (!c.encontrado) return null;
  const r = ctx.nodeScript(c.prefijo[0], ['--version'], { segundos: 30 });
  return diag.versionDe(r.stdout + r.stderr);
}

const cdxCli = siCodex((ctx) => {
  const c = ctx.codex();
  if (!c.encontrado) return { estado: 'NO_INSTALADA', detalle: 'sin Codex CLI: npm i -g @openai/codex (y codex login en tu terminal)' };
  const v = versionCodex(ctx);
  if (!v) return { estado: 'AVISO', detalle: `Codex en ${c.origen}, sin versión legible` };
  return diag.compararVersion(v, CODEX_MINIMO) < 0
    ? { estado: 'AVISO', detalle: `Codex ${v}: el aislamiento está medido con ${CODEX_MINIMO} o superior (npm i -g @openai/codex)` }
    : { estado: 'OK', detalle: `Codex ${v}` };
});

const cdxSesion = siCodex((ctx) => {
  const c = ctx.codex();
  if (!c.encontrado) return { estado: 'OMITIDA', detalle: 'sin Codex CLI' };
  const r = ctx.nodeScript(c.prefijo[0], ['login', 'status'], { segundos: 30 });
  // Solo el código: la salida puede mostrar parte de una llave.
  return r.codigo === 0
    ? { estado: 'OK', detalle: 'sesión de Codex iniciada' }
    : { estado: 'FALLÓ', detalle: 'sin sesión de Codex: corre «codex login» en tu terminal' };
});

const cdxModelos = siCodex((ctx) => {
  const avisos = ctx.config().avisos.filter((a) => /^codex\./.test(a));
  const m = configLib.modelosCodex(ctx.config().config);
  const texto = ['profundo', 'equilibrado', 'rapido'].map((n) => `${n} ${m[n].modelo}/${m[n].esfuerzo}`).join(' · ');
  return avisos.length ? { estado: 'AVISO', detalle: `${avisos.join(' ')} → ${texto}` } : { estado: 'OK', detalle: texto };
});

const cdxAgentsMd = siCodex((ctx) => {
  const texto = comun.leerTexto(path.join(comun.codexHome(), 'AGENTS.md'));
  const m = texto && /<!--\s*UAEH:BEGIN(?:\s+v([^\s>]*))?\s*-->/.exec(texto);
  if (!m) return { estado: 'NO_APLICA', detalle: 'sin bloque UAEH en AGENTS.md de Codex (solo hace falta si Codex construye en la modalidad UAEH: instalar.cjs codex)' };
  const version = comun.versionPlugin();
  return m[1] === version
    ? { estado: 'OK', detalle: `bloque UAEH v${version} en AGENTS.md de Codex` }
    : { estado: 'AVISO', detalle: `bloque UAEH ${m[1] ? `v${m[1]}` : 'sin versión'} en AGENTS.md de Codex y el plugin es v${version}: instalar.cjs codex --aplicar` };
});

const cdxSandbox = siCodex((ctx) => {
  const c = ctx.codex();
  if (!c.encontrado) return { estado: 'OMITIDA', detalle: 'sin Codex CLI' };
  const v = versionCodex(ctx);
  const archivo = ctx.rutaUltimo();
  if (ctx.vivo) {
    // Tope: hasta 3 corridas de Codex de 6 min cada una en Windows (variante sin aislamiento + la decisiva con un reintento).
    const r = ctx.nodeScript(path.join(ctx.raiz, 'skills', 'uae-security', 'scripts', 'auditor-codex.cjs'), ['--probar-sandbox'], { segundos: 1500 });
    const ok = /^SANDBOX_OK$/m.test(r.stdout);
    // En Windows la primera variante (sin aislamiento) falla a propósito: el detalle lleva TODAS las líneas de variante.
    const variantes = String(r.stdout || '').replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('Variante ['));
    const previo = comun.leerJson(archivo) || {};
    try { comun.escribirJson(archivo, { ...previo, codex: { sandbox: ok ? 'SANDBOX_OK' : 'SANDBOX_FALLA', version: v, fecha: comun.isoZona(comun.ahora()) } }); } catch { /* sin caché: solo se pierde el recuerdo */ }
    return ok
      ? { estado: 'OK', detalle: `aislamiento probado ahora: Codex ${v} lee y no puede escribir (SANDBOX_OK)` }
      : { estado: 'FALLÓ', detalle: `la prueba de aislamiento NO dio SANDBOX_OK${r.agotado ? ' (tope de tiempo vencido)' : ''}: ${variantes.join(' · ') || primeraLinea(r.stdout) || primeraLinea(r.stderr) || `código ${r.codigo}`} (el auditor Codex queda UNKNOWN)` };
  }
  const u = (comun.leerJson(archivo) || {}).codex;
  if (!u) return { estado: 'AVISO', detalle: 'el aislamiento de Codex nunca se probó en esta máquina: doctor-puertas --puerta codex --vivo (consume cuota, ~2 min)' };
  if (u.sandbox !== 'SANDBOX_OK') return { estado: 'FALLÓ', detalle: `la última prueba de aislamiento (${u.fecha}) NO dio SANDBOX_OK: repítela con --vivo` };
  if (u.version !== v) return { estado: 'AVISO', detalle: `Codex cambió (${u.version} → ${v}) desde la última prueba de aislamiento: repítela con --vivo` };
  return { estado: 'OK', detalle: `último SANDBOX_OK el ${u.fecha} con Codex ${u.version}` };
});

// ── Puerta de preflight ───────────────────────────────────────────────────────────────────

function preSkill(ctx) {
  const faltan = [path.join('skills', 'uae-preflight', 'SKILL.md'), ...REFERENCIAS_PREFLIGHT.map((r) => path.join('skills', 'uae-preflight', 'referencias', `${r}.md`))]
    .filter((rel) => !fs.existsSync(path.join(ctx.raiz, rel)));
  return faltan.length
    ? { estado: 'FALLÓ', detalle: `faltan en el plugin: ${lista(faltan)}` }
    : { estado: 'OK', detalle: `skill uae-preflight con sus ${REFERENCIAS_PREFLIGHT.length} referencias` };
}

function prePlantillas(ctx) {
  const faltan = ['verify.ps1', 'verify.sh'].filter((n) => !fs.existsSync(path.join(ctx.raiz, 'templates', n)));
  return faltan.length ? { estado: 'FALLÓ', detalle: `faltan plantillas: ${faltan.join(', ')}` } : { estado: 'OK', detalle: 'plantillas verify.ps1 y verify.sh' };
}

function preJurisdiccion(ctx) {
  const j = String((ctx.config().config.preflight || {}).jurisdiccion || '').trim();
  return { estado: 'OK', detalle: j ? `jurisdicción: ${j}` : 'sin jurisdicción: la parte legal queda genérica (preflight.jurisdiccion en uaeh.config.json)' };
}

// Autoprueba de la huella y el sello en un repo temporal con una casa temporal (no toca los sellos reales).
function preHuella(ctx) {
  if (ctx.rapido) return { estado: 'OMITIDA', detalle: 'se prueba sin --rapido' };
  const script = path.join(ctx.raiz, 'scripts', 'uaeh-huella.cjs');
  if (!fs.existsSync(script)) return { estado: 'FALLÓ', detalle: 'falta scripts/uaeh-huella.cjs' };
  const tmp = temporal('uaeh-doctor-huella-');
  try {
    const casa = path.join(tmp, 'casa');
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(casa, '.claude'), { recursive: true });
    fs.mkdirSync(repo);
    const gitconfig = path.join(tmp, 'gitconfig');
    fs.writeFileSync(gitconfig, '[user]\n\tname = Doctor UAEH\n\temail = doctor@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
    const env = { ...process.env, HOME: casa, USERPROFILE: casa, CLAUDE_CONFIG_DIR: path.join(casa, '.claude'), UAEH_HOME: path.join(casa, '.claude', 'uaeh'), GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
    for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) delete env[k];
    const git = (args) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (git(['init', '-q']).status !== 0) return { estado: 'OMITIDA', detalle: 'sin git: no se pudo armar el repo de prueba' };
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"doctor","version":"1.0.0"}\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'inicio']);
    const correr = (args) => ctx.nodeScript(script, args, { env, segundos: 60 });
    const s = correr(['sellar', repo, '--tipo', 'completa', '--riesgo', 'medio']);
    const vigente = correr(['comparar', repo]);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"doctor","version":"1.0.1","dependencies":{"x":"1.0.0"}}\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'cambio']);
    const cambio = correr(['comparar', repo]);
    const malos = [];
    if (s.codigo !== 0) malos.push(`sellar salió con ${s.codigo} (${primeraLinea(s.stderr)})`);
    if (!/vigente/.test(vigente.stdout)) malos.push(`recién sellado no dijo «vigente» (${primeraLinea(vigente.stdout) || primeraLinea(vigente.stderr)})`);
    if (!/cambió[^.]*manifiestos/.test(cambio.stdout)) malos.push(`tras cambiar package.json no dijo «cambió manifiestos» (${primeraLinea(cambio.stdout) || primeraLinea(cambio.stderr)})`);
    return malos.length
      ? { estado: 'FALLÓ', detalle: `huella y sello: ${malos.join('; ')}` }
      : { estado: 'OK', detalle: 'huella y sello: sellar → vigente; cambiar un manifiesto → incremental de lo cambiado' };
  } finally { borrar(tmp); }
}

// ── Registro de puertas ───────────────────────────────────────────────────────────────────

const COMPROBACIONES = {
  seguridad: [
    ['plataforma', segPlataforma], ['motor', segMotor], ['wsl-version', segVersionWsl], ['sistema', segSistema],
    ['systemd', segSystemd], ['escaneres', segEscaneres], ['reglas-semgrep', segReglas], ['docker', segDocker],
    ['imagenes', segImagenes], ['programas', segProgramas], ['validadores', segValidadores], ['uaeh-conf', segConf],
    ['python', segPythonHost], ['parche-cyber-neo', segParche], ['vendor', segVendor], ['corridas', segRuns],
  ],
  visual: [
    ['node', visNode], ['playwright-cli', visPlaywrightCli], ['chrome', visChrome], ['config-global', visConfigGlobal],
    ['candado-navegador', visCandado], ['guias', visGuias], ['catalogo', visCatalogo], ['autoprueba', visAutoprueba],
  ],
  codex: [
    ['consentimiento', cdxConsentimiento], ['cli', cdxCli], ['sesion', cdxSesion], ['modelos', cdxModelos],
    ['agents-md', cdxAgentsMd], ['aislamiento', cdxSandbox],
  ],
  preflight: [
    ['skill', preSkill], ['plantillas', prePlantillas], ['huella', preHuella], ['jurisdiccion', preJurisdiccion],
  ],
};

function estadoPuerta(puerta, comprobaciones, ctx) {
  if (puerta === 'codex' && codexApagado(ctx)) return 'APAGADA';
  if (comprobaciones.some((c) => c.estado === 'FALLÓ')) return 'NO_LISTA';
  if (comprobaciones.some((c) => c.estado === 'NO_INSTALADA')) return 'NO_INSTALADA';
  return 'LISTA';
}

function ejecutar(opciones = {}) {
  const ctx = crearContexto(opciones);
  const pedidas = opciones.puertas && opciones.puertas.length ? opciones.puertas : PUERTAS;
  const puertas = pedidas.map((puerta) => {
    const comprobaciones = diag.correrComprobaciones(COMPROBACIONES[puerta], ctx);
    return { puerta, estado: estadoPuerta(puerta, comprobaciones, ctx), comprobaciones, resumen: diag.resumir(comprobaciones) };
  });
  const lista = puertas.every((p) => p.estado === 'LISTA' || p.estado === 'APAGADA');
  return { version: comun.versionPlugin(), rapido: ctx.rapido, vivo: ctx.vivo, puertas, veredicto: lista ? 'LISTA' : 'NO_LISTA', codigo: lista ? 0 : 1 };
}

function formatearHumano(informe) {
  const modo = [informe.rapido ? '--rapido' : null, informe.vivo ? '--vivo' : null].filter(Boolean).join(' ');
  const lineas = [`doctor-puertas (uaeh-harness v${informe.version}${modo ? ` · ${modo}` : ''})`];
  for (const p of informe.puertas) {
    lineas.push('', `== ${p.puerta}: ${p.estado}`, ...diag.formatearComprobaciones(p.comprobaciones, '  '));
  }
  lineas.push('', `Veredicto: ${informe.veredicto} (${informe.puertas.map((p) => `${p.puerta} ${p.estado}`).join(' · ')})`);
  if (informe.veredicto !== 'LISTA') lineas.push('Para instalar o reparar lo que falta: node instalar.cjs puertas <puerta> (en seco; luego --aplicar)');
  return lineas.join('\n');
}

function uso() {
  return [
    'Uso: node doctor-puertas.cjs [--puerta seguridad|visual|codex|preflight]… [--todas] [--rapido] [--vivo] [--json]',
    '  --puerta  una o varias (repetida o separada por comas); sin --puerta, todas',
    '  --rapido  solo lo barato (sin autopruebas, tamaño de corridas ni catálogo)',
    '  --vivo    además la prueba de aislamiento de Codex (consume cuota) y la autoprueba visual con navegador',
    '  --json    salida de máquina',
  ].join('\n');
}

// → { error } | { ayuda:true } | { opciones }
function parsearArgumentos(argv) {
  const opciones = { puertas: [], rapido: false, vivo: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--ayuda', '--help', '-h'].includes(a)) return { ayuda: true };
    if (a === '--json') opciones.json = true;
    else if (a === '--rapido') opciones.rapido = true;
    else if (a === '--vivo') opciones.vivo = true;
    else if (a === '--todas') opciones.puertas.push(...PUERTAS);
    else if (a === '--puerta') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: 'falta el valor de --puerta' };
      for (const p of v.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!PUERTAS.includes(p)) return { error: `puerta desconocida: ${p} (usa ${PUERTAS.join(', ')})` };
        opciones.puertas.push(p);
      }
    } else return { error: `argumento desconocido: ${a}` };
  }
  if (opciones.rapido && opciones.vivo) return { error: '--rapido y --vivo no van juntas' };
  opciones.puertas = [...new Set(opciones.puertas)];
  return { opciones };
}

function main(argv) {
  const r = parsearArgumentos(argv);
  if (r.ayuda) { console.log(uso()); return 0; }
  if (r.error) { console.error(`doctor-puertas: ${r.error}`); console.error(uso()); return 2; }
  const informe = ejecutar(r.opciones);
  console.log(r.opciones.json ? JSON.stringify(informe, null, 2) : formatearHumano(informe));
  return informe.codigo;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  PUERTAS, ESTADOS_PUERTA, COMPROBACIONES, CODEX_MINIMO,
  main, ejecutar, parsearArgumentos, formatearHumano, uso, crearContexto, estadoPuerta,
  parsearEstado, versionWslDe, verificarVendor, rutasChrome,
};
