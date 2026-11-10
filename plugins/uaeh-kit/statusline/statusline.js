#!/usr/bin/env node
// statusline.js — barra de estado de Claude Code para el kit UAEH.
//
// Claude Code ejecuta este script cada vez que la sesión cambia y le pasa por stdin un JSON (modelo,
// carpeta, ventana de contexto, límites de uso, duración…). Imprime UNA línea con color ANSI:
//
//   ● Claude: API │ Opus 5.5 · high │ 5h 20% → 3h 25m │ sesión 2m │ 7d 70% → 2d 3h 5m │ ████░░░░ 60% libre (400k/1M) │ 📁 proyecto
//
// Reglas de diseño:
//   · Nunca se congela ni truena. La lectura de stdin tiene tope de espera, cada segmento se calcula
//     en su propio try/catch y la salida es siempre 0; con stdin vacío o ilegible imprime la línea mínima.
//   · La ruta de render no usa la red. El estado oficial de Claude lo consulta un proceso aparte
//     (claude-status-fetch.js), lanzado en segundo plano y solo cuando el dato está viejo.
//   · Todo texto que llega de fuera (estado de Claude, tarea, nombre de carpeta, modelo) se imprime
//     sin caracteres de control: nada ajeno puede mover el cursor ni cambiar el título de la terminal.
//   · Por defecto no escribe nada. Dos opciones, apagadas, en uaeh.config.json:
//       statusline.estadoClaude    muestra el punto de estado y activa el vigilante
//       statusline.guardarLimites  guarda los límites 5h/7d en <cache>/rate-limits-cache.json
//                                  para que otras herramientas los lean sin llamar a la API
//   · Segmento opcional de tarea: si existe <claudeHome>/task-progress.json con la forma
//       { "label": "texto", "current": 3, "total": 10, "updated_at": <epoch en ms o s, o ISO 8601> }
//     se dibuja una barra de avance. Se oculta si no se actualiza en 15 min, o 30 s después de terminar.
//   · El contexto se mide contra el punto donde la conversación se compacta sola (tope de
//     scripts/ventana-contexto.cjs), no contra la ventana completa del modelo: con ventana de 1M y
//     compactación a 500K, usar el 40 % de 1M equivale a haber gastado el 80 % de lo disponible.
//   · Este archivo se copia tal cual a <uaehHome>/estable/statusline/ junto con ../scripts/lib/comun.cjs
//     y ../scripts/ventana-contexto.cjs, así que solo localiza a sus hermanos con __dirname.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process'); // se usa como cp.spawn(...) para poder sustituirlo en las pruebas

const ESTADO_TTL_MS = 90 * 1000;              // el vigilante refresca el estado oficial como mucho cada 90 s
const ESTADO_CONFIANZA_MS = 10 * 60 * 1000;   // un dato más viejo que esto se pinta gris («sin datos»)
const TAREA_VIGENCIA_MS = 15 * 60 * 1000;     // un avance sin actualizar en este tiempo se oculta
const TAREA_CERRADA_MS = 30 * 1000;           // una tarea terminada se sigue mostrando este tiempo
const ESPERA_STDIN_MS = 2000;                 // tope de espera por stdin: la barra nunca queda colgada

// comun.cjs trae las rutas de estado, la configuración y el reloj. Si no carga, la barra sigue
// funcionando sin lo que depende de él (cachés, estado de Claude, tarea).
let comun = null;
try { comun = require(path.join(__dirname, '..', 'scripts', 'lib', 'comun.cjs')); } catch { comun = null; }

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  rgb: (r, g, b) => `\x1b[38;2;${r};${g};${b}m`,
};
const R = C.reset;
const SEPARADOR = `${C.dim} │ ${R}`;

// ── Utilidades de entorno (nunca lanzan) ──────────────────────────────────────────────

// La hora sale de comun.ahora(): las pruebas la fijan con UAEH_AHORA.
function ahoraMs() {
  try { return comun.ahora().getTime(); } catch { return Date.now(); }
}

function rutaCache(nombre) {
  try { return path.join(comun.cacheDir(), nombre); } catch { return null; }
}

function rutaClaude(nombre) {
  try { return path.join(comun.claudeHome(), nombre); } catch { return null; }
}

