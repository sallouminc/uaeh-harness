#!/usr/bin/env node
// SOLO NAVEGADOR — lista BLANCA para el agente browser-verifier.
//
// Se registra en hooks/hooks.json (PreToolUse, matcher "Bash|PowerShell"), DESPUÉS de solo-lectura.js (lista negra).
// Un hook de plugin corre en TODAS las sesiones y en TODOS los subagentes, así que lo primero es la compuerta por
// identidad (hooks/_identidad.js + la clave "solo-navegador" de hooks/candados.json), igual que en solo-lectura.js:
//   · Sesión principal (sin `agent_type`), agente no listado («uae-verifier», «general-purpose»…) o candados.json
//     ilegible → el candado NO aplica: sale con código 0 y sin salida (con candados.json ilegible, aviso en stderr).
//   · stdin ilegible (JSON roto) → no se puede saber quién ejecuta: no aplica (aviso en stderr).
//   · «browser-verifier», con o sin prefijo de plugin («uaeh-harness:browser-verifier») → aplica la lista blanca,
//     que FALLA CERRADO (más abajo).
// Aquí solo pasa lo que está enumerado: playwright-cli (lista
// CERRADA de subcomandos que no interactúan con la página), npx --no-install playwright test (config
// relativa playwright*.config.*, opciones largas en lista blanca), lighthouse exacto con --output-path en
// reports/visual-audit/, git de solo lectura y un chequeo de que la app local está arriba (curl -I a una
// URL local, sin seguir redirecciones). Todo lo demás se niega.
//   - UNA SOLA GRAMÁTICA: la de Bash. Si tool_name es PowerShell se niega (el verificador usa solo Bash):
//     tokenizar() es un tokenizador Bash ESTRICTO (sin «\» en ninguna posición; fuera de comillas niega
//     * ? [ ] ~ # ! $ ` ; & | < > ( ) { }) y una prueba de paridad la compara con Git Bash real, para que el
//     hook vea exactamente los argumentos que recibe el programa. Ningún token resuelto puede contener
//     comillas (salvo las 5 expresiones de eval de la lista cerrada).
//   - Navegación SOLO local: open / goto / tab-new / Lighthouse aceptan http(s)://localhost, 127.0.0.1,
//     [::1] (puerto/ruta opcionales) y about:blank. Ningún host externo (cierra la salida de datos).
//   - eval SOLO con una lista cerrada de expresiones exactas de medición (ver EVAL_OK).
//   - Capturas/salidas: ruta relativa dentro de reports/visual-audit/ y sin enlaces simbólicos/junctions
//     en los componentes que ya existan desde el cwd.
//   - open se niega si hay ~/.playwright/cli.config.json o variables PLAYWRIGHT_MCP_* / PWTEST_CLI_GLOBAL_CONFIG
//     (mezclarían perfil, endpoint o config bajo la config de confianza).
//
//   - Ronda 4 (SEC-010/012/013): programas SOLO por nombre exacto (playwright-cli, npx, git, git.exe, curl,
//     curl.exe; un .cmd pasa por cmd.exe, que re-corta la línea); ningún token resuelto lleva
//     & | < > ( ) ^ % " (salvo EVAL_OK); ningún token empieza por «/» ni lleva «=/» o «X:/» (Git Bash los
//     convertiría en ruta de Windows; única excepción: el --config de confianza de open); todo comando de
//     playwright-cli (salvo --help/--version) exige -s=/--session= con nombre ^uaeh-[a-z0-9][a-z0-9-]{0,62}$.
//   - Configuración de confianza de open (lista cerrada, calculada al correr; nunca una ruta fija de una máquina):
//     la plantilla del plugin (templates/playwright-cli.config.json, junto a esta carpeta) o la copia del usuario en
//     su carpeta de estado (UAEH_HOME/playwright-cli.config.json). Se escribe con «/»; en Windows sin distinguir
//     mayúsculas. Sin scripts/lib (copia incompleta del plugin) solo vale la plantilla.
//
// Para el agente listado, este hook FALLA CERRADO: sin comando de texto o cualquier excepción = deny. Permitir = no
// imprimir nada y salir 0. No declara `onFailure` (corre en todas las sesiones): no cubre una caída del propio node ni
// un timeout; la garantía de último recurso del revisor es el sello de integridad.
//
// Entrada: JSON por stdin ({tool_name, tool_input:{command}, agent_type, cwd, ...}).
// Salida para negar: JSON en stdout con permissionDecision "deny", código 0.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CARPETA = 'reports/visual-audit/';

