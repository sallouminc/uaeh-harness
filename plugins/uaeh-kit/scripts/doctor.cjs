#!/usr/bin/env node
// scripts/doctor.cjs — diagnóstico de la instalación de la capa 1 del método UAEH (plugin uaeh-kit).
//
// Uso: node doctor.cjs [--capa kit|todo] [--cwd <dir>] [--json] [--proponer]
//   --capa      hoy solo existe la capa kit; «todo» equivale a «kit».
//   --cwd       carpeta del proyecto que se revisa (por defecto, la actual).
//   --json      salida de máquina: { capa, comprobaciones:[{id, estado, detalle}], resumen:{…}, codigo }.
//   --proponer  si hay hooks duplicados en settings, escribe junto a cada archivo afectado un
//               <nombre>.uaeh-propuesto.json (el mismo settings sin los duplicados). El original no se toca.
//   --tope      (avanzado/pruebas) carpeta donde se deja de subir al buscar los CLAUDE.md del proyecto.
//
// Reglas de este script:
//   · Solo lee. La única escritura posible son los archivos *.uaeh-propuesto.json de --proponer.
//   · Cada comprobación va aislada: si lanza, queda como FALLÓ con el mensaje y el resto sigue.
//   · Estados: OK | AVISO | FALLÓ | OMITIDA | NO_INSTALADA | NO_APLICA. Código de salida: 0 sin FALLÓ ·
//     1 con FALLÓ · 2 uso incorrecto.
//   · Nunca imprime la marca de inyección (MARCA_CONTEXTO): la salida del doctor acaba en transcripciones y
//     una marca impresa aquí se leería después como «inyección vista» (falso positivo).
//   · Las rutas de estado salen de lib/comun.cjs; los archivos del plugin, de __dirname.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const comun = require(path.join(__dirname, 'lib', 'comun.cjs'));

const RAIZ = path.resolve(__dirname, '..');
const ESTADOS = ['OK', 'AVISO', 'FALLÓ', 'OMITIDA', 'NO_INSTALADA', 'NO_APLICA'];
const NODE_MINIMO = 20;
const CLAUDE_CODE_MINIMO = '2.1.295';
const DIAS_RECIENTES = 7;
const MAX_TRANSCRIPCIONES_INYECCION = 30;
const MAX_TRANSCRIPCIONES_LISTADO = 6;
const MAX_BYTES_ARCHIVO = 256 * 1024 * 1024; // tope de lectura por transcripción
const MAX_BYTES_TOTAL = 1024 * 1024 * 1024;  // tope de lectura entre todas las de la inyección
const MAX_MAS_LARGAS = 5;

