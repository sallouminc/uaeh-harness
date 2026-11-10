#!/usr/bin/env node
// UAEH — sello de integridad de los revisores (capa 2 del arnés de verificación; ciclo 7 de endurecimiento).
// Un revisor (verificador, auditor) no puede aprobar algo que él mismo cambió: se mide el repo y el arnés ANTES y
// DESPUÉS de su revisión y, si algo cambió, su veredicto queda ANULADO. No adivina comandos: mide el resultado, así
// que no depende de cómo corte los argumentos cada shell (la clase que dejaba evadir los filtros por texto).
// Regla de diseño: «no pude medir» = DESCONOCIDO, nunca INTACTO (UNKNOWN ≠ PASS).
//
// CLI:
//   node uaeh-integridad.cjs foto <repo> [--etiqueta <texto>]  → imprime el id            (0) | DESCONOCIDO (4)
//   node uaeh-integridad.cjs comparar <id> [<repo>]             → INTACTO (0) | ROTA (3)   | DESCONOCIDO (4)
//   node uaeh-integridad.cjs hook-inicio    (SubagentStart, JSON por stdin; nunca bloquea)
//   node uaeh-integridad.cjs hook-fin       (SubagentStop,  JSON por stdin; si está ROTA o no se pudo comprobar,
//                                            obliga a reportar BLOCKED / UNKNOWN)
//
// QUÉ MIDE (bytes crudos, hash por streaming, sin tope de tamaño):
//  - HEAD y rama actual (NO ramas, etiquetas ni stash: los mueven otros worktrees sin tocar el código; un stash que
//    altera el working tree se ve por los archivos).
//  - TODOS los archivos rastreados (git ls-files), por sus bytes del working tree, diga lo que diga `git status`
//    (cubre assume-unchanged, skip-worktree y filtros clean); el índice (ls-files -s) y las banderas (ls-files -v).
//  - TODOS los no rastreados y no ignorados (salvo evidencia nueva de los revisores: archivos NO rastreados con
//    extensión de evidencia bajo reports/visual-audit, test-results, playwright-report, blob-report o .playwright-cli,
//    a cualquier profundidad y que no sean pruebas; los RASTREADOS en esas carpetas sí cuentan).
//  - Ignorados que son ENTRADAS, a cualquier profundidad (ciclo 3, A3/A8): .env*, .npmrc y todo lo que cuelgue de una
//    carpeta .claude/ o .codex/ (excluye node_modules/, .git/ y .claude/worktrees/), y además todo archivo ignorado
//    que parezca código, configuración o credencial: por extensión (py js mjs cjs ts tsx jsx sh bash ps1 psm1 bat cmd
//    json jsonc yaml yml toml ini cfg conf properties plist xml gradle kts dart php rb go rs java kt swift sql pem key
//    keystore jks p12 pfx crt cer) o por nombre (CLAUDE.md, AGENTS.md, google-services.json, GoogleService-Info.plist,
//    .dev.vars, .yarnrc*, .pypirc, *.local.*). Los ignorados con OTRAS extensiones (logs, imágenes, datos) no se miden.
//  - PODA (ciclo 4, A14/A16/A17): el recorrido de ignorados NO ENTRA en las carpetas de dependencias o salidas: se podan
//    completas, también para .env*/.npmrc (un .env dentro de build/, .venv/ o vendor/ es copia o dependencia; no se mide).
//    Excepción: lo que cuelga de .claude/ y .codex/ se sigue midiendo (fuera de esas carpetas podadas).
//    CARPETAS PODADAS (lista completa, a cualquier profundidad):
//      node_modules .next .nuxt .output .svelte-kit dist build out coverage .turbo .vercel .parcel-cache .cache .venv venv
//      __pycache__ .pytest_cache .mypy_cache .ruff_cache pods .gradle target .dart_tool .expo vendor bower_components
//      www .angular output .nx .astro .wrangler storybook-static .docusaurus test-results playwright-report blob-report
//      .playwright-cli .nyc_output .tox .nox .idea .gradle-cache .hypothesis .eggs
//    FIN DE LA LISTA. Además se podan los pares reports/visual-audit, .yarn/cache y .yarn/unplugged, y CUALQUIER carpeta
//    que contenga pyvenv.cfg (un venv, aunque se llame .env o env; también dentro de .claude/: se poda completa).
//    Ciclo 5: NO se podan `.playwright` (playwright-cli carga .playwright/cli.config.json), `env` (un env/.env.local es
//    entrada), `.yarn` entero (.yarn/plugins y .yarn/releases son código) ni `.auth/` (un .auth/user.json regenerado da
//    ROTA: lado seguro). Residual (Codex SEC-003): un archivo de configuración ignorado DENTRO de una carpeta podada (p. ej.
//    www/config.php) no se mide.
//    EXCLUIDOS POR NOMBRE de la medición de ignorados (salidas de sesión y reportes del revisor):
//      *storage-state*.json auth-state*.json junit*.xml coverage*.xml test-report*.xml
//    FIN DE LA LISTA DE NOMBRES.
//    Una carpeta ignorada con .git propio (o con .git vacío o de archivo) se recorre igual (si no está podada): solo se
//    salta un repo anidado que ya se mide recursivamente. Más de 5 000 → DESCONOCIDO.
//  - Submódulos (gitlinks) y repos anidados (con .git propio), recursivamente (profundidad ≤ 3).
//  - Configuración efectiva de git (git config --list --show-origin --show-scope: sistema, global, include,
//    config.worktree), core.excludesFile, core.attributesFile (y sus valores por defecto), core.hooksPath externo,
//    .git/config y, RECURSIVAMENTE (con auxiliares en subcarpetas), .git/hooks, .git/info y el core.hooksPath externo.
//    Una carpeta nunca es un valor «medido»: donde se esperaba un archivo es error.
//  - El arnés (lista por defecto). Las rutas salen de claudeHome() = CLAUDE_CONFIG_DIR o ~/.claude, codexHome() =
//    CODEX_HOME o ~/.codex y uaehHome() = UAEH_HOME o <claudeHome>/uaeh (espejo de ruta fija = <uaehHome>/estable).
//    De <claudeHome>: settings.json, settings.local.json y CLAUDE.md; hooks/ (recursivo: .js .cjs .mjs .json, sin
//    node_modules); agents/*.md; scripts/uaeh-*.cjs; git-hooks/** (recursivo) y TODOS los archivos de skills/uae-* (sin
//    __pycache__ ni node_modules). De <codexHome>: config.toml, *.config.toml, AGENTS.md y agents/*.toml. Además, SIEMPRE:
//    la RAÍZ DE ESTE PLUGIN completa (recursiva: scripts, hooks, agentes, skills, plantillas, vendor/…; en una instalación
//    real vive bajo <claudeHome>/plugins/cache/…), el ESPEJO <uaehHome>/estable/** (recursivo) y lo que el usuario añada en
//    arnes.extra de uaeh.config.json (lista de [carpeta, patrón[, recursivo]]). Además CLAUDE.md / AGENTS.md de CADA
//    carpeta ancestro de la raíz del repo hasta la raíz del disco (Claude Code los carga). NO se mide <uaehHome>/integridad/
//    (fotos y registro) ni nada de <uaehHome> fuera de estable/. En una carpeta de arnés NO recursiva, una carpeta cuyo
//    nombre coincide con el patrón del archivo esperado (p. ej. <codexHome>/config.toml/) es un error → DESCONOCIDO, nunca
//    se descarta. Una carpeta opcional que no existe (git-hooks/, skills/, el espejo…) se registra como ausente, sin
//    error; un arnes.extra mal formado en uaeh.config.json SÍ es un error (→ DESCONOCIDO): nunca se mide «menos» en silencio.
//  - Ciclo 5, A27: la guarda de git del arnés: <claudeHome>/git-hooks/** (recursivo; si no existe se registra como ausente)
//    y el VALOR efectivo del core.hooksPath GLOBAL (git config --global --get, respeta GIT_CONFIG_GLOBAL; sin valor =
//    «(sin valor)»; error de git = DESCONOCIDO). NO se mide el ~/.gitconfig completo.
//  - Enlaces simbólicos: destino textual + contenido del destino si es archivo.
//
// NORMALIZACIÓN (para no anular por fricción legítima):
//  - settings.local.json (de un .claude/ del repo o del arnés): se hashea el JSON canónico SIN permissions.allow ni
//    permissions.additionalDirectories (lo que escribe «aprobar»), y sin un `permissions` que quede vacío; si todo el
//    objeto queda `{}` vale lo mismo que un archivo AUSENTE (la primera aprobación crea el archivo). Si no es JSON
//    válido, bytes crudos. Un hook, un deny o cualquier otra clave agregada SÍ cuenta.
//  - config.toml de Codex (<codexHome>/config.toml): se hashea sin las tablas `projects`, `tui` y `notice` (y sus subtablas `projects.…`), que
//    Codex reescribe al abrir un repo. Reconoce encabezados REALES con un escáner (fuera de cadenas multilínea ''' y
//    """, con corchetes entre comillas, y por segmento exacto: `[tuiextra]` SÍ cuenta). Si no puede interpretar el
//    archivo con certeza (cadena sin cerrar, sintaxis rara) hashea los bytes completos. Ciclo 4, A12: dentro de una
//    tabla omitida solo se aceptan líneas vacías, comentarios y `clave = valor` (clave simple o entre comillas; valor
//    de UNA línea: booleano, número, cadena básica con escapes válidos, cadena literal o arreglo de una línea de esos
//    literales); cualquier otra cosa (p. ej. `hide = tru`, arreglos o tablas en línea multilínea) → bytes completos
//    (`toml-crudo:`). Ciclo 5, A24: en esas tablas, una tabla repetida (mismo encabezado), una clave repetida en la
//    misma tabla o un escape de Unicode (u minúscula o mayúscula) que no sea un escalar válido (> 10FFFF o D800-DFFF)
//    → bytes completos. Ciclo 6, A28: en esas tablas también → bytes completos (`toml-crudo:`) un encabezado `[[…]]`
//    (arreglo de tablas), un encabezado con escapes inválidos (`\ud800`, `\U00110000`, también dentro de
//    `[x."…"]`) y un choque clave/tabla (`[notice.hide]` cuando `[notice]` define `hide`, o al revés). Lo que Codex
//    escribe de verdad (`[projects.'ruta']`, `[tui]`, `[tui.model_availability_nux]`, `[notice.model_migrations]`)
//    sigue normalizándose. Ciclo 7, C6: fuera de su encabezado `[…]` normal, cualquier
//    forma que defina una tabla omitida (clave `projects`/`tui`/`notice` seguida de `.` o `=`: tabla en línea
//    `notice = { hide = false }` o clave con puntos `notice.hide = false`, en la raíz, en otra tabla o dentro de una
//    tabla en línea; también entre comillas) → bytes completos (`toml-crudo:`), en cualquier orden respecto de `[notice]`.
//    Residual: esas formas (y claves con punto en la raíz, p. ej. `projects.x.trust_level = …`) van a bytes completos.
//  - NO se normaliza (queda ROTA a propósito): next-env.d.ts rastreado, snapshots nuevos de vitest, cachés no
//    ignoradas.
//
// RESIDUAL DOCUMENTADO (lo que este sello NO garantiza):
//  - Compara DOS estados: cambiar y restaurar dentro de la misma revisión no se ve.
//  - En Claude detecta errores de los revisores, NO a un adversario con el mismo usuario que reescriba este script o
//    sustituya el comparador (para eso, la caja de arena de la capa 3).
//  - Exclusiones por nombre (`*storage-state*.json`, `auth-state*.json`): pueden ocultar un estado de sesión que las
//    pruebas CONSUMEN (se acepta: se regeneran en cada corrida). `.auth/` NO se poda.
//  - node_modules y salidas ignoradas (.next, dist, coverage) no se miden (ver CARPETAS PODADAS).
//  - <claudeHome>/plugins/** (cachés, instalaciones y marketplaces de OTROS plugins) y ~/.claude.json NO se miden por sí
//    solos: cambian solos sin intervención de nadie (medirlos rompería toda revisión). De esa zona solo se mide la raíz de
//    ESTE plugin y lo que se pida a propósito con UAEH_ARNES o arnes.extra: una entrada explícita del arnés, aunque cuelgue
//    de plugins/cache/…, no la poda ninguna regla (la poda de carpetas de salida solo afecta al recorrido de los
//    IGNORADOS dentro del repo revisado).
//  - Efectos fuera del repo (BD, push, red, servicios) no se miden.
//  - Las fotos de los hooks (agente-<id>) no llevan huella (el id lo pone Claude Code): los hooks son AVISO; manda el
//    comando del orquestador (foto/comparar con id con huella).
//  - Enlaces simbólicos a carpetas: solo se mide el destino textual (`enlace-dir:`), no su contenido.
//  - config.toml de Codex: ver arriba.
//  - Si la medición ACTUAL queda incompleta (presupuesto agotado, sección que no se pudo listar, tope superado), el
//    resultado es DESCONOCIDO aunque hubiera cambios medibles en el resto (decisión aceptada): una sección no medida
//    nunca se trata como un mapa vacío (daría cientos de «desapareció» y una ROTA falsa).
//  - `git ls-files -o` atraviesa junctions/enlaces a carpetas no rastreados y no ignorados: sobremide (da ROTA o
//    DESCONOCIDO, nunca un INTACTO falso). Lo no rastreado bajo `.claude/worktrees/` se excluye a propósito.
//
// ENTORNO (perillas; sirven para pruebas y para medir rendimiento):
//  - UAEH_ARNES (JSON [[carpeta, patrón[, recursivo]], …], no vacío) reemplaza la lista del arnés; UAEH_PRESUPUESTO_MS
//    cambia el presupuesto de tiempo (el CLI lo cuenta desde que arranca el proceso: git, raíz y anidados incluidos);
//    UAEH_TOPE_SENSIBLES cambia el tope de ignorados de entrada; UAEH_INTEGRIDAD_DIR la carpeta de fotos; UAEH_HOME la
//    carpeta base de <claudeHome>/uaeh. CLAUDE_CONFIG_DIR y CODEX_HOME (variables propias de Claude Code y de Codex, no
//    perillas de prueba) mueven la raíz de la lista del arnés por defecto. Quien controla el entorno del orquestador puede
//    REDUCIR lo medido: es el mismo residual del adversario con el mismo usuario (arriba). Por eso `foto` y `comparar`
//    dicen por stderr «perillas de prueba activas: <nombres>» cuando hay alguna.
//  - Identidad del revisor: los hooks comparan el nombre del agente SIN el prefijo del plugin (`uaeh-harness:uae-verifier`
//    es `uae-verifier`).
//  - Los hooks automáticos (hook-inicio / hook-fin) son AVISO: ante entrada ilegible o agente no revisor terminan en 0
//    sin hacer nada; manda el comando del orquestador. hook-fin busca primero la foto del agente (si existe la compara
//    aunque el cwd ya no sea resoluble) y ante cualquier excepción bloquea pidiendo UNKNOWN (nunca sale 4 con texto suelto).
// Sin dependencias (solo lib/comun.cjs y lib/config.cjs, del propio plugin). Nunca imprime contenidos: solo rutas y hashes.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
// Rutas de estado y hora: solo desde la biblioteca común del plugin (los scripts se localizan entre sí con __dirname,
// también cuando este archivo vive en el espejo de ruta fija junto a su lib/).
const comun = require(path.join(__dirname, 'lib', 'comun.cjs'));
const configArnes = require(path.join(__dirname, 'lib', 'config.cjs'));