// Rutas de confianza para «open --config=…», normalizadas para comparar («/»; minúsculas solo en Windows).
const normalizarRuta = (p) => {
  const s = String(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
let configsCache = null;
function configsDeConfianza() {
  if (configsCache) return configsCache;
  const rutas = [path.resolve(__dirname, '..', 'templates', 'playwright-cli.config.json')];
  try {
    const comun = require(path.join(__dirname, '..', 'scripts', 'lib', 'comun.cjs'));
    rutas.push(path.join(comun.uaehHome(), 'playwright-cli.config.json'));
  } catch { /* copia incompleta del plugin: solo la plantilla */ }
  configsCache = rutas.map((r) => ({ legible: r.replace(/\\/g, '/'), norm: normalizarRuta(r) }));
  return configsCache;
}
const esConfigDeConfianza = (v) => v !== null && v !== undefined && configsDeConfianza().some((c) => c.norm === normalizarRuta(v));
const configsLegibles = () => configsDeConfianza().map((c) => c.legible).join(' o ');

const pista = () => ' Solo Bash (PowerShell se niega). Programas por su nombre exacto: playwright-cli, npx, git, git.exe, curl, curl.exe (nunca .cmd/.bat/.ps1 ni rutas). Ningún argumento empieza por «/» ni lleva «=/», «X:/», & | < > ( ) ^ % ni comillas dobles (salvo el --config de confianza y las 5 expresiones de eval). Formas permitidas: playwright-cli -s=uaeh-<repo>-<AAAAMMDD-HHMM> [--json] <subcomando> con subcomandos open|close|goto|go-back|go-forward|reload|resize|snapshot|screenshot|console|requests|eval|tab-list|tab-select|tab-close|tab-new|set-reduced-motion (URLs solo http(s)://localhost|127.0.0.1|[::1] o about:blank, con comillas simples si llevan [ ] ? #; open exige --config=<una configuración de confianza: ' + configsLegibles() + '>; opciones con valor como --opcion=valor; capturas con --filename=reports/visual-audit/…; eval solo con las expresiones de medición de la lista cerrada), npx --no-install playwright test [--config=playwright.visual.config.ts] [--project= --grep= --grep-invert= --reporter= --workers= --retries= --max-failures= --timeout= --list --quiet --forbid-only] [rutas relativas] (sin --output/-o), npx --yes lighthouse@13.5.0 <url local> --output=json|html --output-path=reports/visual-audit/… [--chrome-flags=--headless=new], git status|diff|log|show|rev-parse|ls-files (sin rev:ruta), curl -sI http://127.0.0.1:PUERTO. Sin barra invertida, sin comodines (* ? [ ] ~ # !), sin $ ni comillas dentro de un argumento; rutas con /.';
// Expresiones de eval permitidas (comparación exacta tras normalizar espacios y quitar comillas envolventes).
const EVAL_OK = new Set([
  '() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]',
  '() => getComputedStyle(document.body).fontFamily',
  "() => getComputedStyle(document.querySelector('h1')).fontFamily",
  '() => document.documentElement.lang',
  "() => matchMedia('(prefers-reduced-motion: reduce)').matches",
]);
// cwd contra el que se resuelven las rutas de evidencia (lo fija la entrada del hook).
let CWD = process.cwd();

// Lista CERRADA: solo subcomandos que no interactúan con la página (nombres comprobados contra
// «playwright-cli --help»). Todo lo demás (click, fill, type, press, hover, drag, select, check, upload,
// request, route*, cookie*, *storage*, state-*, pdf, run-code, find, delete-data…) se niega.
const SUB_OK = new Set('open close goto go-back go-forward reload resize snapshot screenshot console requests eval tab-list tab-select tab-close tab-new set-reduced-motion'.split(' '));

// Nombres de programa aceptados (exactos, sensibles a mayúsculas: fallar cerrado).
const PROGRAMAS = new Set(['playwright-cli', 'npx', 'git', 'git.exe', 'curl', 'curl.exe']);
// Sesiones del verificador: solo las propias (R3-1/SEC-013), para no tocar las sesiones de otros agentes.
const SESION_RE = /^uaeh-[a-z0-9][a-z0-9-]{0,62}$/;

class Denegar extends Error {}
const no = (m) => { throw new Denegar(m); };

// ---- utilidades -----------------------------------------------------------------------------

// Tokeniza con la gramática de BASH, estricta (la única que acepta este hook). Lo que el hook no puede
// modelar con certeza se NIEGA en vez de interpretarse:
//   - «\» en cualquier posición (Bash lo usa de escape dentro y fuera de comillas; no se modela).
//   - $ ` ^ % salto de línea y caracteres de control, en TODAS partes (expansión de variables/comandos).
//   - fuera de comillas: ; & | < > ( ) { } (encadenar/redirigir/agrupar) y * ? [ ] ~ # ! (comodines,
//     tilde, comentario, historia). Dentro de comillas son literales (p. ej. "() => x" en eval).
// Comillas simples: literal hasta la siguiente '. Comillas dobles: literal hasta la siguiente ".
function tokenizar(cmd) {
  const toks = [];
  let cur = '', has = false, q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\n' || c === '\r') no('Salto de línea no permitido (no se encadenan comandos).');
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(c)) no('Carácter de control no permitido.');
    if (c === '\\') no('La barra invertida «\\» no está permitida (usa rutas con «/» y comillas simples).');
    if ('`$^%'.includes(c)) no(`El carácter «${c}» no está permitido (sin variables ni expansión).`);
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') { if (c === '"') q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (';&|<>'.includes(c)) no(`El carácter «${c}» no está permitido (sin encadenar ni redirigir).`);
    if ('(){}'.includes(c)) no(`El carácter «${c}» no está permitido fuera de comillas.`);
    if ('*?[]~#!'.includes(c)) no(`El carácter «${c}» no está permitido fuera de comillas (comodines, tilde, comentario o historia de Bash): ponlo entre comillas simples.`);
    if (c === ' ' || c === '\t') { if (cur || has) { toks.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (q) no('Comillas sin cerrar.');
  if (cur || has) toks.push(cur);
  return toks;
}

const esUrlWeb = (t) => /^https?:\/\/[^\s]+$/i.test(t);
const esUrlNav = (t) => /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[\/?#][^\s]*)?$/i.test(t) || t === 'about:blank';
const esUrlLocal = (t) => /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s]*)?$/i.test(t);
const normEval = (x) => String(x).replace(/\s+/g, ' ').trim();
const digitos = (t) => /^\d+$/.test(t || '');

// Ruta relativa dentro de reports/visual-audit/ con extensión permitida.
function rutaEvidencia(val, exts, que) {
  const v = String(val).replace(/\\/g, '/');
  if (!v) no(`${que} vacío.`);
  if (v.includes(':') || v.startsWith('/')) no(`${que} debe ser ruta relativa (sin «:» ni «/» inicial).`);
  if (v.split('/').includes('..')) no(`${que} no puede contener «..».`);
  if (!/^[A-Za-z0-9._\/ -]+$/.test(v)) no(`${que} con caracteres no permitidos.`);
  if (!v.startsWith(CARPETA) || v.length === CARPETA.length) no(`${que} debe estar dentro de ${CARPETA}.`);
  const m = /\.([A-Za-z0-9]+)$/.exec(v);
  if (!m || !exts.includes(m[1].toLowerCase())) no(`${que} debe terminar en .${exts.join('|.')}.`);
  sinEnlaces(v, que);
}

// Recorre desde el cwd los componentes que YA existan: enlace simbólico o junction = negado; un error
// distinto de «no existe» también niega (falla cerrado).
function sinEnlaces(v, que) {
  let cur = CWD;
  for (const p of v.split('/')) {
    if (!p || p === '.') continue;
    cur = path.join(cur, p);
    let st;
    try { st = fs.lstatSync(cur); }
    catch (e) {
      if (e && e.code === 'ENOENT') return; // lo que sigue tampoco existe
      no(`${que}: no se pudo comprobar «${p}» (¿enlace o permisos?).`);
    }
    if (st.isSymbolicLink()) no(`${que} pasa por un enlace simbólico o junction («${p}»).`);
  }
}

// Separa "--nombre=valor" → [nombre, valor|null]
function opcion(t) {
  const i = t.indexOf('=');
  return i < 0 ? [t, null] : [t.slice(0, i), t.slice(i + 1)];
}

// SEC-001/002 (revisión de D6): el CLI convierte una opción repetida en lista y la reenvía unida con comas
// («--config=a --config=b» llega como «a,b»); el candado no razona sobre esa forma, así que una opción repetida se niega.
function sinRepetidas(tokens, donde) {
  const vistas = new Set();
  for (const a of tokens) {
    if (!a.startsWith('-')) continue;
    const [n] = opcion(a);
    if (vistas.has(n)) no(`Opción «${n}» repetida en ${donde} (el programa uniría los valores con comas y el candado no los revisaría juntos).`);
    vistas.add(n);
  }
}

// ---- playwright-cli -------------------------------------------------------------------------

function revisarPlaywrightCli(t) {
  let i = 1;
  // solos: --help [cmd] y --version
  if (t[1] === '--version' && t.length === 2) return;
  if (t[1] === '--help') {
    if (t.length > 3 || (t[2] !== undefined && !/^[a-z-]{1,40}$/.test(t[2]))) no('--help solo admite un nombre de comando.');
    return;
  }
  // globales antes del subcomando
  let sesiones = 0;
  for (; i < t.length && t[i].startsWith('-'); i++) {
    if (t[i] === '--json' || t[i] === '--raw') continue;
    if (t[i].startsWith('-s=') || t[i].startsWith('--session=')) {
      if (!SESION_RE.test(t[i].slice(t[i].indexOf('=') + 1))) no('El verificador solo usa sus propias sesiones uaeh-… (nombre ^uaeh-[a-z0-9][a-z0-9-]{0,62}$, minúsculas).');
      if (++sesiones > 1) no('Una sola opción de sesión (-s= o --session=).');
      continue;
    }
    if (t[i] === '-s' || t[i] === '--session') no('La sesión se pasa como -s=<nombre> (forma con =).');
    no(`Opción global «${t[i]}» no permitida.`);
  }
  if (!sesiones) no('El verificador solo usa sus propias sesiones uaeh-…: todo comando de playwright-cli lleva -s=uaeh-<repo>-<AAAAMMDD-HHMM> (o --session=…), también close.');
  const sub = t[i];
  if (!sub) no('Falta el subcomando de playwright-cli.');
  const args = t.slice(i + 1);
  sinRepetidas(t.slice(1, i), 'las opciones globales de playwright-cli');
  sinRepetidas(args, `«${sub}»`);
  if (!SUB_OK.has(sub)) no(`Subcomando «${sub}» de playwright-cli fuera de la lista cerrada del verificador de navegador (solo los que no interactúan con la página).`);

  if (sub === 'open') return revisarOpen(args);
  if (sub === 'screenshot') return revisarConFilename(args, { sub, filenameObligatorio: true, exts: ['png', 'jpg', 'jpeg', 'webp'], opts: { '--full-page': null, '--hires': null, '--type': /^(png|jpeg|webp)$/ }, maxPos: 1 });
  if (sub === 'snapshot') return revisarConFilename(args, { sub, exts: ['yml', 'yaml', 'md'], opts: { '--depth': /^\d+$/, '--boxes': null }, maxPos: 1 });
  if (sub === 'eval') return revisarEval(args);

  // resto: sin opciones; posicionales con forma fija
  for (const a of args) {
    if (a.startsWith('-')) no(`Opción «${a}» no permitida en «${sub}».`);
  }
  const sinArgs = () => { if (args.length) no(`«${sub}» no admite argumentos.`); };
  switch (sub) {
    case 'close': case 'go-back': case 'go-forward': case 'reload': case 'tab-list': return sinArgs();
    case 'resize':
      if (args.length !== 2 || !args.every((a) => /^\d{1,5}$/.test(a))) no('resize exige <ancho> <alto> numéricos.');
      return;
    case 'goto':
      if (args.length !== 1 || !esUrlNav(args[0])) no('goto exige UNA URL http(s)://localhost, 127.0.0.1 o [::1] (o about:blank): navegar a otro host está prohibido.');
      return;
    case 'tab-new':
      if (args.length > 1 || (args.length === 1 && !esUrlNav(args[0]))) no('tab-new admite una URL http(s)://localhost, 127.0.0.1 o [::1] (o about:blank): navegar a otro host está prohibido.');
      return;
    case 'tab-select':
      if (args.length !== 1 || !/^\d{1,3}$/.test(args[0])) no('tab-select exige un índice numérico.');
      return;
    case 'tab-close':
      if (args.length > 1 || (args.length === 1 && !/^\d{1,3}$/.test(args[0]))) no('tab-close admite un índice numérico.');
      return;
    case 'console':
      if (args.length > 1 || (args.length === 1 && !/^[a-z]{1,10}$/.test(args[0]))) no('console admite un nivel mínimo (letras).');
      return;
    case 'requests': return sinArgs();
    case 'set-reduced-motion':
      if (args.length !== 1 || !/^(reduce|no-preference)$/.test(args[0])) no('set-reduced-motion exige reduce o no-preference.');
      return;
    default: no(`Subcomando «${sub}» sin regla de argumentos.`);
  }
}

function revisarOpen(args) {
  const mcp = Object.keys(process.env).find((k) => /^PLAYWRIGHT_MCP_/i.test(k));
  if (mcp) no('open se niega con variables PLAYWRIGHT_MCP_* en el entorno (mezclarían perfil/endpoint bajo la config de confianza).');
  if (Object.keys(process.env).some((k) => /^PWTEST_CLI_GLOBAL_CONFIG$/i.test(k))) no('open se niega con la variable PWTEST_CLI_GLOBAL_CONFIG en el entorno (cargaría otra config global junto a la de confianza).');
  const casa = process.env.USERPROFILE || os.homedir();
  let hay = false;
  try { hay = fs.existsSync(path.join(casa, '.playwright', 'cli.config.json')); } catch { hay = true; }
  if (hay) no('open se niega mientras exista ~/.playwright/cli.config.json (se fusionaría con la config de confianza).');
  let config = null, urls = 0;
  const enums = { '--browser': /^(chrome|msedge|firefox|webkit)$/, '--idle-timeout': /^\d+$/, '--device': /^[\w .()-]{1,64}$/ };
  for (const a of args) {
    if (a.startsWith('--')) {
      const [n, v] = opcion(a);
      if (n === '--config') {
        if (v === null) no('Usa --config=<ruta> (forma con =, no con espacio).');
        config = v;
      } else if (n === '--headed' || n === '--mobile') {
        if (v !== null) no(`«${n}» no lleva valor.`);
      } else if (enums[n]) {
        if (v === null) no(`Usa ${n}=<valor> (forma con =, no con espacio).`);
        if (!enums[n].test(v)) no(`Valor inválido en «${n}».`);
      } else no(`Opción «${n}» no permitida en open.`);
    } else if (a.startsWith('-')) {
      no(`Opción «${a}» no permitida en open.`);
    } else {
      if (!esUrlNav(a)) no('La URL de open debe ser http(s)://localhost, 127.0.0.1 o [::1] (o about:blank): navegar a otro host está prohibido.');
      if (++urls > 1) no('open admite una sola URL.');
    }
  }
  if (config === null) no('open exige --config= con la configuración de uaeh (sin ella el CLI carga la del repo).');
  if (!esConfigDeConfianza(config)) no(`--config debe ser exactamente una configuración de confianza: ${configsLegibles()}.`);
}

// eval: UNA expresión de la lista cerrada EVAL_OK (+ --filename opcional a reports/visual-audit/).
function revisarEval(args) {
  let expr = null;
  for (const a of args) {
    if (a.startsWith('--')) {
      const [n, v] = opcion(a);
      if (n !== '--filename' || v === null) no('eval solo admite --filename=<ruta> (forma con =).');
      rutaEvidencia(v, ['json', 'txt'], '--filename');
    } else if (a.startsWith('-')) {
      no(`Opción «${a}» no permitida en eval.`);
    } else {
      if (expr !== null) no('eval admite una sola expresión (sin referencia de elemento).');
      expr = a;
    }
  }
  if (expr === null) no('eval exige una expresión de la lista cerrada.');
  const e = normEval(expr);
  if (!EVAL_OK.has(e)) no('eval solo admite las expresiones de medición de la lista cerrada (scrollWidth/clientWidth, fontFamily del body o h1, documentElement.lang, prefers-reduced-motion).');
}

// screenshot / snapshot / find: solo opciones de la tabla + --filename con regla de carpeta.
function revisarConFilename(args, { sub, filenameObligatorio, exts, opts, maxPos }) {
  let tieneFile = false, pos = 0;
  for (const a of args) {
    if (a.startsWith('--')) {
      const [n, v] = opcion(a);
      if (n === '--filename') {
        if (v === null) no('Usa --filename=<ruta> (forma con =, no con espacio).');
        rutaEvidencia(v, exts, '--filename');
        tieneFile = true;
      } else if (Object.prototype.hasOwnProperty.call(opts, n)) {
        const re = opts[n];
        if (re === null ? v !== null : (v === null || !re.test(v))) no(`Valor inválido en «${n}».`);
      } else no(`Opción «${n}» no permitida en «${sub}».`);
    } else if (/^-[^\d]/.test(a)) {
      no(`Opción «${a}» no permitida en «${sub}».`);
    } else {
      if (maxPos !== undefined && ++pos > maxPos) no(`«${sub}» admite como mucho ${maxPos} argumento posicional.`);
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(a)) no(`Referencia de elemento «${a.slice(0, 40)}» inválida en «${sub}» (usa la ref del snapshot, p. ej. e12).`);
    }
  }
  if (filenameObligatorio && !tieneFile) no(`«${sub}» exige --filename=${CARPETA}… (la evidencia debe quedar ahí).`);
}

// ---- npx ------------------------------------------------------------------------------------

function revisarNpx(t) {
  let i = 1;
  if (t[i] === '--no-install' || t[i] === '--no') i++;
  else if (t[i] === '--yes') {
    // única forma con --yes: lighthouse@13.5.0 exacto
    if (t[i + 1] !== 'lighthouse@13.5.0') no('Con --yes solo se permite lighthouse@13.5.0 (versión exacta).');
    return revisarLighthouse(t.slice(i + 2));
  }
  else if (t[i] === 'playwright') no('Usa «npx --no-install playwright …»: sin --no-install npx puede descargar paquetes.');
  if (t[i] !== 'playwright') no('npx solo admite playwright test, playwright --version y lighthouse@13.5.0.');
  if (t[i + 1] === '--version' && t.length === i + 2) return;
  if (t[i + 1] !== 'test') no('De npx playwright solo se permite «test» y «--version».');
  const CONFIG_RE = /^(\.\/)?playwright(\.[a-z0-9-]+)?\.config\.(ts|js|mjs|cjs)$/;
  const config = (v) => {
    if (v === null || v === undefined || !CONFIG_RE.test(v)) no('--config/-c solo con ruta relativa tipo playwright.visual.config.ts (sin «..», unidad ni «/» inicial).');
  };
  // Opciones largas en lista BLANCA. null = booleana (sin valor); RegExp = valor obligatorio con forma =.
  const REPORTERS = /^(list|line|dot|json|junit|null)(,(list|line|dot|json|junit|null))*$/;
  const LARGAS = {
    '--project': /^[A-Za-z0-9_. -]{1,64}$/,
    '--grep': /^.{1,200}$/, '--grep-invert': /^.{1,200}$/,
    '--reporter': REPORTERS,
    '--workers': /^\d{1,3}$/, '--retries': /^\d{1,3}$/, '--max-failures': /^\d{1,5}$/, '--timeout': /^\d{1,9}$/,
    '--list': null, '--quiet': null, '--forbid-only': null,
  };
  // Posicional (archivo/filtro de prueba): ruta relativa sin «..», sin unidad ni «/» inicial.
  const posicional = (p) => {
    if (!/^[A-Za-z0-9_.\/-]{1,200}$/.test(p) || p.startsWith('/') || p.split('/').includes('..')) no(`Argumento «${p.slice(0, 40)}» no permitido en playwright test (solo rutas relativas sin «..», unidad ni «/» inicial).`);
  };
  const rest = t.slice(i + 2);
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    const [n, v] = opcion(a);
    if (a === '--') no('«--» no permitido en playwright test.');
    if (a === '-u' || n === '--update-snapshots' || n === '--update-source-method' || n === '--ui' || n === '--debug' || /^--ui-/.test(n)) {
      no(`«${a}» no permitido en playwright test (no actualizar capturas ni abrir UI/depurador).`);
    }
    if (/^--output/.test(n)) no(`«${a}» no permitido en playwright test (cambia dónde se escriben los resultados).`);
    if (n === '--pass-with-no-tests') no('--pass-with-no-tests no permitido (oculta que hubo 0 pruebas: UNKNOWN no es PASS).');
    if (n === '--config') { config(v !== null ? v : rest[++k]); continue; }
    if (a.startsWith('--')) {
      if (!Object.prototype.hasOwnProperty.call(LARGAS, n)) no(`Opción «${n}» fuera de la lista blanca de playwright test.`);
      const re = LARGAS[n];
      if (re === null ? v !== null : (v === null || !re.test(v))) no(`Valor inválido en «${n}» (forma ${re === null ? n : n + '=<valor>'}).`);
      continue;
    }
    if (a.startsWith('-')) {
      // cortas: x/h booleanas (se pueden agrupar); g/j llevan valor; c es config (pegada o en el siguiente token)
      if (/^-\d/.test(a)) no(`Opción «${a}» no permitida en playwright test.`);
      const valorCorto = (val, re) => { if (val === undefined || !re.test(val)) no('Valor de opción corta inválido en playwright test.'); };
      for (let c = 1; c < a.length; c++) {
        const ch = a[c];
        if (ch === 'x' || ch === 'h') continue;
        if (ch === 'g') { valorCorto(c < a.length - 1 ? a.slice(c + 1) : rest[++k], /^[^-].{0,199}$/); break; }
        if (ch === 'j') { valorCorto(c < a.length - 1 ? a.slice(c + 1) : rest[++k], /^\d{1,3}$/); break; }
        if (ch === 'c') { config(c < a.length - 1 ? a.slice(c + 1) : rest[++k]); break; }
        no(`Opción corta «-${ch}» no permitida en playwright test (ni -o ni -u).`);
      }
      continue;
    }
    posicional(a);
  }
}