// Scripts de una instalación manual anterior del método: si siguen en settings, corren dos veces.
const SCRIPTS_DUPLICADOS = ['inyectar-contexto.js', 'vigia-contexto.js', 'router-context-inject.js'];
const RE_SCRIPT_DUPLICADO = new RegExp(`(?:^|[\\s"'\\/\\\\])(${SCRIPTS_DUPLICADOS.map((s) => s.replace(/\./g, '\\.')).join('|')})(?=$|[\\s"'])`);
// ${CLAUDE_PLUGIN_ROOT}/<ruta> dentro del command de un hook.
const RE_RAIZ_PLUGIN = /\$\{CLAUDE_PLUGIN_ROOT\}[\\/]+([^\s"'\x60<>|&;)]+)/g;

// ── Utilidades ────────────────────────────────────────────────────────────────────────────

function claveRuta(ruta) {
  const r = path.resolve(ruta);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function compararVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function sha256(ruta) {
  return crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex');
}

function miles(n) { return Number(n).toLocaleString('en-US'); }
function kilo(n) { return `${(n / 1000).toFixed(1)}K`; }

// ¿El archivo contiene la cadena? Lee por bloques y para al encontrarla; `maxBytes` acota archivos enormes.
// Devuelve { hallado, leidos }.
function archivoContiene(ruta, aguja, maxBytes = MAX_BYTES_ARCHIVO) {
  const buscada = Buffer.from(aguja, 'utf8');
  const fd = fs.openSync(ruta, 'r');
  try {
    const bloque = Buffer.alloc(4 * 1024 * 1024);
    let leidos = 0;
    let cola = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, bloque, 0, bloque.length, null);
      if (n <= 0) return { hallado: false, leidos };
      leidos += n;
      const ventana = Buffer.concat([cola, bloque.subarray(0, n)]);
      if (ventana.includes(buscada)) return { hallado: true, leidos };
      cola = ventana.subarray(Math.max(0, ventana.length - (buscada.length - 1)));
      if (leidos >= maxBytes) return { hallado: false, leidos };
    }
  } finally { fs.closeSync(fd); }
}

// ¿Alguna LÍNEA del archivo contiene todas las agujas a la vez? Lee por bloques y para al encontrarla.
// Sirve para exigir que la marca de inyección venga en la línea `attachment` de tipo
// hook_additional_context (lo que Claude Code adjuntó al contexto del modelo) y no suelta en cualquier
// otra parte de la conversación (una respuesta del modelo, la salida de una herramienta…).
// Devuelve { hallado, leidos }.
function archivoContieneEnLinea(ruta, agujas, maxBytes = MAX_BYTES_ARCHIVO) {
  const fd = fs.openSync(ruta, 'r');
  try {
    const bloque = Buffer.alloc(4 * 1024 * 1024);
    let leidos = 0;
    let resto = '';
    const tieneTodas = (linea) => agujas.every((a) => linea.includes(a));
    for (;;) {
      const n = fs.readSync(fd, bloque, 0, bloque.length, null);
      if (n <= 0) return { hallado: !!resto && tieneTodas(resto), leidos };
      leidos += n;
      resto += bloque.toString('utf8', 0, n);
      let corte;
      while ((corte = resto.indexOf('\n')) >= 0) {
        if (tieneTodas(resto.slice(0, corte))) return { hallado: true, leidos };
        resto = resto.slice(corte + 1);
      }
      if (leidos >= maxBytes) return { hallado: false, leidos };
    }
  } finally { fs.closeSync(fd); }
}

// Transcripciones de sesión bajo `dir` (sin las de subagentes), de la más reciente a la más antigua.
function listarTranscripciones(dir, profundidad = 0, acumulado = []) {
  if (profundidad > 8) return acumulado;
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acumulado; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'subagents') listarTranscripciones(p, profundidad + 1, acumulado);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try { const st = fs.statSync(p); acumulado.push({ ruta: p, mtimeMs: st.mtimeMs, tam: st.size }); } catch { /* desapareció */ }
    }
  }
  return profundidad === 0 ? acumulado.sort((a, b) => b.mtimeMs - a.mtimeMs) : acumulado;
}

// Recorre hooks.<Evento>[i].hooks[j] y llama cb(evento, i, j, hook).
function recorrerHooks(settings, cb) {
  const hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return;
  for (const [evento, grupos] of Object.entries(hooks)) {
    if (!Array.isArray(grupos)) continue;
    grupos.forEach((grupo, i) => {
      const lista = grupo && Array.isArray(grupo.hooks) ? grupo.hooks : [];
      lista.forEach((hook, j) => cb(evento, i, j, hook));
    });
  }
}

function scriptDuplicado(comando) {
  if (typeof comando !== 'string') return null;
  const m = RE_SCRIPT_DUPLICADO.exec(comando);
  return m ? m[1] : null;
}

// Copia del settings sin los hooks duplicados; quita los grupos (y eventos) que queden vacíos por ello.
function sinDuplicados(settings) {
  const copia = JSON.parse(JSON.stringify(settings));
  for (const [evento, grupos] of Object.entries(copia.hooks)) {
    if (!Array.isArray(grupos)) continue;
    const quedan = [];
    for (const grupo of grupos) {
      if (grupo && Array.isArray(grupo.hooks)) {
        const antes = grupo.hooks.length;
        grupo.hooks = grupo.hooks.filter((h) => !(h && scriptDuplicado(h.command)));
        if (antes > 0 && grupo.hooks.length === 0) continue;
      }
      quedan.push(grupo);
    }
    if (quedan.length) copia.hooks[evento] = quedan;
    else delete copia.hooks[evento];
  }
  if (Object.keys(copia.hooks).length === 0) delete copia.hooks;
  return copia;
}