const REVISORES = new Set(['uae-verifier', 'uae-security', 'browser-verifier', 'uae-triage', 'uae-architect', 'design-auditor']);
const VERSION_FOTO = 3; // 3: config.toml con catálogo de la app aparte (#catalogo) y entorno alterado en la foto
const MAX_CAMBIOS_LISTA = 20;
const MAX_SENSIBLES = 5000;
const MAX_PROFUNDIDAD = 3;
const MAX_ERRORES = 50;
const DIAS_RETENCION = 7;
const BLOQUE = 1024 * 1024;
const PRESUPUESTO_HOOK_MS = 20000;   // hooks con timeout 30 s
const PRESUPUESTO_CLI_MS = 120000;
let modoHook = false;
// En el CLI el presupuesto corre desde que arranca el proceso (git, raíz y anidados incluidos); como biblioteca, por medición.
const T_PROCESO = require.main === module ? Date.now() : null;
const NO_MEDIDA = 'no-medida';       // valor de una SECCIÓN que no se pudo medir (nunca un mapa vacío)
const PERILLAS = ['UAEH_ARNES', 'UAEH_PRESUPUESTO_MS', 'UAEH_TOPE_SENSIBLES', 'UAEH_INTEGRIDAD_DIR', 'UAEH_HOME'];

// A8: carpetas de dependencias o salidas (a cualquier profundidad) donde NO se miden ignorados de código/config.
const DIRS_SALIDA = new Set(['node_modules', '.next', '.nuxt', '.output', '.svelte-kit', 'dist', 'build', 'out', 'coverage',
  '.turbo', '.vercel', '.parcel-cache', '.cache', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', 'pods', '.gradle', 'target', '.dart_tool', '.expo', 'vendor', 'bower_components',
  'www', '.angular', 'output', '.nx', '.astro', '.wrangler', 'storybook-static', '.docusaurus',
  'test-results', 'playwright-report', 'blob-report',
  '.playwright-cli', // A16 (ciclo 5: `.playwright` ya NO (A21), `env` ya NO (A22), `.yarn` entero ya NO (A23))
  '.nyc_output', '.tox', '.nox', '.idea', '.gradle-cache', '.hypothesis', '.eggs']); // A17
// A23: pares de carpetas podadas (a cualquier profundidad): solo la caché y los paquetes descomprimidos de Yarn.
const RE_PAR_PODADO = /(?:^|\/)(?:reports\/visual-audit|\.yarn\/cache|\.yarn\/unplugged)$/i;
// A17: salidas de sesión y reportes del revisor: se excluyen por NOMBRE de la medición de ignorados (glob con *).
const EXCLUSIONES_NOMBRE = ['*storage-state*.json', 'auth-state*.json', 'junit*.xml', 'coverage*.xml', 'test-report*.xml'];
const RE_EXCLUSION_NOMBRE = new RegExp('^(?:' + EXCLUSIONES_NOMBRE.map((g) =>
  g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).join('|') + ')$');
const EXT_CODIGO = new Set(['py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'sh', 'bash', 'ps1', 'psm1', 'bat', 'cmd', 'json',
  'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'plist', 'xml', 'gradle', 'kts', 'dart', 'php', 'rb',
  'go', 'rs', 'java', 'kt', 'swift', 'sql', 'pem', 'key', 'keystore', 'jks', 'p12', 'pfx', 'crt', 'cer']);
const NOMBRES_CODIGO = new Set(['claude.md', 'agents.md', 'google-services.json', 'googleservice-info.plist', '.dev.vars', '.pypirc']);

// Evidencia que los revisores DEBEN escribir (capturas, resultados de Playwright). Solo NO rastreados.
const CARPETA_EVIDENCIA = /(?:^|\/)(?:reports\/visual-audit|test-results|playwright-report|blob-report|\.playwright-cli)\//i;
const EXT_EVIDENCIA = /\.(?:png|jpe?g|webp|gif|svg|webm|mp4|zip|json|ya?ml|md|html|txt|log|xml|css|js|map|woff2?|ttf|trace|network|ndjson|pdf)$/i; // A25: + salidas de traza de Playwright
const NOMBRE_PRUEBA = /\.(?:test|spec)\.|(?:^|\/)__tests__\//i;

// ---------------------------------------------------------------- utilidades

function dirPrincipal() {
  return process.env.UAEH_INTEGRIDAD_DIR || path.join(comun.uaehHome(), 'integridad');
}