function revisarLighthouse(args) {
  if (!args.length || !esUrlNav(args[0]) || args[0] === 'about:blank') no('lighthouse exige una URL local (http(s)://localhost, 127.0.0.1 o [::1]) como primer argumento.');
  let salida = false;
  sinRepetidas(args.slice(1), 'lighthouse');
  for (const a of args.slice(1)) {
    if (!a.startsWith('--')) no(`Argumento «${a}» no permitido en lighthouse.`);
    const [n, v] = opcion(a);
    const vs = v === null ? '' : v;
    switch (n) {
      case '--output': if (!/^(json|html)$/.test(vs)) no('--output=json|html.'); break;
      case '--output-path': rutaEvidencia(vs, ['json', 'html'], '--output-path'); salida = true; break;
      case '--only-categories': if (!/^[a-z-]+(,[a-z-]+)*$/.test(vs)) no('--only-categories=<lista>.'); break;
      case '--form-factor': if (!/^(mobile|desktop)$/.test(vs)) no('--form-factor=mobile|desktop.'); break; // uaeh-lint: permitir (valor de Lighthouse)
      case '--preset': if (!/^(desktop|perf|experimental)$/.test(vs)) no('--preset=desktop|perf|experimental.'); break; // uaeh-lint: permitir (valor de Lighthouse)
      case '--throttling-method': if (!/^(simulate|devtools|provided)$/.test(vs)) no('--throttling-method=simulate|devtools|provided.'); break;
      case '--max-wait-for-load': if (!digitos(vs)) no('--max-wait-for-load=<dígitos>.'); break;
      case '--chrome-flags': {
        if (vs.trim() !== '--headless=new') no('--chrome-flags solo con el valor exacto --headless=new.');
        break;
      }
      case '--screenEmulation.disabled': case '--quiet': if (v !== null) no(`«${n}» no lleva valor.`); break;
      default: no(`Opción «${n}» no permitida en lighthouse.`);
    }
  }
  if (!salida) no('lighthouse exige --output-path=reports/visual-audit/…(.json|.html) (el reporte por defecto cae fuera de la carpeta de evidencia).');
}