// ── Contexto compartido por las comprobaciones (todo se lee una sola vez) ─────────────────

function crearContexto(opciones) {
  const cwd = path.resolve(opciones.cwd || process.cwd());
  const cache = new Map();
  const memo = (clave, fn) => {
    if (!cache.has(clave)) cache.set(clave, fn());
    return cache.get(clave);
  };
  const ctx = {
    cwd,
    tope: opciones.tope ? path.resolve(opciones.tope) : null,
    proponer: !!opciones.proponer,
    config: () => memo('config', () => comun.cargarConfig()),
    zona: () => memo('zona', () => comun.zonaHoraria(ctx.config().config)),

    // Los 4 settings que Claude Code puede leer, sin repetir ninguno: { ruta, datos|null, error|null }.
    settings: () => memo('settings', () => {
      const casa = comun.claudeHome();
      const candidatos = [
        path.join(casa, 'settings.json'),
        path.join(casa, 'settings.local.json'),
        path.join(cwd, '.claude', 'settings.json'),
        path.join(cwd, '.claude', 'settings.local.json'),
      ];
      const vistos = new Set();
      const salida = [];
      for (const ruta of candidatos) {
        const clave = claveRuta(ruta);
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        if (!fs.existsSync(ruta)) continue;
        const texto = comun.leerTexto(ruta);
        let datos = null;
        let error = null;
        if (texto == null) error = 'no se pudo leer';
        else {
          try { datos = JSON.parse(texto); } catch (e) { error = e.message; }
          if (datos !== null && (typeof datos !== 'object' || Array.isArray(datos))) { datos = null; error = 'la raíz no es un objeto JSON'; }
        }
        salida.push({ ruta, datos, error });
      }
      return salida;
    }),

    // Primer valor definido según la prioridad de Claude Code: proyecto local > proyecto > usuario local > usuario.
    valorSettings: (extraer) => {
      for (const s of ctx.settings().filter((x) => x.datos).reverse()) {
        const v = extraer(s.datos);
        if (v !== undefined && v !== null && v !== '') return { valor: v, ruta: s.ruta };
      }
      return null;
    },

    // CLAUDE.md global y los que Claude Code carga para el cwd: { ruta, texto }.
    claudeMd: () => memo('claudeMd', () => {
      const rutas = [];
      const global = path.join(comun.claudeHome(), 'CLAUDE.md');
      if (fs.existsSync(global)) rutas.push(global);
      rutas.push(...comun.claudeMdDelProyecto(cwd, ctx.tope ? { tope: ctx.tope } : {}));
      const vistos = new Set();
      const salida = [];
      for (const ruta of rutas) {
        const clave = claveRuta(ruta);
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        salida.push({ ruta, texto: comun.leerTexto(ruta) || '' });
      }
      return salida;
    }),

    transcripciones: () => memo('transcripciones', () => listarTranscripciones(path.join(comun.claudeHome(), 'projects'))),
  };
  return ctx;
}

// ── Comprobaciones ────────────────────────────────────────────────────────────────────────

function comprobarNode() {
  const version = process.versions.node;
  return Number(version.split('.')[0]) >= NODE_MINIMO
    ? { estado: 'OK', detalle: `Node ${version}` }
    : { estado: 'FALLÓ', detalle: `Node ${version}: se necesita la versión ${NODE_MINIMO} o superior` };
}