function leerJson(ruta) {
  try { return ruta ? comun.leerJson(ruta) : null; } catch { return null; }
}

function opcionesBarra() {
  try { return comun.cargarConfig().config.statusline || {}; } catch { return {}; }
}

function seguro(fn) {
  try { return fn(); } catch { return null; }
}

function esObjeto(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Texto que llega de fuera (archivos, red, nombres de carpeta) sin caracteres de control: un ESC
// colado no debe poder mover el cursor ni cambiar el título de la terminal.
function limpiarTexto(valor) {
  return String(valor).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

// ── Render ────────────────────────────────────────────────────────────────────────────

function render(entrada) {
  const d = esObjeto(entrada) ? entrada : {};
  const ahora = ahoraMs();
  const opciones = opcionesBarra();
  const carpeta = (esObjeto(d.workspace) && d.workspace.current_dir) || d.cwd;
  const cwd = typeof carpeta === 'string' ? carpeta : '';
  const limites = esObjeto(d.rate_limits) ? d.rate_limits : {};

  if (opciones.guardarLimites === true) seguro(() => guardarCacheLimites(limites, ahora));

  const partes = [
    opciones.estadoClaude === true ? seguro(() => segmentoEstado(ahora)) : null,
    seguro(() => segmentoModelo(d)),
    seguro(() => segmentoLimite('5h', limites.five_hour, ahora)),
    seguro(() => segmentoTarea(ahora)),
    seguro(() => segmentoSesion(d)),
    seguro(() => segmentoLimite('7d', limites.seven_day, ahora)),
    seguro(() => segmentoContexto(d, cwd)),
    seguro(() => segmentoCarpeta(cwd)),
  ].filter(Boolean);

  return partes.length ? partes.join(SEPARADOR) : lineaMinima();
}

function lineaMinima() {
  return `${C.bold}Claude${R}`;
}

function segmentoModelo(d) {
  const nivel = (esObjeto(d.effort) && typeof d.effort.level === 'string' && limpiarTexto(d.effort.level)) || '—';
  return `${C.bold}${formatModel(d.model)}${R}${C.dim} · ${R}${nivel}`;
}

// Sin dato del límite (p. ej. uso por API, o antes de la primera respuesta) el segmento no aparece:
// mostrar «0 %» afirmaría algo que no se sabe.
function segmentoLimite(etiqueta, ventana, ahora) {
  if (!esObjeto(ventana)) return null;
  const usado = clampPct(ventana.used_percentage);
  return `${C.dim}${etiqueta}${R} ${colorUsado(usado)}${usado}%${R}${C.dim} → ${R}${formatReset(ventana.resets_at, ahora)}`;
}

function segmentoSesion(d) {
  const ms = esObjeto(d.cost) ? d.cost.total_duration_ms : 0;
  return `${C.dim}sesión${R} ${formatDuration(ms)}`;
}

function segmentoContexto(d, cwd) {
  const ctx = esObjeto(d.context_window) ? d.context_window : {};
  const ventanaModelo = Number(ctx.context_window_size) > 0 ? Number(ctx.context_window_size) : 0;
  const usadoTok = ventanaModelo ? Math.round((Number(ctx.used_percentage) || 0) / 100 * ventanaModelo) : 0;
  const tope = leerVentanaCompacta(idDeModelo(d.model), cwd);
  const ctxMax = ventanaModelo && tope ? Math.min(ventanaModelo, tope) : ventanaModelo;
  const usadoPct = ctxMax ? clampPct((usadoTok / ctxMax) * 100) : clampPct(ctx.used_percentage);
  const libre = 100 - usadoPct;
  const tokens = ctxMax ? usadoTok : (Number(ctx.total_input_tokens) || 0) + (Number(ctx.total_output_tokens) || 0);
  const detalle = ctxMax
    ? `${C.dim} (${formatNum(tokens)}/${formatNum(ctxMax)})${R}`
    : ` ${C.dim}(${formatNum(tokens)} tok)${R}`;
  return `${renderBar(libre, 12)} ${colorLibre(libre)}${libre}% libre${R}${detalle}`;
}

function segmentoCarpeta(cwd) {
  return `${C.dim}📁${R} ${nombreCarpeta(cwd)}`;
}

// ── Estado oficial de Claude (solo con statusline.estadoClaude) ──────────────────────

function segmentoEstado(ahora) {
  const estado = leerEstadoClaude();
  lanzarVigilanteSiHaceFalta(estado, ahora);
  const p = puntoDeEstado(estado, ahora);
  return p.texto ? `${p.punto} ${p.texto}` : p.punto;
}

function leerEstadoClaude() {
  const datos = leerJson(rutaCache('claude-status.json'));
  return esObjeto(datos) ? datos : { missing: true };
}

// Si el dato está viejo y no hay otra consulta en vuelo, lanza el vigilante en segundo plano
// (detached). No espera la red: la barra nunca se congela.
function lanzarVigilanteSiHaceFalta(estado, ahora) {
  try {
    const datoViejo = ahora - (Number(estado.fetched_at) || 0) > ESTADO_TTL_MS;
    const intentoViejo = ahora - (Number(estado.attempted_at) || 0) > ESTADO_TTL_MS;
    if (!datoViejo || !intentoViejo) return;   // dato fresco, o ya hay una consulta reciente en vuelo
    const script = path.join(__dirname, 'claude-status-fetch.js');
    if (!fs.existsSync(script)) return;
    // Sin una carpeta de caché escribible el vigilante no podría marcar su intento, y la barra lo
    // relanzaría en cada refresco: si no se puede escribir, no se lanza.
    const carpeta = path.dirname(rutaCache('claude-status.json'));
    fs.mkdirSync(carpeta, { recursive: true });
    fs.accessSync(carpeta, fs.constants.W_OK);
    const hijo = cp.spawn(process.execPath, [script], { detached: true, stdio: 'ignore', windowsHide: true });
    hijo.on('error', () => { /* no se pudo lanzar: la barra sigue igual */ });
    hijo.unref();
  } catch { /* nunca romper la barra por esto */ }
}

function colorEstado(nivel) {
  switch (String(nivel)) {
    case 'minor': return C.bold + C.rgb(255, 200, 50);
    case 'major': return C.bold + C.rgb(255, 140, 40);
    case 'critical': return C.bold + C.rgb(255, 80, 80);
    case 'maintenance': return C.bold + C.rgb(80, 170, 255);
    default: return C.rgb(80, 215, 120);
  }
}

function puntoDeEstado(estado, ahora) {
  const traido = Number(estado && estado.fetched_at) || 0;
  const fresco = traido > 0 && ahora - traido <= ESTADO_CONFIANZA_MS;
  // Sin dato confiable → punto gris y sin texto: no se afirma «todo bien» a ciegas.
  if (!estado || estado.missing || !fresco) return { punto: `${C.rgb(120, 120, 130)}●${R}`, texto: null };
  const indicador = String(estado.indicator || 'none');
  const color = colorEstado(estado.level || indicador);
  const punto = `${color}●${R}`;
  const completo = limpiarTexto(estado.message || '');
  if (indicador === 'none' || !completo) return { punto, texto: null };   // todo operativo → solo el punto verde
  const mensaje = completo.length > 30 ? completo.slice(0, 29) + '…' : completo;
  return { punto, texto: `${color}Claude: ${mensaje}${R}` };
}

// ── Caché de límites 5h/7d (solo con statusline.guardarLimites) ──────────────────────

// Guarda rate_limits solo cuando cambia, con escritura atómica (.tmp + rename): otro proceso puede
// estar leyendo el archivo en ese momento.
function guardarCacheLimites(limites, ahora) {
  try {
    if (!limites || (!limites.five_hour && !limites.seven_day)) return;
    const archivo = rutaCache('rate-limits-cache.json');
    if (!archivo) return;
    const cinco = limites.five_hour || null;
    const siete = limites.seven_day || null;
    const previo = leerJson(archivo);
    if (esObjeto(previo) && previo.source === 'statusline'
      && JSON.stringify([previo.five_hour || null, previo.seven_day || null]) === JSON.stringify([cinco, siete])) return;
    const tmp = `${archivo}.${process.pid}.tmp`;
    try {
      comun.escribirJson(tmp, { five_hour: cinco, seven_day: siete, at: ahora, source: 'statusline' });
      fs.renameSync(tmp, archivo);
    } catch {
      // Dos barras a la vez, o un lector con el archivo abierto: la que pierde limpia su .tmp y
      // vuelve a intentarlo en el siguiente refresco.
      try { fs.unlinkSync(tmp); } catch { /* ya no está */ }
    }
  } catch { /* la barra no depende de este archivo */ }
}

// ── Avance de tarea (opcional) ────────────────────────────────────────────────────────

// Acepta epoch en milisegundos o segundos, o una fecha ISO 8601. 0 = sin dato.
function epochMs(v) {
  if (typeof v === 'string' && v.trim() && !/^\d+(\.\d+)?$/.test(v.trim())) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

function numeroFinito(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function leerTarea(ahora) {
  const datos = leerJson(rutaClaude('task-progress.json'));
  if (!esObjeto(datos)) return null;
  const actualizado = epochMs(datos.updated_at);
  if (actualizado && ahora - actualizado > TAREA_VIGENCIA_MS) return null;
  const actual = Math.max(0, numeroFinito(datos.current));
  const total = Math.max(1, numeroFinito(datos.total) || 1);
  if (actual >= total && actualizado && ahora - actualizado > TAREA_CERRADA_MS) return null;
  const etiqueta = typeof datos.label === 'string' || typeof datos.label === 'number' ? limpiarTexto(datos.label).trim() : '';
  return { etiqueta: etiqueta || 'tarea', actual, total };
}

function segmentoTarea(ahora) {
  const tarea = leerTarea(ahora);
  if (!tarea) return null;
  const pct = Math.min(100, Math.round((tarea.actual / tarea.total) * 100));
  const ancho = 10;
  const llenos = Math.round((pct / 100) * ancho);
  const lista = tarea.actual >= tarea.total;
  let barra = '';
  for (let i = 0; i < ancho; i++) {
    barra += i < llenos
      ? `${lista ? C.rgb(80, 220, 120) : C.rgb(80, 215, 200)}█`
      : `${C.rgb(55, 55, 60)}█`;
  }
  barra += R;
  const cabeza = lista ? `${C.rgb(80, 220, 120)}✓${R}` : `${C.rgb(80, 215, 200)}▶${R}`;
  const etiqueta = tarea.etiqueta.length > 28 ? tarea.etiqueta.slice(0, 27) + '…' : tarea.etiqueta;
  return `${cabeza} ${barra} ${C.dim}${tarea.actual}/${tarea.total}${R} ${etiqueta}`;
}

// ── Tope de compactación ─────────────────────────────────────────────────────────────

// Tokens a los que la conversación se compacta sola; 0 = sin límite propio (la barra mide contra la
// ventana completa del modelo). La lógica vive en scripts/ventana-contexto.cjs, que comparte con el
// hook de aviso de contexto. Si el módulo no está o falla, no hay tope.
function leerVentanaCompacta(modelo, cwd) {
  try {
    const modulo = require(path.join(__dirname, '..', 'scripts', 'ventana-contexto.cjs'));
    const tope = Number(modulo.topeCompactacion(modelo, { cwd }));
    return Number.isFinite(tope) && tope > 0 ? tope : 0;
  } catch { return 0; }
}

// ── Formato ───────────────────────────────────────────────────────────────────────────

// Familia y versión desde el id: «claude-opus-5-5» → «Opus 5.5». La versión menor admite 1 o 2 cifras
// y no debe ir pegada a más dígitos, para que un id con fecha («claude-sonnet-4-20250514») dé «Sonnet 4».
const RE_MODELO = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/;

function idDeModelo(m) {
  if (typeof m === 'string') return m;
  return esObjeto(m) && typeof m.id === 'string' ? m.id : '';
}

function formatModel(m) {
  if (esObjeto(m) && typeof m.display_name === 'string') {
    const nombre = limpiarTexto(m.display_name).trim();
    if (nombre) return nombre;
  }
  const coincide = RE_MODELO.exec(idDeModelo(m));
  if (coincide) {
    const familia = coincide[1].charAt(0).toUpperCase() + coincide[1].slice(1);
    return coincide[3] ? `${familia} ${coincide[2]}.${coincide[3]}` : `${familia} ${coincide[2]}`;
  }
  return 'Claude';
}

function nombreCarpeta(cwd) {
  if (!cwd || typeof cwd !== 'string') return '~';
  let casa = '';
  try { casa = os.homedir(); } catch { /* sin carpeta de usuario conocida */ }
  const norm = (s) => s.replace(/[\\/]+$/, '').toLowerCase();
  if (casa && norm(cwd) === norm(casa)) return '~';
  const partes = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return limpiarTexto(partes.pop() || '') || '/';
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function formatNum(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 999950) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function formatDuration(ms) {
  const s = Math.floor((Number(ms) || 0) / 1000);
  if (s < 60) return `${Math.max(0, s)}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Tiempo que falta para un reinicio de límite. `epoch` en segundos Unix (como lo entrega Claude Code);
// `ahora` en milisegundos, por defecto el reloj del kit.
function formatReset(epoch, ahora = ahoraMs()) {
  const e = Number(epoch);
  if (!e || e <= 0) return `${C.dim}—${R}`;
  const falta = e - Math.floor(ahora / 1000);
  if (falta <= 0) return `${C.dim}ahora${R}`;
  const d = Math.floor(falta / 86400);
  const h = Math.floor((falta % 86400) / 3600);
  const m = Math.floor((falta % 3600) / 60);
  if (d > 0 && h > 0) return `${d}d ${h}h ${m}m`;
  if (d > 0) return `${d}d ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

function colorLibre(p) {
  if (p < 15) return C.bold + C.rgb(255, 80, 80);
  if (p < 35) return C.bold + C.rgb(255, 200, 50);
  return C.bold + C.rgb(80, 220, 120);
}

function colorUsado(p) {
  if (p > 85) return C.bold + C.rgb(255, 80, 80);
  if (p > 60) return C.bold + C.rgb(255, 200, 50);
  return C.bold + C.rgb(80, 220, 120);
}

// Barra de `ancho` bloques con `libre` % lleno; el color pasa de verde a rojo a medida que se agota.
function renderBar(libre, ancho) {
  const pct = clampPct(libre);
  const llenos = Math.round((pct / 100) * ancho);
  let r, g;
  if (pct > 50) { r = Math.round(((100 - pct) * 2 * 255) / 100); g = 220; }
  else { r = 255; g = Math.round((pct * 2 * 220) / 100); }
  let salida = '';
  for (let i = 0; i < ancho; i++) salida += i < llenos ? `${C.rgb(r, g, 0)}█` : `${C.rgb(55, 55, 60)}█`;
  return salida + R;
}

// ── Entrada y salida ──────────────────────────────────────────────────────────────────

// Lee `entrada` (stdin) hasta que se cierre o hasta `esperaMs`, lo que ocurra primero, y entrega lo
// recibido a `alTerminar`. Un terminal interactivo (alguien ejecutó el script a mano) no espera nada.
// `entrada` y `esperaMs` existen para poder probarla con un flujo falso.
function leerStdin(alTerminar, { entrada = process.stdin, esperaMs = ESPERA_STDIN_MS } = {}) {
  const trozos = [];
  let terminado = false;
  const fin = () => {
    if (terminado) return;
    terminado = true;
    clearTimeout(reloj);
    try { entrada.destroy(); } catch { /* ya cerrado */ }
    alTerminar(Buffer.concat(trozos).toString('utf8'));
  };
  const reloj = setTimeout(fin, esperaMs);
  if (entrada.isTTY) { fin(); return; }
  entrada.on('data', (c) => trozos.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
  entrada.on('end', fin);
  entrada.on('error', fin);
}

function principal() {
  let impreso = false;
  const imprimir = (texto) => {
    if (impreso) return;
    impreso = true;
    try { process.stdout.write(texto); } catch { /* sin salida no hay nada más que hacer */ }
  };
  process.stdout.on('error', () => { /* tubería cerrada por quien nos lee */ });
  process.on('uncaughtException', () => { imprimir(lineaMinima()); process.exit(0); });

  const alTerminar = (crudo) => {
    let datos = {};
    try {
      const j = JSON.parse(crudo || '{}');
      if (esObjeto(j)) datos = j;
    } catch { /* entrada ilegible: línea mínima */ }
    let linea;
    try { linea = render(datos); } catch { linea = lineaMinima(); }
    imprimir(linea);
  };
  try { leerStdin(alTerminar); } catch { alTerminar(''); }
}

if (require.main === module) principal();

module.exports = { render, formatModel, formatNum, formatDuration, formatReset, renderBar, clampPct, leerStdin };