// ---- git ------------------------------------------------------------------------------------

function revisarGit(t) {
  if (!['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files'].includes(t[1])) {
    no('git solo admite status, diff, log, show, rev-parse y ls-files (sin opciones globales como -C o -c).');
  }
  for (const a of t.slice(2)) {
    const [n] = opcion(a);
    // abreviaturas únicas: git acepta --ext, --textc… como prefijo de --ext-diff / --textconv
    const prefijo = (largo, min) => n.length >= min && largo.startsWith(n);
    if (/^--out/.test(n) || prefijo('--ext-diff', 5) || prefijo('--textconv', 7) || n === '--no-index' || /^-o/.test(a)) no(`«${a}» no permitido en git (escribe archivos, ejecuta programas o lee fuera del repo).`);
    // <rev>:<ruta> (y :ruta) leen contenido arbitrario del repo/índice
    if (!a.startsWith('-') && a.includes(':')) no(`«${a.slice(0, 40)}» no permitido en git (argumentos rev:ruta).`);
  }
}

// ---- curl ---------------------------------------------------------------

function revisarCurl(t) {
  let head = false, urls = 0;
  const CORTAS = new Set(['-s', '-S', '-sS', '-Ss']);
  const HEAD = new Set(['-I', '-sI', '-Is', '-sSI', '--head']);
  for (let i = 1; i < t.length; i++) {
    const a = t[i];
    if (HEAD.has(a)) head = true;
    else if (CORTAS.has(a)) continue;
    else if (a === '-m') { if (!digitos(t[++i])) no('-m exige un número de segundos.'); }
    else if (/^--max-time=\d+$/.test(a)) continue;
    else if (esUrlLocal(a)) { if (++urls > 1) no('curl admite una sola URL.'); }
    else if (/^(--location(-trusted)?|--max-redirs(=.*)?)$/.test(a) || /^-[A-Za-z]*L/.test(a)) no('curl no puede seguir redirecciones (-L/--location): podrían llevar a otro host.');
    else no(`Argumento «${a}» no permitido en curl (solo localhost/127.0.0.1/[::1] con -I).`);
  }
  if (!head) no('curl debe usar -I / --head (solo comprobar que la app responde).');
  if (urls !== 1) no('curl necesita una URL http://localhost[:puerto][/ruta].');
}