function comprobarClaudeCode() {
  const opciones = { encoding: 'utf8', timeout: 15000 };
  // En Windows «claude» puede ser un .cmd: hace falta shell. Con cadena única (sin arreglo de argumentos)
  // para no disparar la advertencia de deprecación DEP0190 de Node 24.
  const r = process.platform === 'win32'
    ? spawnSync('claude --version', { ...opciones, shell: true })
    : spawnSync('claude', ['--version'], opciones);
  if (r.error && r.error.code === 'ETIMEDOUT') return { estado: 'AVISO', detalle: 'claude --version no respondió en 15 s' };
  if (r.error || r.status !== 0) return { estado: 'NO_INSTALADA', detalle: 'no se encontró el comando «claude» en el PATH' };
  const salida = String(r.stdout || '').trim();
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(salida);
  if (!m) return { estado: 'AVISO', detalle: `no se pudo leer la versión de Claude Code (salida: ${salida.slice(0, 60) || 'vacía'})` };
  const version = `${m[1]}.${m[2]}.${m[3]}`;
  if (compararVersion(version, CLAUDE_CODE_MINIMO) < 0) {
    return { estado: 'AVISO', detalle: `Claude Code ${version}: se recomienda ${CLAUDE_CODE_MINIMO} o superior; actualízalo` };
  }
  return { estado: 'OK', detalle: `Claude Code ${version}` };
}

function comprobarRutas() {
  const claude = comun.claudeHome();
  const uaeh = comun.uaehHome();
  let estado = 'OK';
  const notas = [];
  const empeorar = (e) => { if (e === 'FALLÓ' || estado === 'OK') estado = e; };
  if (!fs.existsSync(claude)) {
    notas.push(`la carpeta de Claude Code no existe (${claude})`);
    empeorar('FALLÓ');
  } else if (!fs.statSync(claude).isDirectory()) {
    notas.push(`la ruta de Claude Code existe pero no es una carpeta (${claude})`);
    empeorar('FALLÓ');
  } else {
    try { fs.accessSync(claude, fs.constants.W_OK); } catch {
      notas.push(`la carpeta de Claude Code no es escribible (${claude})`);
      empeorar('FALLÓ');
    }
  }
  if (!fs.existsSync(uaeh)) {
    notas.push(`${uaeh} no existe; se crea con /uaeh-kit:setup`);
    empeorar('AVISO');
  }
  for (const [nombre, ruta] of [['claudeHome', claude], ['uaehHome', uaeh]]) {
    if (/\s/.test(ruta) || /[^\x20-\x7e]/.test(ruta)) {
      notas.push(`${nombre} tiene espacios o caracteres no ASCII (${ruta}); si un hook falla, revisa esto primero`);
      empeorar('AVISO');
    }
  }
  return estado === 'OK'
    ? { estado, detalle: `claudeHome ${claude} (escribible) · uaehHome ${uaeh}` }
    : { estado, detalle: notas.join('; ') };
}

function comprobarHooksJson() {
  const ruta = path.join(RAIZ, 'hooks', 'hooks.json');
  if (!fs.existsSync(ruta)) return { estado: 'FALLÓ', detalle: 'falta hooks/hooks.json en el plugin' };
  const datos = comun.leerJson(ruta);
  if (datos == null) return { estado: 'FALLÓ', detalle: 'hooks/hooks.json no parsea como JSON' };
  if (!datos.hooks || typeof datos.hooks !== 'object' || Array.isArray(datos.hooks)) {
    return { estado: 'FALLÓ', detalle: 'hooks/hooks.json no trae la clave «hooks» con los eventos' };
  }
  let nHooks = 0;
  const scripts = new Set();
  recorrerHooks(datos, (evento, i, j, hook) => {
    if (!hook || hook.type !== 'command') return;
    nHooks++;
    const textos = [hook.command, ...(Array.isArray(hook.args) ? hook.args : [])].filter((t) => typeof t === 'string');
    for (const t of textos) for (const m of t.matchAll(RE_RAIZ_PLUGIN)) scripts.add(m[1]);
  });
  const faltan = [...scripts].filter((s) => !fs.existsSync(path.join(RAIZ, ...s.split(/[\\/]+/))));
  if (faltan.length) {
    return { estado: 'FALLÓ', detalle: `${nHooks} hooks; apuntan a scripts que no existen en el plugin: ${faltan.join(', ')}` };
  }
  return { estado: 'OK', detalle: `${nHooks} hooks, ${scripts.size} scripts presentes` };
}