// Respaldo si el principal no admite escritura (p. ej. Codex en workspace-write no puede escribir en <claudeHome>).
function dirRespaldo() {
  return path.join(os.tmpdir(), 'uaeh-integridad');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function presupuestoMs() {
  const n = Number(process.env.UAEH_PRESUPUESTO_MS);
  if (process.env.UAEH_PRESUPUESTO_MS && Number.isFinite(n) && n >= 0) return n;
  return modoHook ? PRESUPUESTO_HOOK_MS : PRESUPUESTO_CLI_MS;
}

function git(raiz, args, timeout) {
  // Todo git queda atado al presupuesto del proceso (mínimo 1 s): en un hook, el peor caso no pasa de su timeout.
  const restante = T_PROCESO === null ? Infinity : Math.max(1000, presupuestoMs() - (Date.now() - T_PROCESO));
  return execFileSync('git', ['-C', raiz, '-c', 'core.quotepath=off', '--no-optional-locks', ...args], {
    encoding: 'utf8',
    timeout: Math.min(timeout || 15000, restante),
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

// A15: distingue «no existe / no es repo» de un error de ejecución o timeout de git.
// → { raiz } | { raiz: null, estado: 'ausente' | 'no-repo' } | { raiz: null, estado: 'error', causa }
function resolverRaiz(dir) {
  if (!dir) return { raiz: null, estado: 'ausente' };
  try { if (!fs.existsSync(dir)) return { raiz: null, estado: 'ausente' }; } catch (e) { return { raiz: null, estado: 'error', causa: codigoDe(e) }; }
  const restante = T_PROCESO === null ? Infinity : Math.max(1000, presupuestoMs() - (Date.now() - T_PROCESO));
  try {
    const r = execFileSync('git', ['-C', path.resolve(dir), '--no-optional-locks', 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: Math.min(15000, restante), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' }
    }).trim();
    return r ? { raiz: path.resolve(r) } : { raiz: null, estado: 'error', causa: 'git no devolvió la raíz' };
  } catch (e) {
    const err = String((e && e.stderr) || '');
    if (e && e.status === 128 && /not a git repository/i.test(err)) return { raiz: null, estado: 'no-repo' };
    const detalle = err.split(/\r?\n/).find((l) => l.trim());
    return { raiz: null, estado: 'error', causa: codigoDe(e) + (detalle ? ': ' + detalle.trim().slice(0, 120) : '') };
  }
}

function raizDelRepo(dir) { return resolverRaiz(dir).raiz; }

function normRepo(p) {
  const s = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function mapaNuevo() { return Object.create(null); }

// Serialización canónica (claves ordenadas): la huella no depende del orden de inserción.
function canonico(v) {
  if (v === undefined || v === null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonico).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonico(v[k])).join(',') + '}';
}

// La huella cubre {version, repo, medicion}: el id la lleva y el orquestador lo conserva fuera del alcance del revisor.
function huellaDe(version, repo, medicion) {
  return sha256(canonico({ version, repo, medicion })).slice(0, 16);
}

function nuevoId(huella) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(3).toString('hex')}-${huella}`;
}

function huellaDelId(id) {
  const m = /^\d{8}-\d{6}-[0-9a-f]{6}-([0-9a-f]{16})$/.exec(String(id));
  return m ? m[1] : null;
}

function idSeguro(id) {
  return /^[A-Za-z0-9_-]{1,120}$/.test(String(id || ''));
}

// ------------------------------------------------------------------ contexto de medición

function nuevoCtx() {
  return { t0: T_PROCESO || Date.now(), limite: presupuestoMs(), errores: [], noMedidas: [], incompleta: false };
}

// Una SECCIÓN que no se pudo listar (git falló, carpeta ilegible, tope) queda «no medida»: error + marca. Nunca un
// mapa vacío, que en la comparación se leería como «todo desapareció» (ROTA falsa).
function sinMedir(ctx, seccion) {
  if (!ctx.noMedidas.includes(seccion)) ctx.noMedidas.push(seccion);
}

function agotado(ctx) {
  if (Date.now() - ctx.t0 > ctx.limite) { ctx.incompleta = true; return true; }
  return false;
}

function registrarError(ctx, texto) {
  if (ctx.errores.length < MAX_ERRORES) ctx.errores.push(texto);
  else if (ctx.errores.length === MAX_ERRORES) ctx.errores.push('… más errores');
}

function codigoDe(e) { return (e && (e.code || (e.status != null && 'exit ' + e.status) || e.signal)) || String(e && e.message || e); }

// Ejecuta git dentro del presupuesto. null = no se pudo (error registrado). `salidas`: códigos de salida que
// significan «no hay valor» (estado legítimo: sin commits, HEAD desacoplado, clave sin definir) → ''.
function gitC(ctx, raiz, args, etiqueta, salidas) {
  if (agotado(ctx)) return null;
  const restante = Math.max(1000, ctx.limite - (Date.now() - ctx.t0));
  try {
    return git(raiz, args, restante);
  } catch (e) {
    if (salidas && salidas.includes(e.status) && !(e.stdout && String(e.stdout).trim())) return '';
    registrarError(ctx, `git ${etiqueta || args.slice(0, 2).join(' ')} falló (${codigoDe(e)})`);
    return null;
  }
}

// ------------------------------------------------------------------ hash de archivos

function hashContenido(ruta, ctx, etq) {
  let fd;
  try {
    fd = fs.openSync(ruta, 'r');
    const h = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(BLOQUE);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, BLOQUE, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
      if (agotado(ctx)) return 'sin-medir';
    }
    return h.digest('hex');
  } catch (e) {
    registrarError(ctx, `no se pudo leer ${etq} (${codigoDe(e)})`);
    return 'error';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ya cerrado */ } }
  }
}

// settings.local.json: JSON canónico sin permissions.allow (lo escribe «no volver a preguntar»).
function hashSettingsLocal(ruta, ctx, etq) {
  let buf;
  try { buf = fs.readFileSync(ruta); } catch (e) {
    registrarError(ctx, `no se pudo leer ${etq} (${codigoDe(e)})`);
    return 'error';
  }
  try {
    const j = JSON.parse(buf.toString('utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      // allow y additionalDirectories los escribe «aprobar» (permiso / acceso a una carpeta).
      if (j.permissions && typeof j.permissions === 'object' && !Array.isArray(j.permissions)) {
        delete j.permissions.allow;
        delete j.permissions.additionalDirectories;
        if (Object.keys(j.permissions).length === 0) delete j.permissions;
      }
      // A4: lo que queda vacío vale lo mismo que un archivo ausente (la primera aprobación crea el archivo).
      if (Object.keys(j).length === 0) return 'ausente';
      return 'json:' + sha256(canonico(j));
    }
  } catch { /* no parsea: bytes crudos */ }
  return sha256(buf);
}

// config.toml de Codex sin las tablas projects, tui y notice (que Codex reescribe al abrir un repo).
// A1: escáner con estado. Un encabezado solo es real FUERA de cadenas multilínea (''' y """) y fuera de arreglos o
// tablas en línea abiertos; el nombre se compara por SEGMENTO exacto (`tuiextra` no es `tui`). Si algo no se puede
// interpretar con certeza (cadena sin cerrar, encabezado raro) devuelve null → se hashean los bytes completos.
const TABLAS_OMITIDAS = new Set(['projects', 'tui', 'notice']);

// A28: decodifica el contenido (ya validado por cadenaBasicaToml) de una cadena básica.
function decodificarBasicaToml(c) {
  const mapa = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  return c.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/g, (_m, u, U, e) => ((u || U) ? String.fromCodePoint(parseInt(u || U, 16)) : mapa[e]));
}

// undefined = la línea no es un encabezado · null = parece uno pero no se interpreta · string = primer segmento.
function encabezadoToml(linea, segs) {
  const t = linea.trim();
  if (!t.startsWith('[')) return undefined;
  const doble = t.startsWith('[[');
  let i = doble ? 2 : 1;
  const n = t.length;
  let primero = null;
  const salta = () => { while (i < n && (t[i] === ' ' || t[i] === '\t')) i++; };
  for (;;) {
    salta();
    let seg;
    if (t[i] === '"') {
      let j = i + 1;
      while (j < n && t[j] !== '"') j += t[j] === '\\' ? 2 : 1;
      if (j >= n) return null;
      // A28: los escapes del encabezado se validan igual que en los valores (\ud800, \U00110000 -> no se interpreta).
      if (cadenaBasicaToml(t, i) !== j + 1) return null;
      seg = decodificarBasicaToml(t.slice(i + 1, j));
      i = j + 1;
    } else if (t[i] === "'") {
      const j = t.indexOf("'", i + 1);
      if (j < 0) return null;
      seg = t.slice(i + 1, j);
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(t.slice(i));
      if (!m) return null;
      seg = m[0];
      i += seg.length;
    }
    if (segs) segs.push(seg);
    if (primero === null) primero = seg;
    salta();
    if (t[i] === '.') { i++; continue; }
    break;
  }
  if (doble ? t.slice(i, i + 2) !== ']]' : t[i] !== ']') return null;
  i += doble ? 2 : 1;
  salta();
  if (i < n && t[i] !== '#') return null;
  return primero;
}

// Recorre una línea que NO es encabezado y devuelve el estado { ml, prof } (cadena multilínea abierta, profundidad de
// [] y {}), o null si no se interpreta (cadena de una línea sin cerrar, cierre de más).
function escanearLineaToml(linea, ml, prof) {
  const n = linea.length;
  let i = 0;
  // C6: posición de CLAVE (inicio de sentencia, o tras `{` `,` `.`) cuyo texto es projects/tui/notice y que va seguida de
  // `.` o `=`: define una tabla omitida con clave con puntos o tabla en línea, en cualquier nivel → no se interpreta.
  let previo = (ml === null && prof === 0) ? '' : 'v';
  const esClave = (txt, fin) => {
    if (!TABLAS_OMITIDAS.has(txt)) return false;
    if (!(previo === '' || previo === '{' || previo === ',' || previo === '.')) return false;
    let k = fin;
    while (k < n && (linea[k] === ' ' || linea[k] === '\t')) k++;
    return linea[k] === '.' || linea[k] === '=';
  };
  while (i < n) {
    if (ml) {
      if (ml === '"""') {
        while (i < n && !(linea[i] !== '\\' && linea.startsWith('"""', i))) i += linea[i] === '\\' ? 2 : 1;
      } else {
        const k = linea.indexOf("'''", i);
        i = k < 0 ? n : k;
      }
      if (i >= n) return { ml, prof };
      let j = i + 3;
      while (j < n && linea[j] === ml[0] && j - i < 5) j++; // hasta 2 comillas pegadas pertenecen al texto
      i = j;
      ml = null;
      continue;
    }
    const c = linea[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#') break;
    if (linea.startsWith('"""', i)) { ml = '"""'; i += 3; previo = 'v'; continue; }
    if (linea.startsWith("'''", i)) { ml = "'''"; i += 3; previo = 'v'; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n && linea[j] !== '"') j += linea[j] === '\\' ? 2 : 1;
      if (j >= n) return null;
      const crudo = linea.slice(i + 1, j);
      const txt = cadenaBasicaToml(linea, i) === j + 1 ? decodificarBasicaToml(crudo) : crudo;
      if (esClave(txt, j + 1)) return null;
      i = j + 1;
      previo = 'v';
      continue;
    }
    if (c === "'") {
      const j = linea.indexOf("'", i + 1);
      if (j < 0) return null;
      if (esClave(linea.slice(i + 1, j), j + 1)) return null;
      i = j + 1;
      previo = 'v';
      continue;
    }
    if (/[A-Za-z0-9_-]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_-]/.test(linea[j])) j++;
      if (esClave(linea.slice(i, j), j)) return null;
      i = j;
      previo = 'v';
      continue;
    }
    if (c === '[' || c === '{') prof++;
    else if (c === ']' || c === '}') { prof--; if (prof < 0) return null; }
    previo = c;
    i++;
  }
  return { ml, prof };
}

// A12: gramática conservadora para las líneas DENTRO de una tabla omitida. Cada función devuelve el índice donde
// termina lo reconocido, o -1 si no es un literal TOML de UNA línea que reconozca.
function escalarInvalido(hex) {
  const v = parseInt(hex, 16);
  return v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF);
}

function cadenaBasicaToml(s, i) {
  if (s[i] !== '"' || s.startsWith('"""', i)) return -1;
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '"') return j + 1;
    if (c === '\\') {
      const e = s[j + 1];
      if (e !== undefined && 'btnfr"\\'.includes(e)) { j += 2; continue; }
      // A24: los escapes de Unicode deben ser un escalar válido (no sustituto D800-DFFF, no mayor de 10FFFF).
      if (e === 'u' && /^[0-9A-Fa-f]{4}$/.test(s.substr(j + 2, 4)) && !escalarInvalido(s.substr(j + 2, 4))) { j += 6; continue; }
      if (e === 'U' && /^[0-9A-Fa-f]{8}$/.test(s.substr(j + 2, 8)) && !escalarInvalido(s.substr(j + 2, 8))) { j += 10; continue; }
      return -1;
    }
    if (c < ' ' && c !== '\t') return -1;
    j++;
  }
  return -1;
}

function cadenaLiteralToml(s, i) {
  if (s[i] !== "'" || s.startsWith("'''", i)) return -1;
  const j = s.indexOf("'", i + 1);
  if (j < 0 || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(s.slice(i + 1, j))) return -1;
  return j + 1;
}

function escalarToml(s, i) {
  const r = s.slice(i);
  let m = /^(?:true|false)(?![A-Za-z0-9_.:-])/.exec(r);
  if (m) return i + m[0].length;
  m = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?(?![A-Za-z0-9_.:-])/.exec(r);
  if (m) return i + m[0].length;
  if (s[i] === '"') return cadenaBasicaToml(s, i);
  if (s[i] === "'") return cadenaLiteralToml(s, i);
  return -1;
}

function arregloToml(s, i) {
  let j = i + 1;
  const ws = () => { while (s[j] === ' ' || s[j] === '\t') j++; };
  ws();
  if (s[j] === ']') return j + 1;
  for (;;) {
    j = escalarToml(s, j);
    if (j < 0) return -1;
    ws();
    if (s[j] === ',') { j++; ws(); if (s[j] === ']') return j + 1; continue; }
    if (s[j] === ']') return j + 1;
    return -1;
  }
}

// Devuelve false (no reconocida) o { clave } (clave = null en líneas vacías o comentarios). A24: la clave se devuelve
// decodificada para detectar claves repetidas; una clave entre comillas con escapes no se interpreta (→ false).
function analizarLineaOmitida(linea) {
  const t = linea.trim();
  if (t === '' || t[0] === '#') return { clave: null };
  let i;
  let clave;
  if (t[0] === '"') { i = cadenaBasicaToml(t, 0); if (i > 0) clave = t.slice(1, i - 1); if (clave !== undefined && clave.includes('\\')) return false; }
  else if (t[0] === "'") { i = cadenaLiteralToml(t, 0); if (i > 0) clave = t.slice(1, i - 1); }
  else { const m = /^[A-Za-z0-9_-]+/.exec(t); i = m ? m[0].length : -1; if (m) clave = m[0]; }
  if (i < 0) return false;
  const ws = () => { while (t[i] === ' ' || t[i] === '\t') i++; };
  ws();
  if (t[i] !== '=') return false;
  i++;
  ws();
  i = t[i] === '[' ? arregloToml(t, i) : escalarToml(t, i);
  if (i < 0) return false;
  ws();
  return i >= t.length || t[i] === '#' ? { clave } : false;
}

// F3-P1: con `catalogo` (Map) se omiten ADEMÁS las tablas de catálogo de la app de Codex (plugins*, marketplace*), cuyo
// contenido se guarda aparte (tabla de 2 segmentos → líneas) para avisar en vez de dar ROTA.
const esCatalogoToml = (seg) => seg === 'plugins' || /^marketplace/.test(seg);
function textoTomlNormalizado(texto, catalogo) {
  const salida = [];
  let excluir = false;
  let ml = null;
  let prof = 0;
  const tablasVistas = new Set(); // A24: encabezados [a.b] ya vistos en tablas omitidas
  const prefijos = new Set();     // A28: choque clave/tabla: todo prefijo de encabezado visto (para choque clave/tabla)
  const clavesPorTabla = new Map(); // A28: encabezado → claves definidas en esa tabla
  let clavesVistas = null;        // A24: claves de la tabla omitida actual
  let rutaActual = null;          // A28: segmentos de la tabla omitida actual
  let grupo = null;               // F3-P1: tabla de catálogo actual
  for (const linea of texto.split(/\r?\n/)) {
    if (ml === null && prof === 0) {
      const segs = [];
      const primero = encabezadoToml(linea, segs);
      if (primero === null) return null;
      if (primero !== undefined) {
        const esCat = !!catalogo && esCatalogoToml(primero);
        excluir = TABLAS_OMITIDAS.has(primero) || esCat;
        grupo = null;
        if (esCat) { grupo = segs.slice(0, 2).join('.'); if (!catalogo.has(grupo)) catalogo.set(grupo, []); catalogo.get(grupo).push(linea); }
        if (!excluir) salida.push(linea);
        else {
          // A28: `[[x]]` en una tabla omitida (ni repetido ni mezclado con `[x]` se puede razonar) → no se interpreta.
          if (linea.trim().startsWith('[[')) return null;
          // A24: tabla repetida (mismo encabezado completo) → no se interpreta.
          const id = JSON.stringify(segs);
          if (tablasVistas.has(id)) return null;
          tablasVistas.add(id);
          for (let k = 1; k <= segs.length; k++) prefijos.add(JSON.stringify(segs.slice(0, k)));
          for (let k = 1; k < segs.length; k++) {
            const padre = clavesPorTabla.get(JSON.stringify(segs.slice(0, k)));
            if (padre && padre.has(segs[k])) return null;
          }
          clavesVistas = new Set();
          clavesPorTabla.set(id, clavesVistas);
          rutaActual = segs;
        }
        continue;
      }
    }
    // A12: en una tabla omitida solo vale lo que la gramática conservadora reconoce; lo demás → bytes completos.
    if (excluir) {
      if (ml !== null || prof !== 0) return null;
      const a = analizarLineaOmitida(linea);
      if (!a) return null;
      if (grupo !== null) catalogo.get(grupo).push(linea);
      // A24: clave repetida en la misma tabla → no se interpreta.
      if (a.clave !== null) { if (clavesVistas.has(a.clave)) return null; clavesVistas.add(a.clave); if (prefijos.has(JSON.stringify(rutaActual.concat([a.clave])))) return null; }
      continue;
    }
    const est = escanearLineaToml(linea, ml, prof);
    if (!est) return null;
    ml = est.ml;
    prof = est.prof;
    salida.push(linea);
  }
  if (ml !== null || prof !== 0) return null;
  return salida.join('\n');
}

function hashToml(ruta, ctx, etq) {
  let buf;
  try { buf = fs.readFileSync(ruta); } catch (e) {
    registrarError(ctx, `no se pudo leer ${etq} (${codigoDe(e)})`);
    return 'error';
  }
  const catalogo = new Map();
  const normalizado = textoTomlNormalizado(buf.toString('utf8'), catalogo);
  if (normalizado === null) return 'toml-crudo:' + sha256(buf);
  // F3-P1: hash por tabla de catálogo (solo nombres + hashes; nunca valores) → ctx.catalogos[etiqueta]
  const porTabla = {};
  for (const [k, v] of [...catalogo].sort((x, y) => (x[0] < y[0] ? -1 : 1))) porTabla[k] = sha256(v.join('\n')).slice(0, 16);
  (ctx.catalogos = ctx.catalogos || {})[etq] = 'cat:' + JSON.stringify(porTabla);
  return 'toml:' + sha256(normalizado);
}

// norm: undefined | 'settings' | 'toml'. ENOENT = 'ausente' (estable); cualquier otro error se registra.
function hashArchivo(ruta, ctx, etq, norm) {
  if (agotado(ctx)) return 'sin-medir';
  let st;
  try { st = fs.lstatSync(ruta); } catch (e) {
    if (e.code === 'ENOENT') return 'ausente';
    registrarError(ctx, `no se pudo leer ${etq} (${codigoDe(e)})`);
    return 'error';
  }
  if (st.isSymbolicLink()) {
    let destino;
    try { destino = fs.readlinkSync(ruta); } catch (e) {
      registrarError(ctx, `no se pudo leer el enlace ${etq} (${codigoDe(e)})`);
      return 'error';
    }
    let sd;
    try { sd = fs.statSync(ruta); } catch (e) {
      if (e.code === 'ENOENT') return 'enlace-roto:' + destino;
      if (e.code === 'ELOOP') return 'enlace-ciclo';
      registrarError(ctx, `no se pudo leer el destino del enlace ${etq} (${codigoDe(e)})`);
      return 'error';
    }
    if (sd.isDirectory()) return 'enlace-dir:' + destino;
    return 'enlace:' + destino + ':' + hashContenido(ruta, ctx, etq);
  }
  // A2: una carpeta jamás es un valor «medido»: donde se esperaba un archivo, es error (→ DESCONOCIDO).
  if (st.isDirectory()) {
    registrarError(ctx, `se esperaba un archivo y es una carpeta: ${etq}`);
    return 'error';
  }
  if (norm === 'settings') return hashSettingsLocal(ruta, ctx, etq);
  if (norm === 'toml') return hashToml(ruta, ctx, etq);
  return hashContenido(ruta, ctx, etq);
}

function normDeRuta(rel) {
  return /(?:^|\/)\.claude\/settings\.local\.json$/i.test(rel) ? 'settings' : undefined;
}

// ------------------------------------------------------------------ medición de un repo

function partirIndice(salida) {
  // "modo sha etapa\truta\0" por entrada
  const lista = [];
  for (const e of salida.split('\0')) {
    if (!e) continue;
    const t = e.indexOf('\t');
    if (t < 0) continue;
    const modo = e.slice(0, e.indexOf(' '));
    lista.push({ modo, rel: e.slice(t + 1) });
  }
  return lista;
}

function esEvidenciaNueva(rel) {
  return CARPETA_EVIDENCIA.test(rel) && EXT_EVIDENCIA.test(rel) && !NOMBRE_PRUEBA.test(rel);
}

function esWorktreeClaude(rel) {
  return /(?:^|\/)\.claude\/worktrees(?:\/|$)/i.test(rel);
}

// Nombre de un ignorado que parece CÓDIGO, CONFIGURACIÓN o CREDENCIAL (A8). `minus` en minúsculas.
function pareceCodigoOCredencial(minus) {
  if (NOMBRES_CODIGO.has(minus) || /^\.yarnrc/.test(minus) || minus.startsWith('.dev.vars') || minus.includes('.local.')) return true;
  const p = minus.lastIndexOf('.');
  return p > 0 && EXT_CODIGO.has(minus.slice(p + 1));
}

// Ignorados que son ENTRADAS, no salidas. Recorrido propio; mide siempre los sensibles (.env*, .npmrc, todo lo de
// .claude/ y .codex/) y, fuera de carpetas de dependencias o salidas, todo archivo ignorado que parezca código,
// configuración o credencial. No entra en node_modules/, .git/, .claude/worktrees/ ni en repos anidados YA medidos
// aparte (`medidos`: rutas de m.anidados). Una carpeta ignorada con .git propio (o con un .git vacío o de archivo) SÍ
// se recorre (A3). `conocidos` = rutas ya medidas como rastreadas o no rastreadas.
function ignoradosSensibles(raiz, ctx, conocidos, pref, medidos) {
  const tope = Number(process.env.UAEH_TOPE_SENSIBLES) > 0 ? Number(process.env.UAEH_TOPE_SENSIBLES) : MAX_SENSIBLES;
  const seccion = pref + 'ignorados';
  const hallados = [];
  const pila = [['', false, false]];
  while (pila.length) {
    if (agotado(ctx)) { sinMedir(ctx, seccion); return NO_MEDIDA; }
    const [relDir, enClaude] = pila.pop();
    if (relDir && medidos.has(relDir)) continue; // repo anidado ya medido recursivamente
    let ents;
    try { ents = fs.readdirSync(relDir ? path.join(raiz, relDir) : raiz, { withFileTypes: true }); } catch (e) {
      if (e.code !== 'ENOENT') {
        registrarError(ctx, `no se pudo listar ${pref}${relDir || '.'} (${codigoDe(e)})`);
        sinMedir(ctx, seccion);
      }
      continue;
    }
    // A17: una carpeta con pyvenv.cfg es un venv (se llame como se llame, p. ej. .env/): se poda completa.
    if (relDir && ents.some((en) => en.name === 'pyvenv.cfg' && !en.isDirectory())) continue;
    for (const ent of ents) {
      const rel = relDir ? relDir + '/' + ent.name : ent.name;
      const minus = ent.name.toLowerCase();
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        if (minus === 'worktrees' && /(?:^|\/)\.claude$/i.test(relDir)) continue;
        const dentroClaude = enClaude || minus === '.claude' || minus === '.codex';
        // A14: las carpetas de salida/dependencias se PODAN (no se entra), también para .env*/.npmrc.
        if (!dentroClaude && (DIRS_SALIDA.has(minus) || RE_PAR_PODADO.test(rel))) continue;
        pila.push([rel, dentroClaude]);
      } else if (RE_EXCLUSION_NOMBRE.test(minus)) {
        continue; // A17: salidas de sesión y reportes del revisor (documentado en el encabezado)
      } else if (enClaude || /^\.env/.test(minus) || minus === '.npmrc' || minus === '.claude' ||
        pareceCodigoOCredencial(minus)) {
        if (!conocidos.has(rel)) hallados.push(rel);
        if (hallados.length > tope) {
          registrarError(ctx, `más de ${tope} archivos ignorados de entrada (.env*, .npmrc, .claude/, código, config, credenciales): medición incompleta`);
          sinMedir(ctx, seccion);
          return NO_MEDIDA;
        }
      }
    }
  }
  const mapa = mapaNuevo();
  for (const rel of hallados.sort()) mapa[rel] = hashArchivo(path.join(raiz, rel), ctx, pref + rel, normDeRuta(rel));
  return mapa;
}

// Recorre una carpeta RECURSIVAMENTE (A2): mapa[clavePref + ruta relativa] = hash de cada archivo. Un fallo de listado
// marca la sección como no medida (seccion) en vez de dejar entradas «desaparecidas».
function recorrerRec(dir, ctx, etq, clavePref, mapa, filtro, seccion) {
  const pila = [''];
  while (pila.length) {
    if (agotado(ctx)) { sinMedir(ctx, seccion); return; }
    const rel = pila.pop();
    let ents;
    try { ents = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true }); } catch (e) {
      if (e.code !== 'ENOENT') {
        registrarError(ctx, `no se pudo listar ${etq}${rel ? '/' + rel : ''} (${codigoDe(e)})`);
        sinMedir(ctx, seccion);
      }
      continue;
    }
    for (const ent of ents) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { pila.push(r); continue; }
      if (filtro && !filtro(ent.name)) continue;
      mapa[clavePref + r] = hashArchivo(path.join(dir, r), ctx, etq + '/' + r);
    }
  }
}

// Configuración y ganchos de git (directorio común) + archivos que la config de git hace efectivos.
function internosGit(raiz, ctx, pref) {
  const mapa = mapaNuevo();
  const comun = gitC(ctx, raiz, ['rev-parse', '--git-common-dir'], 'rev-parse --git-common-dir');
  const propio = gitC(ctx, raiz, ['rev-parse', '--git-dir'], 'rev-parse --git-dir');
  const dirGit = comun && comun.trim() ? path.resolve(raiz, comun.trim()) : path.join(raiz, '.git');
  const agregar = (clave, ruta, norm) => { mapa[clave] = hashArchivo(ruta, ctx, pref + '.git/' + clave, norm); };
  agregar('config', path.join(dirGit, 'config'));
  if (propio && propio.trim()) agregar('config.worktree', path.join(path.resolve(raiz, propio.trim()), 'config.worktree'));
  for (const sub of ['hooks', 'info']) {
    recorrerRec(path.join(dirGit, sub), ctx, pref + '.git/' + sub, sub + '/', mapa, (n) => !n.endsWith('.sample'), pref + '.git');
  }
  // core.excludesFile / core.attributesFile (o sus valores por defecto) y core.hooksPath externo.
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  for (const [clave, defecto] of [['core.excludesFile', 'ignore'], ['core.attributesFile', 'attributes']]) {
    const v = gitC(ctx, raiz, ['config', '--type=path', '--get', clave], 'config ' + clave, [1]);
    const ruta = v && v.trim() ? path.resolve(raiz, v.trim()) : path.join(xdg, 'git', defecto);
    mapa['externo:' + clave] = hashArchivo(ruta, ctx, pref + clave);
  }
  const hp = gitC(ctx, raiz, ['config', '--type=path', '--get', 'core.hooksPath'], 'config core.hooksPath', [1]);
  if (hp && hp.trim()) {
    const abs = path.resolve(raiz, hp.trim());
    if (normRepo(abs) !== normRepo(path.join(dirGit, 'hooks'))) {
      recorrerRec(abs, ctx, pref + 'hooksPath', 'hooksPath/', mapa, null, pref + '.git');
    }
  }
  return mapa;
}

function medirAnidado(abs, rel, ctx, prof, pref, anidados) {
  if (agotado(ctx)) { anidados[rel] = 'sin-medir'; return; } // la detección también corre dentro del presupuesto
  if (prof + 1 > MAX_PROFUNDIDAD) {
    registrarError(ctx, `repo anidado demasiado profundo (> ${MAX_PROFUNDIDAD}): ${pref}${rel}`);
    anidados[rel] = 'profundidad-excedida';
    return;
  }
  let ents = [];
  try { ents = fs.readdirSync(abs); } catch (e) {
    if (e.code === 'ENOENT') { anidados[rel] = 'vacio'; return; }
    registrarError(ctx, `no se pudo listar el repo anidado ${pref}${rel} (${codigoDe(e)})`);
    anidados[rel] = 'error';
    return;
  }
  if (ents.length === 0) { anidados[rel] = 'vacio'; return; } // submódulo no inicializado
  if (!ents.includes('.git')) {
    registrarError(ctx, `repo anidado con contenido pero sin .git: ${pref}${rel}`);
    anidados[rel] = 'sin-git';
    return;
  }
  const rN = resolverRaiz(abs);
  const raizN = rN.raiz;
  if (!raizN) {
    registrarError(ctx, `repo anidado ilegible para git: ${pref}${rel}` + (rN.causa ? ` (${rN.causa})` : ''));
    anidados[rel] = 'error';
    return;
  }
  anidados[rel] = medirRepo(raizN, ctx, prof + 1, pref + rel + '/');
}

function medirRepo(raiz, ctx, prof, pref) {
  const valor = (s, vacio) => (s === null ? 'error' : (s.trim() || vacio));
  const m = {
    head: valor(gitC(ctx, raiz, ['rev-parse', '--verify', '-q', 'HEAD'], 'rev-parse HEAD', [1]), 'sin-commits'),
    rama: valor(gitC(ctx, raiz, ['symbolic-ref', '-q', 'HEAD'], 'symbolic-ref HEAD', [1]), 'desacoplado')
  };
  const idx = gitC(ctx, raiz, ['ls-files', '-s', '-z'], 'ls-files -s');
  m.indice = idx === null ? 'error' : sha256(idx);
  if (idx === null) sinMedir(ctx, pref + 'archivos');
  const ban = gitC(ctx, raiz, ['ls-files', '-v', '-z'], 'ls-files -v');
  m.banderas = ban === null ? 'error' : sha256(ban);
  const cfg = gitC(ctx, raiz, ['config', '--list', '--show-origin', '--show-scope', '-z'], 'config --list');
  m.configGit = cfg === null ? 'error' : sha256(cfg);
  const nrs = gitC(ctx, raiz, ['ls-files', '-o', '--exclude-standard', '-z'], 'ls-files -o');

  if (nrs === null) sinMedir(ctx, pref + 'nuevos');

  m.archivos = idx === null ? NO_MEDIDA : mapaNuevo();
  m.nuevos = nrs === null ? NO_MEDIDA : mapaNuevo();
  m.anidados = mapaNuevo();
  const conocidos = new Set();

  // D1: todos los rastreados, bytes crudos.
  for (const { modo, rel } of partirIndice(idx || '')) {
    if (conocidos.has(rel)) continue; // entradas sin fusionar repiten la ruta
    conocidos.add(rel);
    if (modo === '160000') medirAnidado(path.join(raiz, rel), rel, ctx, prof, pref, m.anidados);
    else m.archivos[rel] = hashArchivo(path.join(raiz, rel), ctx, pref + rel, normDeRuta(rel));
  }
  // D2: no rastreados no ignorados (con las dos excepciones: evidencia nueva y worktrees de .claude).
  for (const rel0 of (nrs || '').split('\0')) {
    if (!rel0) continue;
    const esDir = rel0.endsWith('/');
    const rel = esDir ? rel0.slice(0, -1) : rel0;
    conocidos.add(rel);
    if (esWorktreeClaude(rel)) continue;
    if (esDir) { medirAnidado(path.join(raiz, rel), rel, ctx, prof, pref, m.anidados); continue; }
    if (esEvidenciaNueva(rel)) continue;
    m.nuevos[rel] = hashArchivo(path.join(raiz, rel), ctx, pref + rel, normDeRuta(rel));
  }
  m.ignorados = ignoradosSensibles(raiz, ctx, conocidos, pref, new Set(Object.keys(m.anidados)));
  m.git = internosGit(raiz, ctx, pref);
  if (ctx.noMedidas.includes(pref + '.git')) m.git = NO_MEDIDA;
  return m;
}

// ------------------------------------------------------------------ arnés

// Arnés: [carpeta, patrón de nombre, recursivo?]. UAEH_ARNES (JSON) lo reemplaza TODO (pruebas); una forma inválida
// es un ERROR (nunca «sin arnés»). Sin UAEH_ARNES, la lista por defecto sale de claudeHome()/codexHome() (nunca de
// os.homedir() suelto) y suma la raíz de ESTE plugin, el espejo de ruta fija y el arnes.extra del usuario.
function especArnes(ctx) {
  if (process.env.UAEH_ARNES) {
    let j;
    try { j = JSON.parse(process.env.UAEH_ARNES); } catch { j = null; }
    // A11: un arnés vacío (p. ej. '[]') es un error, nunca «sin arnés».
    const valido = Array.isArray(j) && j.length > 0 && j.every((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string');
    if (!valido) { registrarError(ctx, 'UAEH_ARNES no es un JSON válido y no vacío de [carpeta, patrón[, recursivo]]'); return []; }
    return j;
  }
  const c = comun.claudeHome();
  const x = comun.codexHome();
  const espec = [
    [c, '^(settings(\\.local)?\\.json|CLAUDE\\.md)$'],
    [path.join(c, 'hooks'), '\\.(js|cjs|mjs|json)$', true], // A2: recursivo (auxiliares en subcarpetas)
    [path.join(c, 'agents'), '\\.md$'],
    [path.join(c, 'scripts'), '^uaeh-.*\\.cjs$'],
    [path.join(c, 'git-hooks'), '.', true], // A27: la guarda global de git (si no existe, queda ausente)
    [x, '^(config\\.toml|AGENTS\\.md|[^/]*\\.config\\.toml)$'],
    [path.join(x, 'agents'), '\\.toml$'],
    // La raíz de ESTE plugin, recursiva: scripts, hooks, agentes, skills, plantillas y vendor/ (en una instalación real
    // vive bajo <claudeHome>/plugins/cache/…, zona que por lo demás no se mide). Una entrada explícita no la poda nada.
    [path.resolve(__dirname, '..'), '.', true],
    // El espejo de ruta fija (git-hooks, hooks y scripts que usan git y Codex); si no existe, queda ausente.
    [comun.estableDir(), '.', true]
  ];
  let skills = [];
  try { skills = fs.readdirSync(path.join(c, 'skills')).filter((n) => /^uae-/.test(n)); } catch (e) {
    if (e.code !== 'ENOENT') registrarError(ctx, `no se pudo listar las skills del arnés (${codigoDe(e)})`);
  }
  for (const s of skills) espec.push([path.join(c, 'skills', s), '.', true]);
  // arnes.extra de uaeh.config.json: [carpeta, patrón[, recursivo]] que el usuario quiere vigilar además. config.cjs ya
  // descartó la forma inválida; aquí no se calla: una configuración ilegible o con arnes.extra inválido deja de medir
  // algo que se pidió medir, y eso es un ERROR (→ DESCONOCIDO), nunca «menos arnés» en silencio.
  const cfg = configArnes.cargarConfig();
  if (cfg.avisos.some((a) => /^(arnes\.extra|uaeh\.config\.json no (parsea|es un objeto))/.test(a))) {
    registrarError(ctx, 'uaeh.config.json ilegible o con arnes.extra inválido: se mediría menos de lo que se pidió');
  }
  for (const extra of cfg.config.arnes.extra) espec.push(extra);
  return espec;
}

// A9: CLAUDE.md y AGENTS.md de cada carpeta ANCESTRO de la raíz del repo hasta la raíz del disco (Claude Code los
// carga). Solo entran los que existen; se miden también con UAEH_ARNES.
function ancestrosArnes(raiz, ctx, mapa) {
  let d = path.dirname(path.resolve(raiz));
  for (;;) {
    for (const nombre of ['CLAUDE.md', 'AGENTS.md']) {
      const abs = path.join(d, nombre);
      const clave = abs.split(path.sep).join('/');
      const v = hashArchivo(abs, ctx, clave);
      if (v !== 'ausente') mapa[clave] = v;
    }
    const padre = path.dirname(d);
    if (padre === d) break;
    d = padre;
  }
}

// A27: VALOR efectivo del core.hooksPath GLOBAL (respeta GIT_CONFIG_GLOBAL). Exit 1 = sin valor; otro error = DESCONOCIDO.
function hooksPathGlobal(ctx) {
  if (agotado(ctx)) return 'sin-medir';
  const restante = T_PROCESO === null ? 15000 : Math.max(1000, presupuestoMs() - (Date.now() - T_PROCESO));
  try {
    const v = execFileSync('git', ['--no-optional-locks', 'config', '--global', '--get', 'core.hooksPath'], {
      encoding: 'utf8', timeout: Math.min(15000, restante), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return 'valor:' + (v || '(sin valor)');
  } catch (e) {
    if (e && e.status === 1 && !(e.stdout && String(e.stdout).trim())) return 'valor:(sin valor)';
    registrarError(ctx, `git config --global core.hooksPath falló (${codigoDe(e)})`);
    return 'error';
  }
}

function arnes(ctx, raiz) {
  const mapa = mapaNuevo();
  for (const [dir, patron, recursivo] of especArnes(ctx)) {
    let re;
    try { re = new RegExp(patron, 'i'); } catch { registrarError(ctx, 'arnés: patrón inválido ' + patron); continue; }
    const pila = [dir];
    while (pila.length) {
      const d = pila.pop();
      if (agotado(ctx)) { sinMedir(ctx, 'arnés'); return mapa; }
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) {
        if (e.code !== 'ENOENT') {
          registrarError(ctx, `no se pudo listar ${d.split(path.sep).join('/')} (${codigoDe(e)})`);
          sinMedir(ctx, 'arnés');
        }
        continue;
      }
      for (const ent of ents) {
        const abs = path.join(d, ent.name);
        if (ent.isDirectory()) {
          if (recursivo && ent.name !== '__pycache__' && ent.name !== 'node_modules') pila.push(abs);
          // A13: donde se esperaba un archivo y hay una carpeta con ese nombre es un ERROR, no se descarta en silencio.
          else if (!recursivo && re.test(ent.name)) registrarError(ctx, `se esperaba un archivo y es una carpeta: ${abs.split(path.sep).join('/')}`);
          continue;
        }
        if (!re.test(ent.name)) continue;
        const clave = abs.split(path.sep).join('/');
        const norm = ent.name === 'settings.local.json' ? 'settings' : (ent.name === 'config.toml' ? 'toml' : undefined);
        mapa[clave] = hashArchivo(abs, ctx, clave, norm);
        if (norm === 'toml' && ctx.catalogos && ctx.catalogos[clave]) mapa[clave + '#catalogo'] = ctx.catalogos[clave];
      }
    }
  }
  // A11: un arnés que resulta VACÍO (cero entradas) no es un arnés medido: error → DESCONOCIDO.
  if (Object.keys(mapa).length === 0 && !ctx.errores.length && !ctx.incompleta) registrarError(ctx, 'el arnés resultó vacío (cero archivos medidos)');
  ancestrosArnes(raiz, ctx, mapa);
  mapa['git-config-global:core.hooksPath'] = hooksPathGlobal(ctx);
  return mapa;
}

function medir(raiz, ctxExterno) {
  const ctx = ctxExterno || nuevoCtx();
  const m = medirRepo(raiz, ctx, 0, '');
  m.arnes = arnes(ctx, raiz);
  if (ctx.noMedidas.includes('arnés')) m.arnes = NO_MEDIDA;
  agotado(ctx); // si el último paso rebasó el presupuesto, queda marcado
  m.errores = ctx.errores.slice();
  m.incompleta = ctx.incompleta;
  m.noMedidas = ctx.noMedidas.slice();
  return m;
}

// ---------------------------------------------------------------- comparación

const SIN_VALOR = new Set(['error', 'sin-medir']);
const distinto = (a, d) => a !== d && !SIN_VALOR.has(a) && !SIN_VALOR.has(d);

function difMapa(antes, despues, nombre, cambios, describir, pref) {
  // Sección no medida en alguno de los dos lados: no hay con qué comparar (el DESCONOCIDO lo da compararFoto).
  if (typeof antes === 'string' || typeof despues === 'string') return;
  const A = Object.assign(mapaNuevo(), antes || {});
  const D = Object.assign(mapaNuevo(), despues || {});
  const claves = new Set([...Object.keys(A), ...Object.keys(D)]);
  for (const k of [...claves].sort()) {
    const a = A[k];
    const d = D[k];
    if (a === d) continue;
    // Un archivo ausente vale lo mismo que uno que no figura (p. ej. settings.local.json que solo trae permisos aprobados).
    if ((a === undefined && d === 'ausente') || (a === 'ausente' && d === undefined)) continue;
    if (SIN_VALOR.has(a) || SIN_VALOR.has(d)) continue; // no se pudo medir: es error (DESCONOCIDO), no cambio
    cambios.push(`${pref}${nombre}: ${k} (${describir(a, d)})`);
  }
}

const descTracked = (a, d) => (a === undefined ? 'pasó a rastreado' : d === undefined ? 'dejó de estar rastreado' : d === 'ausente' ? 'borrado' : 'modificado');
const descNuevo = (a, d) => (a === undefined ? 'archivo nuevo' : d === undefined ? 'desapareció' : 'modificado');
const descGeneral = (a, d) => (a === undefined ? 'apareció' : d === undefined ? 'desapareció' : 'cambió');

// F3-P1: `avisos` (opcional) recibe las diferencias de catálogo de la app de Codex (no son cambios).
function separarCatalogo(m) {
  if (typeof m === 'string' || !m) return [m, {}];
  const limpio = Object.assign(mapaNuevo(), m);
  const cat = {};
  for (const k of Object.keys(limpio)) if (k.endsWith('#catalogo')) { cat[k] = limpio[k]; delete limpio[k]; }
  return [limpio, cat];
}
function tablasDeCatalogo(v) {
  try { const o = JSON.parse(String(v || 'cat:{}').slice(4)); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

function comparar(antes, despues, pref, avisos) {
  pref = pref || '';
  const cambios = [];
  const [arnA, catA] = separarCatalogo(antes.arnes);
  const [arnD, catD] = separarCatalogo(despues.arnes);
  if (avisos) {
    for (const k of new Set([...Object.keys(catA), ...Object.keys(catD)])) {
      const ta = tablasDeCatalogo(catA[k]); const td = tablasDeCatalogo(catD[k]);
      const dif = [...new Set([...Object.keys(ta), ...Object.keys(td)])].sort().filter((t) => ta[t] !== td[t]);
      if (dif.length) avisos.push(`${path.posix.basename(k.slice(0, -'#catalogo'.length))}: cambió solo ${dif.join(', ')} (catálogo de la app de Codex)`);
    }
  }
  if (distinto(antes.head, despues.head)) cambios.push(pref + 'HEAD: se creó o movió un commit');
  if (distinto(antes.rama, despues.rama)) cambios.push(pref + 'rama actual: cambió');
  if (distinto(antes.indice, despues.indice)) cambios.push(pref + 'índice (staging): cambió');
  if (distinto(antes.banderas, despues.banderas)) cambios.push(pref + 'banderas de archivos rastreados (assume-unchanged / skip-worktree): cambiaron');
  if (distinto(antes.configGit, despues.configGit)) cambios.push(pref + 'configuración efectiva de git: cambió');
  difMapa(antes.archivos, despues.archivos, 'archivo', cambios, descTracked, pref);
  difMapa(antes.nuevos, despues.nuevos, 'archivo', cambios, descNuevo, pref);
  difMapa(antes.ignorados, despues.ignorados, 'ignorado sensible', cambios, descGeneral, pref);
  difMapa(antes.git, despues.git, '.git', cambios, descGeneral, pref);
  difMapa(arnA, arnD, 'arnés', cambios, descGeneral, pref);
  // Repos anidados: recursivo. Valor de texto (vacio, sin-git, …) se compara tal cual.
  const A = Object.assign(mapaNuevo(), antes.anidados || {});
  const D = Object.assign(mapaNuevo(), despues.anidados || {});
  for (const k of [...new Set([...Object.keys(A), ...Object.keys(D)])].sort()) {
    const a = A[k];
    const d = D[k];
    if (a === undefined || d === undefined) cambios.push(`${pref}repo anidado: ${k} (${a === undefined ? 'apareció' : 'desapareció'})`);
    else if (typeof a === 'object' && typeof d === 'object') cambios.push(...comparar(a, d, pref + k + '/'));
    else if (SIN_VALOR.has(a) || SIN_VALOR.has(d)) continue;
    else if (canonico(a) !== canonico(d)) cambios.push(`${pref}repo anidado: ${k} (cambió)`);
  }
  return cambios;
}

// ---------------------------------------------------------------- almacenamiento

function limpiarViejas(dir) {
  const limite = Date.now() - DIAS_RETENCION * 86400000;
  let nombres = [];
  try { nombres = fs.readdirSync(dir); } catch { return; }
  for (const n of nombres) {
    if (!n.endsWith('.foto.json')) continue;
    try { if (fs.statSync(path.join(dir, n)).mtimeMs < limite) fs.unlinkSync(path.join(dir, n)); } catch { /* sigue */ }
  }
}

// Ruta de la foto: id validado y ruta final contenida en la carpeta de fotos.
function rutaFoto(dir, id) {
  if (!idSeguro(id)) throw new Error('id inválido');
  const base = path.resolve(dir);
  const f = path.resolve(base, id + '.foto.json');
  if (path.dirname(f) !== base) throw new Error('id fuera de la carpeta de fotos');
  return f;
}

function guardarFoto(id, foto) {
  if (!idSeguro(id)) throw new Error('id inválido');
  const texto = JSON.stringify(foto);
  for (const dir of [dirPrincipal(), dirRespaldo()]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(rutaFoto(dir, id), texto);
      limpiarViejas(dir);
      return dir;
    } catch { /* prueba el siguiente */ }
  }
  throw new Error('no se pudo guardar la foto');
}

function leerFoto(id) {
  if (!idSeguro(id)) throw new Error('id inválido');
  for (const dir of [dirPrincipal(), dirRespaldo()]) {
    const f = rutaFoto(dir, id);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  return null;
}

function registrar(fila) {
  const linea = JSON.stringify({ fecha: new Date().toISOString(), ...fila }) + '\n';
  for (const dir of [dirPrincipal(), dirRespaldo()]) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'registro.jsonl'), linea); return; } catch { /* siguiente */ }
  }
}

// Sellos abiertos: revisiones vivas (foto tomada, aún sin comparar) de CUALQUIER sesión. Las fotos no se borran al
// comparar (solo al pasar DIAS_RETENCION), así que «abierta» = foto reciente (menos de `maxMin` minutos) cuyo id no
// tiene en registro.jsonl un cierre (resultado INTACTO / ROTA / DESCONOCIDO; FOTO_OK y SIN_FOTO son aperturas).
// El umbral por defecto (90 min) cubre la revisión más larga que el método tolera (a los 60 min la tarea se para y
// decide el usuario; cada revisor tiene tope de 15 min); una foto más vieja es un revisor muerto, no una revisión viva.
// Con UAEH_INTEGRIDAD_DIR solo se mira esa carpeta; si no, la principal y la de respaldo. Nunca lanza.
const SELLO_ABIERTO_MAX_MIN = 90;
const CIERRES = new Set(['INTACTO', 'ROTA', 'DESCONOCIDO']);
const TOPE_REGISTRO_BYTES = 8 * 1024 * 1024;

function carpetasDeFotos() {
  return process.env.UAEH_INTEGRIDAD_DIR ? [dirPrincipal()] : [dirPrincipal(), dirRespaldo()];
}

function idsCerrados(dirs) {
  const cerrados = new Set();
  for (const dir of dirs) {
    try {
      const f = path.join(dir, 'registro.jsonl');
      const tam = fs.statSync(f).size;
      const fd = fs.openSync(f, 'r');
      let texto;
      try {
        const n = Math.min(tam, TOPE_REGISTRO_BYTES);
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, tam - n);
        texto = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
      for (const linea of texto.split('\n')) {
        if (!linea.trim()) continue;
        try { const fila = JSON.parse(linea); if (fila && fila.id && CIERRES.has(fila.resultado)) cerrados.add(String(fila.id)); } catch { /* línea cortada */ }
      }
    } catch { /* sin registro */ }
  }
  return cerrados;
}

function sellosAbiertos(opciones) {
  try {
    const m = Number(opciones && opciones.maxMin);
    const maxMin = Number.isFinite(m) && m > 0 ? m : SELLO_ABIERTO_MAX_MIN;
    const dirs = carpetasDeFotos();
    const ahora = Date.now();
    const candidatas = new Map();
    for (const dir of dirs) {
      let nombres = [];
      try { nombres = fs.readdirSync(dir); } catch { continue; }
      for (const n of nombres) {
        if (!n.endsWith('.foto.json')) continue;
        const id = n.slice(0, -'.foto.json'.length);
        if (!idSeguro(id)) continue;
        let mtime;
        try { mtime = fs.statSync(path.join(dir, n)).mtimeMs; } catch { continue; }
        const minutos = (ahora - mtime) / 60000;
        if (minutos >= maxMin) continue;
        const previa = candidatas.get(id);
        if (!previa || minutos < previa.minutos) candidatas.set(id, { dir, minutos });
      }
    }
    if (!candidatas.size) return [];
    const cerrados = idsCerrados(dirs);
    const salida = [];
    for (const [id, c] of candidatas) {
      if (cerrados.has(id)) continue;
      let foto = null;
      try { foto = JSON.parse(fs.readFileSync(path.join(c.dir, id + '.foto.json'), 'utf8')); } catch { /* ilegible: se lista igual */ }
      salida.push({ id: id.length > 24 ? id.slice(0, 24) + '…' : id, idCompleto: id, repo: foto && foto.repo ? foto.repo : null,
        etiqueta: foto && foto.etiqueta ? foto.etiqueta : null, minutos: Math.max(0, Math.round(c.minutos)) });
    }
    return salida.sort((a, b) => a.minutos - b.minutos);
  } catch { return []; }
}

// ---------------------------------------------------------------- operaciones

function motivoIncompleta(m) {
  const partes = [];
  if (m.errores && m.errores.length) partes.push('errores: ' + m.errores.slice(0, 5).join('; '));
  if (m.noMedidas && m.noMedidas.length) partes.push('secciones no medidas: ' + m.noMedidas.slice(0, 5).join(', '));
  if (m.incompleta) partes.push('se agotó el presupuesto de tiempo');
  return partes.join(' | ');
}

// Sin id (CLI): se genera con la huella de la medición. Con id (hooks): se usa el del agente.
// Una medición con errores o incompleta NO se guarda: «no pude medir» no es una foto.
// F3-P1: entorno alterado = el git medido no leería la configuración real (un revisor lo usó para rodear el sello).
// Devuelve solo NOMBRES de variables. Un valor equivalente al real (HOME en sus formas Windows/Git Bash) no cuenta.
function normRutaEnv(p) {
  let r = String(p).replace(/\\/g, '/').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/\/+$/, '');
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}
const VARS_GIT_ALTERAN = /^(GIT_CONFIG_(GLOBAL|SYSTEM|NOSYSTEM|COUNT|PARAMETERS|KEY_.*|VALUE_.*)|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES)$/;
function entornoAlterado(env) {
  env = env || process.env;
  const win = process.platform === 'win32';
  const real = normRutaEnv(os.userInfo().homedir);
  const out = [];
  for (const nombre of Object.keys(env)) {
    const n = win ? nombre.toUpperCase() : nombre;
    const v = env[nombre];
    if (n === 'HOME' && normRutaEnv(v) !== real) out.push(nombre);
    else if (n === 'XDG_CONFIG_HOME' && normRutaEnv(v) !== real + '/.config') out.push(nombre);
    else if (VARS_GIT_ALTERAN.test(n)) out.push(nombre);
  }
  return out.sort();
}

function tomarFoto(repo, id, etiqueta) {
  if (id && !idSeguro(id)) throw new Error('id inválido');
  const rr = resolverRaiz(repo);
  const raiz = rr.raiz;
  if (!raiz) throw new Error(rr.estado === 'error' ? `no se pudo resolver la raíz del repo ${repo} (${rr.causa})` : 'no es un repo git: ' + repo);
  const medicion = medir(raiz);
  const motivo = motivoIncompleta(medicion);
  if (motivo) throw new Error('medición incompleta (' + motivo + ')');
  const alt = entornoAlterado();
  if (alt.length) medicion.entornoAlterado = alt; // dentro de la huella: no se puede quitar sin que la foto deje de coincidir
  const idFinal = id || nuevoId(huellaDe(VERSION_FOTO, raiz, medicion));
  const foto = { version: VERSION_FOTO, id: idFinal, etiqueta: etiqueta || null, repo: raiz, creada: new Date().toISOString(), medicion };
  guardarFoto(idFinal, foto);
  return foto;
}

// Devuelve { estado: 'INTACTO'|'ROTA'|'DESCONOCIDO', cambios, motivo, foto, repo }.
function compararFoto(id, repoEsperado) {
  if (!idSeguro(id)) return { estado: 'DESCONOCIDO', cambios: [], motivo: 'id inválido' };
  let foto;
  try { foto = leerFoto(id); } catch { return { estado: 'DESCONOCIDO', cambios: [], motivo: 'foto ilegible' }; }
  if (!foto || typeof foto !== 'object' || !foto.medicion || !foto.repo) return { estado: 'DESCONOCIDO', cambios: [], motivo: 'no existe la foto ' + id };
  if (foto.version !== VERSION_FOTO) return { estado: 'DESCONOCIDO', cambios: [], motivo: 'foto de versión vieja (' + foto.version + '): tómala de nuevo', foto };
  const esperada = huellaDelId(id);
  if (esperada && huellaDe(foto.version, foto.repo, foto.medicion) !== esperada) {
    return { estado: 'ROTA', cambios: ['foto: el archivo guardado ya no coincide con la huella del id (fue sustituido o alterado)'], foto };
  }
  if (repoEsperado) {
    const re = resolverRaiz(repoEsperado);
    // A15: un error de ejecución o timeout de git NO es «otro repo»: DESCONOCIDO con su causa.
    if (re.estado === 'error') return { estado: 'DESCONOCIDO', cambios: [], motivo: `no se pudo resolver la raíz del repo ${repoEsperado} (${re.causa})`, foto };
    if (!re.raiz || normRepo(re.raiz) !== normRepo(foto.repo)) {
      return { estado: 'DESCONOCIDO', cambios: [], motivo: 'la foto es de otro repo (' + foto.repo + ')', foto };
    }
  }
  const altAhora = entornoAlterado();
  if (altAhora.length) return { estado: 'DESCONOCIDO', cambios: [], motivo: 'entorno alterado: ' + altAhora.join(', '), foto };
  const altFoto = foto.medicion.entornoAlterado;
  if (Array.isArray(altFoto) && altFoto.length) return { estado: 'DESCONOCIDO', cambios: [], motivo: 'la foto se tomó con entorno alterado: ' + altFoto.join(', '), foto };
  const rf = resolverRaiz(foto.repo);
  if (rf.estado === 'error') return { estado: 'DESCONOCIDO', cambios: [], motivo: `no se pudo resolver la raíz del repo ${foto.repo} (${rf.causa})`, foto };
  const raiz = rf.raiz;
  if (!raiz) return { estado: 'ROTA', cambios: ['repo: ya no existe o dejó de ser repo git'], foto };
  let ahora;
  try { ahora = medir(raiz); } catch (e) { return { estado: 'DESCONOCIDO', cambios: [], motivo: 'no se pudo medir: ' + (e && e.message || e), foto, repo: raiz }; }
  // Presupuesto agotado: la medición quedó a medias y las diferencias serían artefactos → DESCONOCIDO.
  // A5: igual si alguna sección de la medición ACTUAL no se pudo medir (listado fallido, tope): DESCONOCIDO aunque
  // hubiera cambios medibles en el resto (decisión aceptada).
  if (ahora.incompleta || (ahora.noMedidas && ahora.noMedidas.length)) return { estado: 'DESCONOCIDO', cambios: [], motivo: 'medición incompleta (' + motivoIncompleta(ahora) + ')', foto, repo: raiz };
  const avisos = [];
  const cambios = comparar(foto.medicion, ahora, '', avisos);
  if (cambios.length) return { estado: 'ROTA', cambios, avisos, foto, repo: raiz };
  const motivo = motivoIncompleta(ahora) || motivoIncompleta(foto.medicion);
  if (motivo) return { estado: 'DESCONOCIDO', cambios: [], motivo: 'medición incompleta (' + motivo + ')', foto, repo: raiz };
  return { estado: 'INTACTO', cambios: [], avisos, foto, repo: raiz };
}

function resumenCambios(cambios) {
  const lista = cambios.slice(0, MAX_CAMBIOS_LISTA).map((c) => '  - ' + c).join('\n');
  return lista + (cambios.length > MAX_CAMBIOS_LISTA ? `\n  … y ${cambios.length - MAX_CAMBIOS_LISTA} más` : '');
}

function tipoAgente(entrada) {
  const t = String((entrada && entrada.agent_type) || '');
  return t.split(':').pop();
}

function leerStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}

function hookInicio() {
  modoHook = true;
  const e = leerStdin();
  if (!e || !REVISORES.has(tipoAgente(e)) || !idSeguro(e.agent_id)) return 0;
  const id = 'agente-' + e.agent_id;
  const rr = resolverRaiz(e.cwd);
  const raiz = rr.raiz;
  let texto;
  if (rr.estado === 'error') {
    // A15: un fallo de git al resolver la raíz no es «no es un repo».
    texto = `Sello de integridad UAEH: no se pudo resolver la raíz del repo de ${e.cwd} (${rr.causa}); ` +
      'tu veredicto sale como UNKNOWN salvo que el orquestador tome su propia foto.';
  } else if (!raiz) {
    texto = 'Sello de integridad UAEH: la carpeta de trabajo no es un repo git, así que no hay sello automático; ' +
      'el orquestador lo toma con uaeh-integridad.cjs foto <repo>. No modifiques nada: reporta.';
  } else {
    try {
      tomarFoto(raiz, id, 'hook ' + tipoAgente(e));
      registrar({ id, agente: tipoAgente(e), repo: raiz, resultado: 'FOTO_OK' });
      // A18: dice QUÉ repo midió (el orquestador comprueba que coincida con el revisado).
      texto = `Sello de integridad UAEH activo sobre el repo medido: ${raiz} — si el repo o el arnés cambian durante tu revisión, ` +
        'tu veredicto queda ANULADO. Si ese NO es el repo que revisas, el orquestador debe comparar el repo revisado. No modifiques nada: reporta.';
    } catch (err) {
      texto = `Sello de integridad UAEH (repo: ${raiz}): no se pudo tomar la foto inicial (` + ((err && err.message) || err) + '); ' +
        'tu veredicto sale como UNKNOWN salvo que el orquestador tome su propia foto.';
      registrar({ id, agente: tipoAgente(e), repo: raiz, resultado: 'SIN_FOTO' });
    }
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: texto } }));
  return 0;
}

function bloquear(razon) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: razon }));
  return 0;
}

// Los hooks son AVISO (las fotos de agente no llevan huella): manda el comando del orquestador.
function hookFin() {
  modoHook = true;
  const e = leerStdin();
  if (!e || !REVISORES.has(tipoAgente(e)) || !idSeguro(e.agent_id)) return 0;
  if (e.stop_hook_active) return 0; // segunda parada tras el aviso: ya quedó registrada, no se duplica
  const id = 'agente-' + e.agent_id;
  // A10: se busca PRIMERO la foto del agente. Si existe (o existe pero está ilegible), la foto ERA esperada y se compara
  // aunque la raíz del cwd ya no se pueda resolver; solo sin foto se mira si el cwd es un repo.
  let foto = null;
  let ilegible = false;
  try { foto = leerFoto(id); } catch { ilegible = true; }
  if (!foto) {
    const rr = ilegible ? { raiz: null } : resolverRaiz(e.cwd);
    const raiz = rr.raiz;
    if (rr.estado === 'error') {
      registrar({ id, agente: tipoAgente(e), repo: null, resultado: 'DESCONOCIDO', motivo: 'no se pudo resolver la raíz: ' + rr.causa });
      return bloquear(`No se pudo comprobar el sello de integridad (no se pudo resolver la raíz del repo de ${e.cwd}: ${rr.causa}): termina reportando estado UNKNOWN y el motivo.`);
    }
    if (!ilegible && !raiz) return 0; // sin foto y cwd sin git: no hay sello automático, manda el comando del orquestador
    registrar({ id, agente: tipoAgente(e), repo: raiz, resultado: 'DESCONOCIDO', motivo: 'foto automática ausente o ilegible' });
    return bloquear(`No se pudo comprobar el sello de integridad (la foto automática falta o es ilegible; repo medido: ${raiz || e.cwd}): termina reportando estado UNKNOWN y el motivo.`);
  }
  const r = compararFoto(id);
  registrar({ id, agente: tipoAgente(e), repo: foto.repo, resultado: r.estado, cambios: r.cambios.slice(0, MAX_CAMBIOS_LISTA), motivo: r.motivo });
  if (r.estado === 'INTACTO') return 0;
  // A18: el motivo dice QUÉ repo se midió, para que el orquestador sepa si coincide con el revisado.
  const razon = r.estado === 'ROTA'
    ? `SELLO DE INTEGRIDAD ROTO (repo medido: ${foto.repo}): durante tu revisión cambió:\n` + resumenCambios(r.cambios) +
      '\nTu veredicto queda ANULADO. No intentes restaurar nada: termina reportando estado BLOCKED con esta lista exacta como evidencia.'
    : `No se pudo comprobar el sello de integridad (repo medido: ${foto.repo}; ` + r.motivo + '): termina reportando estado UNKNOWN y el motivo.';
  return bloquear(razon);
}

// A11: las perillas de prueba UAEH_* reducen o cambian lo medido; si hay alguna activa se dice (por stderr, para no
// ensuciar el id ni la línea de veredicto que leen los orquestadores). Solo nombres, nunca valores.
function avisarPerillas() {
  const activas = PERILLAS.filter((k) => process.env[k] !== undefined && process.env[k] !== '');
  if (activas.length) console.error('perillas de prueba activas: ' + activas.join(', '));
}

function principal(argv) {
  const [op, arg] = argv;
  if (op === 'foto' || op === 'comparar') avisarPerillas();
  if (op === 'hook-inicio') return hookInicio();
  if (op === 'hook-fin') return hookFin();
  if (op === 'foto') {
    if (!arg) { console.log('DESCONOCIDO: falta la ruta del repo'); return 4; }
    const i = argv.indexOf('--etiqueta');
    const etiqueta = i > 0 ? argv[i + 1] : null;
    try {
      const f = tomarFoto(arg, null, etiqueta);
      const alt = f.medicion.entornoAlterado;
      if (alt) console.error('AVISO: entorno alterado: ' + alt.join(', ') + ' → la comparación de esta foto dará DESCONOCIDO');
      console.log(f.id);
      return 0;
    } catch (err) {
      console.log('DESCONOCIDO: ' + ((err && err.message) || err));
      return 4;
    }
  }
  if (op === 'comparar') {
    const r = compararFoto(arg, argv[2]);
    registrar({ id: arg, repo: r.foto ? r.foto.repo : null, etiqueta: r.foto ? r.foto.etiqueta : null, resultado: r.estado, cambios: r.cambios.slice(0, MAX_CAMBIOS_LISTA), motivo: r.motivo });
    const donde = r.repo ? ` [repo medido: ${r.repo}]` : '';
    if (r.estado === 'INTACTO') { console.log('INTACTO: nada cambió desde la foto ' + arg + donde + (r.avisos && r.avisos.length ? '\n' + r.avisos.map((a) => 'AVISO: ' + a).join('\n') : '')); return 0; }
    if (r.estado === 'ROTA') { console.log(`ROTA: ${r.cambios.length} cambio(s) desde la foto ${arg}${donde} → el veredicto del revisor queda ANULADO\n` + resumenCambios(r.cambios)); return 3; }
    console.log('DESCONOCIDO: ' + r.motivo + donde); return 4;
  }
  console.log('Uso: uaeh-integridad.cjs foto <repo> [--etiqueta <texto>] | comparar <id> [<repo>] | hook-inicio | hook-fin');
  return 2;
}

module.exports = { sellosAbiertos, SELLO_ABIERTO_MAX_MIN, entornoAlterado, medir, comparar, tomarFoto, compararFoto, REVISORES, DIRS_SALIDA, EXCLUSIONES_NOMBRE, textoTomlNormalizado };

if (require.main === module) {
  let codigo;
  try { codigo = principal(process.argv.slice(2)); } catch (err) {
    const motivo = (err && err.message) || String(err);
    if (modoHook) {
      // A10: un hook nunca sale 4 con texto suelto. En la parada, bloquea pidiendo UNKNOWN; al inicio, avisa.
      codigo = 0;
      if (process.argv[2] === 'hook-fin') {
        bloquear('No se pudo comprobar el sello de integridad (error interno: ' + motivo + '): termina reportando estado UNKNOWN y el motivo.');
      } else {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext:
          'Sello de integridad UAEH: error interno al tomar la foto inicial (' + motivo + '); tu veredicto sale como UNKNOWN salvo que el orquestador tome su propia foto.' } }));
      }
    } else {
      console.log('DESCONOCIDO: error interno (' + motivo + ')');
      codigo = 4;
    }
  }
  process.exitCode = codigo;
}