// ---- principal ------------------------------------------------------------------------------

function revisar(cmd, herramienta) {
  if (String(herramienta || '').toLowerCase() === 'powershell') no('el verificador de navegador usa solo Bash (la gramática de PowerShell no se modela); reescribe el comando en forma Bash.');
  const t = tokenizar(cmd);
  if (!t.length) no('Comando vacío.');
  // Ningún token resuelto lleva comillas (una comilla residual delata un escape mal leído), salvo las
  // expresiones de eval de la lista cerrada, que llevan 'h1' / '(prefers…)' entre comillas dobles.
  // SEC-010: SOLO estos nombres exactos (sin .cmd/.bat/.ps1, sin ruta, sin sufijo ni cambio de mayúsculas):
  // un .cmd se ejecuta vía cmd.exe, que vuelve a cortar la línea (un «&» entre comillas simples de Bash
  // llegaría sin protección). Los nombres sin extensión los resuelve Git Bash a un script sh o a un .exe.
  const prog = t[0];
  if (!PROGRAMAS.has(prog)) no(`«${t[0].slice(0, 40)}» no está en la lista de comandos del verificador de navegador (nombres exactos: playwright-cli, npx, git, git.exe, curl, curl.exe; nunca .cmd/.bat/.ps1, rutas ni otras mayúsculas).`);
  for (const x of t) {
    const esEval = prog === 'playwright-cli' && EVAL_OK.has(normEval(x));
    if (x.startsWith('@')) no('Un argumento empieza por «@» (splatting/expansión de otro shell): no permitido.');
    if (/["']/.test(x) && !esEval) no('Un argumento contiene comillas tras resolver el comando (no permitido).');
    // Defensa en profundidad (SEC-010): ningún token resuelto lleva metacaracteres de cmd.exe/shell.
    if (/[&|<>()^%"]/.test(x) && !esEval) no('Un argumento contiene & | < > ( ) ^ % o comillas dobles (metacaracteres de cmd.exe/shell): no permitido.');
    // SEC-012: Git Bash reescribe a ruta de Windows lo que empieza por «/», lleva «=/» o «X:/» (letra suelta).
    // Única excepción: el --config de confianza de «open» (ver configsDeConfianza()).
    if (prog === 'playwright-cli' && x.startsWith('--config=') && esConfigDeConfianza(x.slice('--config='.length))) continue; // fuera de open lo niega su propia regla
    // Completo (ronda 6): también «-g/c/x» (opción corta pegada a una ruta) y cualquier «:/» que no sea parte de «://».
    if (x.startsWith('/') || x.includes('=/') || /(^|[^A-Za-z])[A-Za-z]:\//.test(x) || /^-[A-Za-z]+\//.test(x) || /:\//.test(x.replace(/https?:\/\//gi, ''))) no(`El argumento «${x.slice(0, 40)}» empieza por «/», lleva «=/», «:/» o una opción corta pegada a «/»: Git Bash lo convertiría en una ruta de Windows. Usa rutas relativas.`);
  }
  switch (prog) {
    case 'playwright-cli': return revisarPlaywrightCli(t);
    case 'npx': return revisarNpx(t);
    case 'git': case 'git.exe': return revisarGit(t);
    case 'curl': case 'curl.exe': return revisarCurl(t);
    default: no('Programa fuera de la lista.');
  }
}

function denegar(razon) {
  let extra = '';
  try { extra = pista(); } catch { /* sin pista: la negativa vale igual */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Verificador de navegador (lista blanca): ${razon}${extra}` } }));
  process.exit(0);
}

// Sale 0 sin decidir; el aviso (si hay) va a stderr con escritura síncrona para que process.exit no lo corte.
function noAplica(aviso) {
  if (aviso) { try { fs.writeSync(2, 'solo-navegador: ' + aviso + '\n'); } catch { /* sin stderr: el aviso se pierde */ } }
  process.exit(0);
}

// ---- Arranque: dos tramos con política de fallo distinta (como solo-lectura.js) ----
// 1) ¿Quién ejecuta? Si no se puede saber (stdin ilegible, módulo de identidad que no carga) o el candado no aplica a ese
//    agente (sesión principal, agente no listado, candados.json ilegible), sale en silencio: fail-open por identidad
//    desconocida (decisión de diseño, documentada en la cabecera).
// 2) Para el agente listado rige la lista blanca, que FALLA CERRADO.
function principal() {
  let entrada;
  try { entrada = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return noAplica('stdin no es un JSON legible: no se sabe quién ejecuta y el candado no aplica'); }
  let id;
  try { id = require(path.join(__dirname, '_identidad.js')).evaluar('solo-navegador', entrada); } catch {
    id = { aplica: false, aviso: 'no se pudo cargar hooks/_identidad.js: no se sabe quién ejecuta y el candado no aplica' };
  }
  if (!id.aplica) return noAplica(id.aviso);
  try {
    const cmd = entrada.tool_input && entrada.tool_input.command;
    if (typeof cmd !== 'string' || !cmd.trim()) denegar('no hay comando que evaluar.');
    if (typeof entrada.cwd === 'string' && path.isAbsolute(entrada.cwd)) CWD = entrada.cwd;
    revisar(cmd, entrada.tool_name);
    process.exit(0);
  } catch (e) {
    denegar(e instanceof Denegar ? e.message : 'error interno al evaluar el comando.');
  }
}

// Exportado para la prueba de PARIDAD con bash real; al ejecutarse como hook corre principal().
module.exports = { tokenizar, revisar, Denegar, configsDeConfianza };
if (require.main === module) principal();