function comprobarDuplicados(ctx) {
  const hallazgos = [];
  const porArchivo = new Map();
  const revisados = ctx.settings().filter((s) => s.datos);
  for (const s of revisados) {
    recorrerHooks(s.datos, (evento, i, j, hook) => {
      if (!hook || !scriptDuplicado(hook.command)) return;
      hallazgos.push(`${s.ruta} → /hooks/${evento}/${i}/hooks/${j}: ${hook.command}`);
      porArchivo.set(s.ruta, s.datos);
    });
  }
  const ilegibles = ctx.settings().filter((s) => s.error).map((s) => s.ruta);
  if (!hallazgos.length) {
    const nota = ilegibles.length ? `; no se pudieron leer: ${ilegibles.join(', ')}` : '';
    return { estado: 'OK', detalle: `sin hooks duplicados (${revisados.length} archivo(s) de settings revisado(s)${nota})` };
  }
  const propuestas = [];
  if (ctx.proponer) {
    for (const [ruta, datos] of porArchivo) {
      const destino = path.join(path.dirname(ruta), `${path.basename(ruta, '.json')}.uaeh-propuesto.json`);
      comun.escribirJson(destino, sinDuplicados(datos));
      propuestas.push(destino);
    }
  }
  const cierre = ctx.proponer
    ? `propuesta sin duplicados escrita en: ${propuestas.join(', ')}`
    : 'para generar una propuesta sin duplicados corre el doctor con --proponer';
  return { estado: 'AVISO', detalle: `${hallazgos.length} hook(s) de una instalación anterior que el plugin ya trae: ${hallazgos.join(' | ')}; ${cierre}` };
}

function comprobarConfig(ctx) {
  const r = ctx.config();
  if (!r.existe) return { estado: 'AVISO', detalle: `sin uaeh.config.json: valores por defecto (${r.ruta})` };
  if (r.avisos.length) return { estado: 'AVISO', detalle: r.avisos.join(' ') };
  return { estado: 'OK', detalle: `uaeh.config.json válido (${r.ruta})` };
}

function comprobarTopeCompactacion(ctx) {
  const ruta = path.join(__dirname, 'ventana-contexto.cjs');
  if (!fs.existsSync(ruta)) return { estado: 'OMITIDA', detalle: 'este plugin no trae scripts/ventana-contexto.cjs' };
  const modulo = require(ruta);
  if (typeof modulo.topeCompactacion !== 'function') return { estado: 'OMITIDA', detalle: 'scripts/ventana-contexto.cjs no exporta topeCompactacion' };
  const tope = Number(modulo.topeCompactacion(undefined, { cwd: ctx.cwd }));
  if (!Number.isFinite(tope)) return { estado: 'AVISO', detalle: 'el tope de compactación no se pudo calcular' };
  if (tope === 0) {
    const sinTope = Math.round((Number(modulo.COMPACTA_SIN_TOPE) || 967000) / 1000);
    return { estado: 'AVISO', detalle: `sin tope propio (se compacta cerca de ${sinTope}K); recomendado 700000 vía /uaeh-kit:setup settings` };
  }
  return { estado: 'OK', detalle: `tope de compactación: ${tope} tokens` };
}

function comprobarTranscripciones(ctx) {
  const lista = ctx.transcripciones();
  if (!lista.length) return { estado: 'NO_APLICA', detalle: `sin transcripciones en ${path.join(comun.claudeHome(), 'projects')}` };
  const masReciente = lista[0];
  const nombre = path.basename(masReciente.ruta);
  return archivoContiene(masReciente.ruta, '"usage"').hallado
    ? { estado: 'OK', detalle: `formato reconocido (${nombre})` }
    : { estado: 'AVISO', detalle: `formato no reconocido en ${nombre}: no trae el campo usage; las herramientas de medición podrían no leerlo` };
}

function comprobarInyeccion(ctx) {
  const todas = ctx.transcripciones();
  if (!todas.length) return { estado: 'NO_APLICA', detalle: 'sin transcripciones que revisar' };
  const limite = comun.ahora().getTime() - DIAS_RECIENTES * 86400000;
  const recientes = todas.filter((t) => t.mtimeMs >= limite).slice(0, MAX_TRANSCRIPCIONES_INYECCION);
  if (!recientes.length) return { estado: 'NO_APLICA', detalle: `sin transcripciones de los últimos ${DIAS_RECIENTES} días` };
  let presupuesto = MAX_BYTES_TOTAL;
  for (const t of recientes) {
    if (presupuesto <= 0) break;
    let r;
    // Solo cuenta la línea en la que Claude Code adjuntó la marca al contexto del modelo.
    try { r = archivoContieneEnLinea(t.ruta, ['"hook_additional_context"', comun.MARCA_CONTEXTO], Math.min(MAX_BYTES_ARCHIVO, presupuesto)); } catch { continue; }
    presupuesto -= r.leidos;
    if (r.hallado) {
      return { estado: 'OK', detalle: `vista en ${path.basename(t.ruta)} (${comun.legibleZona(new Date(t.mtimeMs), ctx.zona())})` };
    }
  }
  return { estado: 'AVISO', detalle: 'no vista en transcripciones recientes: abre una sesión nueva con el plugin cargado y vuelve a correr el doctor' };
}

function comprobarTamanoClaudeMd(ctx) {
  const archivos = ctx.claudeMd();
  if (!archivos.length) return { estado: 'NO_APLICA', detalle: 'no hay CLAUDE.md global ni de proyecto' };
  const pasados = archivos.filter((a) => a.texto.length > comun.LIMITE_CLAUDE_MD);
  if (pasados.length) {
    const lista = pasados.map((a) => `${a.ruta}: ${kilo(a.texto.length)} caracteres (${miles(a.texto.length)})`).join('; ');
    return { estado: 'AVISO', detalle: `por encima de ${miles(comun.LIMITE_CLAUDE_MD)} caracteres, que se releen en cada turno: ${lista}; adelgázalo con /uaeh-kit:dieta` };
  }
  const mayor = archivos.reduce((m, a) => (a.texto.length > m.texto.length ? a : m));
  return { estado: 'OK', detalle: `${archivos.length} CLAUDE.md; el mayor mide ${kilo(mayor.texto.length)} caracteres (límite ${miles(comun.LIMITE_CLAUDE_MD)})` };
}

function comprobarBloqueReglas(ctx) {
  const version = comun.versionPlugin();
  const conBloque = ctx.claudeMd()
    .map((a) => ({ ruta: a.ruta, ...comun.bloqueUaeh(a.texto) }))
    .filter((a) => a.presente);
  const alDia = conBloque.find((a) => a.version === version);
  if (alDia) return { estado: 'OK', detalle: `bloque v${version} al día en ${alDia.ruta}` };
  if (conBloque.length) {
    const b = conBloque[0];
    return { estado: 'AVISO', detalle: `bloque ${b.version ? `v${b.version}` : 'sin versión'} en ${b.ruta}, y el plugin es v${version}: actualizar con /uaeh-kit:setup claude-md` };
  }
  const reglas = ctx.config().config.reglas;
  if (reglas && reglas.inyectar === false) {
    return { estado: 'FALLÓ', detalle: 'ni bloque ni inyección: no hay bloque UAEH en ningún CLAUDE.md y uaeh.config.json tiene reglas.inyectar=false, así que las reglas no llegan al modelo' };
  }
  return { estado: 'AVISO', detalle: 'sin bloque: las reglas llegan compactas por hook; para el bloque completo: /uaeh-kit:setup claude-md' };
}

function comprobarStatusline(ctx) {
  const definida = ctx.valorSettings((s) => s.statusLine);
  if (!definida) return { estado: 'AVISO', detalle: 'sin barra de estado; opcional: /uaeh-kit:setup statusline' };
  const comando = definida.valor && typeof definida.valor === 'object' ? definida.valor.command : undefined;
  const normalizar = (s) => { const n = String(s).replace(/\\/g, '/'); return process.platform === 'win32' ? n.toLowerCase() : n; };
  const espejo = comun.estableDir();
  if (typeof comando !== 'string' || !normalizar(comando).includes(`${normalizar(espejo)}/`)) {
    return { estado: 'NO_APLICA', detalle: 'barra propia: no es la del kit' };
  }
  const desactualizados = [];
  for (const rel of ['statusline/statusline.js', 'statusline/claude-status-fetch.js']) {
    const origen = path.join(RAIZ, ...rel.split('/'));
    if (!fs.existsSync(origen)) return { estado: 'OMITIDA', detalle: `el plugin no trae ${rel}; no hay con qué comparar el espejo` };
    const copia = path.join(espejo, ...rel.split('/'));
    if (!fs.existsSync(copia)) desactualizados.push(`${rel} (falta en el espejo)`);
    else if (sha256(copia) !== sha256(origen)) desactualizados.push(`${rel} (distinto del plugin)`);
  }
  if (desactualizados.length) {
    return { estado: 'AVISO', detalle: `desactualizado: ${desactualizados.join(', ')}; vuelve a correr /uaeh-kit:setup statusline` };
  }
  return { estado: 'OK', detalle: `barra del kit al día en ${espejo}` };
}

function comprobarEspejo() {
  const archivo = path.join(comun.estableDir(), 'VERSION');
  const texto = comun.leerTexto(archivo);
  if (texto == null) return { estado: 'NO_APLICA', detalle: 'sin espejo de ruta fija (se crea con /uaeh-kit:setup statusline)' };
  const enEspejo = texto.trim();
  const delPlugin = comun.versionPlugin();
  return enEspejo === delPlugin
    ? { estado: 'OK', detalle: `espejo v${enEspejo}, igual que el plugin` }
    : { estado: 'AVISO', detalle: `el espejo es v${enEspejo || '?'} y el plugin v${delPlugin}: vuelve a correr /uaeh-kit:setup statusline` };
}

function comprobarSkillsListado(ctx) {
  const ruta = path.join(__dirname, 'uaeh-listado-skills.cjs');
  if (!fs.existsSync(ruta)) return { estado: 'OMITIDA', detalle: 'este plugin no trae scripts/uaeh-listado-skills.cjs' };
  const modulo = require(ruta);
  if (typeof modulo.buscarListado !== 'function' || typeof modulo.analizar !== 'function') {
    return { estado: 'OMITIDA', detalle: 'scripts/uaeh-listado-skills.cjs no exporta buscarListado y analizar' };
  }
  for (const t of ctx.transcripciones().slice(0, MAX_TRANSCRIPCIONES_LISTADO)) {
    let listado = null;
    try { listado = modulo.buscarListado(t.ruta); } catch { listado = null; }
    if (!listado || typeof listado.content !== 'string') continue;
    const r = modulo.analizar(listado, []) || {};
    const n = Number.isFinite(r.skillCount) ? r.skillCount : (r.conDescripcion || 0) + (r.sinDescripcion || 0);
    const total = Number.isFinite(r.caracteres) ? r.caracteres : listado.content.length;
    const largas = (Array.isArray(r.masLargas) ? r.masLargas : []).slice(0, MAX_MAS_LARGAS)
      .map((x) => `${x.nombre} (${x.caracteres})`);
    return { estado: 'OK', detalle: `${n} skills, ${total} caracteres${largas.length ? `; más largas: ${largas.join(', ')}` : ''}` };
  }
  return { estado: 'NO_APLICA', detalle: 'ninguna transcripción reciente trae el listado de skills' };
}

function comprobarSubagenteModelo(ctx) {
  const r = ctx.valorSettings((s) => (s.env && typeof s.env === 'object' ? s.env.CLAUDE_CODE_SUBAGENT_MODEL : undefined));
  return r
    ? { estado: 'OK', detalle: `${r.valor} (pisa el model: de los agentes)` }
    : { estado: 'AVISO', detalle: 'sin modelo fijo para subagentes; recomendado: /uaeh-kit:setup settings' };
}

const COMPROBACIONES = [
  ['node', comprobarNode],
  ['claude-code', comprobarClaudeCode],
  ['rutas', comprobarRutas],
  ['hooks-json', comprobarHooksJson],
  ['duplicados', comprobarDuplicados],
  ['config', comprobarConfig],
  ['tope-compactacion', comprobarTopeCompactacion],
  ['transcripciones', comprobarTranscripciones],
  ['inyeccion', comprobarInyeccion],
  ['claude-md-tamano', comprobarTamanoClaudeMd],
  ['bloque-reglas', comprobarBloqueReglas],
  ['statusline', comprobarStatusline],
  ['espejo', comprobarEspejo],
  ['skills-listado', comprobarSkillsListado],
  ['subagente-modelo', comprobarSubagenteModelo],
];

// ── Ejecución y salida ────────────────────────────────────────────────────────────────────

// Una comprobación = una línea: los saltos de línea de un mensaje (p. ej. el de una excepción) se aplanan.
function unaLinea(texto) {
  return String(texto == null ? '' : texto).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

// Corre cada comprobación aislada: una excepción queda como FALLÓ y el resto sigue.
function ejecutar(opciones = {}) {
  const capa = opciones.capa || 'kit';
  const ctx = crearContexto(opciones);
  const comprobaciones = COMPROBACIONES.map(([id, comprobar]) => {
    try {
      const r = comprobar(ctx);
      if (!r || !ESTADOS.includes(r.estado)) throw new Error('la comprobación devolvió un resultado inválido');
      return { id, estado: r.estado, detalle: unaLinea(r.detalle) };
    } catch (e) {
      return { id, estado: 'FALLÓ', detalle: unaLinea(`error inesperado: ${e && e.message ? e.message : e}`) };
    }
  });
  const resumen = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
  for (const c of comprobaciones) resumen[c.estado]++;
  return { capa, comprobaciones, resumen, codigo: resumen['FALLÓ'] > 0 ? 1 : 0 };
}

function formatearHumano(informe) {
  const ancho = Math.max(...informe.comprobaciones.map((c) => c.id.length));
  const anchoEstado = Math.max(...ESTADOS.map((e) => e.length));
  const lineas = informe.comprobaciones.map((c) => `${c.estado.padEnd(anchoEstado)}  ${c.id.padEnd(ancho)} — ${c.detalle}`);
  lineas.push('', `Resumen: ${ESTADOS.map((e) => `${informe.resumen[e]} ${e}`).join(' · ')}`);
  return lineas.join('\n');
}

function uso() {
  return [
    'Uso: node doctor.cjs [--capa kit|todo] [--cwd <dir>] [--json] [--proponer]',
    '  --capa      capa a revisar (hoy solo existe kit; todo equivale a kit)',
    '  --cwd       carpeta del proyecto (por defecto, la actual)',
    '  --json      salida de máquina',
    '  --proponer  escribe <settings>.uaeh-propuesto.json sin los hooks duplicados (no toca el original)',
  ].join('\n');
}

// → { error } | { ayuda:true } | { opciones }
function parsearArgumentos(argv) {
  const opciones = { capa: 'kit', cwd: null, tope: null, json: false, proponer: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--ayuda', '--help', '-h'].includes(a)) return { ayuda: true };
    if (a === '--json') opciones.json = true;
    else if (a === '--proponer') opciones.proponer = true;
    else if (['--capa', '--cwd', '--tope'].includes(a)) {
      const valor = argv[++i];
      if (valor === undefined || valor.startsWith('--')) return { error: `falta el valor de ${a}` };
      opciones[a.slice(2)] = valor;
    } else return { error: `argumento desconocido: ${a}` };
  }
  if (!['kit', 'todo'].includes(opciones.capa)) return { error: `capa desconocida: ${opciones.capa} (usa kit o todo)` };
  for (const clave of ['cwd', 'tope']) {
    if (opciones[clave] && !fs.existsSync(path.resolve(opciones[clave]))) return { error: `--${clave}: la carpeta no existe: ${opciones[clave]}` };
  }
  return { opciones };
}

function main(argv) {
  const r = parsearArgumentos(argv);
  if (r.ayuda) { console.log(uso()); return 0; }
  if (r.error) { console.error(`doctor: ${r.error}`); console.error(uso()); return 2; }
  const informe = ejecutar(r.opciones);
  console.log(r.opciones.json ? JSON.stringify(informe, null, 2) : formatearHumano(informe));
  return informe.codigo;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  main, ejecutar, parsearArgumentos, formatearHumano, uso, crearContexto, COMPROBACIONES, ESTADOS,
  archivoContiene, listarTranscripciones, scriptDuplicado, sinDuplicados, compararVersion,
};
