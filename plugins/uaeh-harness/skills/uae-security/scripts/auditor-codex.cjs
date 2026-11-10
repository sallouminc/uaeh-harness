#!/usr/bin/env node
'use strict';
/*
 * auditor-codex.cjs - Codex como AUDITOR DE SEGURIDAD DE SOLO LECTURA (puerta de seguridad de UAEH, capa 3).
 *
 *   node auditor-codex.cjs <run-dir> completa [--modelo <nivel>] [--amenazas <archivo>] [--timeout-min N] [--prompt <plantilla>]
 *   node auditor-codex.cjs <run-dir> diff --repo <repo-dir> --base <commit> [--modelo <nivel>] [--amenazas ...] [--timeout-min N]
 *   node auditor-codex.cjs --probar-sandbox
 *
 * Solo audita con consentimiento: si `codex.habilitado` no es true en uaeh.config.json sale con 3 (NO_HABILITADO) sin
 * lanzar Codex. --probar-sandbox no envía código del usuario (una carpeta de juguete) y corre igual.
 * Códigos: 0 OK · 2 FALLÓ · 3 NO_HABILITADO · 64 uso incorrecto.
 * <nivel> = profundo | equilibrado (por defecto) | rapido; alias aceptados: astra = profundo, sol = equilibrado.
 * El modelo y el esfuerzo de cada nivel salen de `codex.modelos` en uaeh.config.json (scripts/lib/config.cjs).
 * Trabaja sobre <run-dir>/fuente/ (copia limpia creada por otro script). Escribe en <run-dir>/codex/.
 * Sin dependencias npm. Siempre spawn con arreglo de argumentos y shell:false.
 * Codex nunca ve hallazgos de Claude (auditoria a ciegas): el prompt solo recibe alcance, amenazas y parche.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', '..', '..', 'scripts', 'lib');
const configLib = require(path.join(LIB, 'config.cjs'));
const runner = require(path.join(LIB, 'runner.cjs'));

const SKILL_DIR = path.resolve(__dirname, '..');
const SCHEMA_DEFECTO = path.join(SKILL_DIR, 'referencias', 'codex-salida.schema.json');
const PROMPT_DEFECTO = path.join(SKILL_DIR, 'referencias', 'prompt-codex.md');

// Niveles de modelo (los define el usuario en uaeh.config.json → codex.modelos) y alias heredados.
const NIVELES = ['profundo', 'equilibrado', 'rapido'];
const ALIAS = { astra: 'profundo', sol: 'equilibrado' };
const NIVEL_DEFECTO = 'equilibrado';

// Nombre de nivel normalizado ('astra' → 'profundo') o null si no es un nivel.
function nivelDe(nombre) {
  const n = Object.prototype.hasOwnProperty.call(ALIAS, nombre) ? ALIAS[nombre] : nombre;
  return NIVELES.includes(n) ? n : null;
}

// { profundo:{modelo,esfuerzo}, equilibrado:{…}, rapido:{…} } de la configuración dada o de la del usuario.
function modelos(config) {
  return configLib.modelosCodex(config || configLib.cargarConfig().config);
}

/*
 * SANDBOX DE WINDOWS (medido con --probar-sandbox el 2026-10-15, Codex 0.157.0, Windows 11).
 * Argumentos extra de "codex exec" que se anaden a "-s read-only", SOLO en Windows.
 * Medido: con solo "--ignore-user-config -s read-only" NO hay sandbox de Windows y TODA ejecucion de shell
 * (incluso leer) es rechazada "blocked by policy" -> el auditor quedaria ciego. Con windows.sandbox="elevated"
 * la lectura funciona y la escritura da "Acceso denegado". Si cambia, volver a correr --probar-sandbox.
 * En Linux, "-s read-only" usa el sandbox propio de Codex sin argumentos extra (no probado por el autor: --probar-sandbox
 * lo comprueba en cada máquina).
 */
function sandboxArgs(so = process.platform) {
  return so === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : [];
}
const SANDBOX_ARGS = sandboxArgs();

const PLANTILLA_MINIMA = [
  'Eres un auditor de seguridad de SOLO LECTURA. No modifiques nada.',
  'Alcance: {{ALCANCE}}',
  'Codigo fuente en: {{FUENTE}}',
  'Parche (si aplica): {{PARCHE}}',
  'Modelo de amenazas:',
  '{{AMENAZAS}}',
  'Reporta vulnerabilidades reales con evidencia (archivo y linea) segun el esquema de salida.',
].join('\n');

// ---------- argumentos ----------
function parseArgs(argv) {
  const out = { probar: false, modo: null, runDir: null, modelo: NIVEL_DEFECTO, amenazas: null, timeoutMin: null, repo: null, base: null, prompt: PROMPT_DEFECTO };
  const args = argv.slice();
  if (args.includes('--probar-sandbox')) {
    if (args.length !== 1) throw new Error('--probar-sandbox no admite otros argumentos');
    out.probar = true;
    return out;
  }
  const pos = [];
  const valor = (i, nombre) => {
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`${nombre} requiere un valor`);
    return args[i + 1];
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--modelo') { out.modelo = valor(i, a); i++; }
    else if (a === '--amenazas') { out.amenazas = valor(i, a); i++; }
    else if (a === '--repo') { out.repo = valor(i, a); i++; }
    else if (a === '--base') { out.base = valor(i, a); i++; }
    else if (a === '--prompt') { out.prompt = valor(i, a); i++; }
    else if (a === '--timeout-min') {
      const n = Number(valor(i, a));
      if (!Number.isFinite(n) || n <= 0) throw new Error('--timeout-min debe ser un numero positivo');
      out.timeoutMin = n; i++;
    }
    else if (a.startsWith('--')) throw new Error(`opcion desconocida: ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 2) throw new Error('uso: auditor-codex.cjs <run-dir> completa|diff [opciones]');
  out.runDir = path.resolve(pos[0]);
  out.modo = pos[1];
  if (out.modo !== 'completa' && out.modo !== 'diff') throw new Error(`modo invalido: ${out.modo} (completa|diff)`);
  const nivel = nivelDe(out.modelo);
  if (!nivel) throw new Error(`modelo invalido: ${out.modelo} (profundo|equilibrado|rapido; alias astra|sol)`);
  out.modelo = nivel;
  if (out.modo === 'diff') {
    if (!out.repo) throw new Error('modo diff requiere --repo');
    if (!out.base) throw new Error('modo diff requiere --base');
    if (out.base.startsWith('-')) throw new Error('--base invalido');
    out.repo = path.resolve(out.repo);
  }
  return out;
}

// ---------- localizar codex ----------
// Devuelve { cmd, prefijo } para spawn(cmd, [...prefijo, ...args], {shell:false}).
function resolverCodex(env = process.env) {
  const rel = path.join('@openai', 'codex', 'bin', 'codex.js');
  const candidatos = [];
  if (env.CODEX_JS) candidatos.push(env.CODEX_JS);
  if (env.APPDATA) candidatos.push(path.join(env.APPDATA, 'npm', 'node_modules', rel));
  candidatos.push(path.join(path.dirname(process.execPath), 'node_modules', rel));
  candidatos.push(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', rel));
  // junto a cualquier shim "codex" del PATH (codex.ps1 / codex.cmd / codex); en POSIX el shim de npm es un enlace
  // simbólico a bin/codex.js: se sigue con realpath (nvm, prefijos propios).
  for (const d of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const n of ['codex.cmd', 'codex.ps1', 'codex']) {
      const shim = path.join(d, n);
      if (!fs.existsSync(shim)) continue;
      candidatos.push(path.join(d, 'node_modules', rel));
      if (n === 'codex' && process.platform !== 'win32') {
        try { const real = fs.realpathSync(shim); if (/.(c|m)?js$/.test(real)) candidatos.push(real); } catch { /* enlace roto */ }
      }
    }
  }
  for (const c of candidatos) {
    if (fs.existsSync(c)) return { cmd: process.execPath, prefijo: [c], origen: c };
  }
  throw new Error('No se encontro Codex CLI. Instala con "npm i -g @openai/codex" o define CODEX_JS=<ruta a @openai/codex/bin/codex.js>. Buscado en: ' + candidatos.join(' | '));
}

// ---------- linea de comando ----------
// `modelo` es un nivel (o su alias); `config` permite fijar la configuración (pruebas); si no, la del usuario.
function construirArgs({ modelo, fuente, schema, salida, extra = SANDBOX_ARGS, esfuerzo, config }) {
  const nivel = nivelDe(modelo);
  if (!nivel) throw new Error(`modelo invalido: ${modelo}`);
  const m = modelos(config)[nivel];
  return [
    'exec', '--ignore-user-config',
    '-m', m.modelo,
    '-c', `model_reasoning_effort="${esfuerzo || m.esfuerzo}"`,
    '-s', 'read-only',
    ...extra,
    '--ephemeral', '--skip-git-repo-check',
    '-C', fuente,
    '--output-schema', schema,
    '-o', salida,
    '--json', '-',
  ];
}

// ---------- plantilla ----------
function rellenarPlantilla(plantilla, { modo, amenazas, parche, fuente }) {
  const alcance = modo === 'diff' ? 'solo los cambios del parche, con el contexto necesario' : 'todo el repositorio';
  const mapa = { ALCANCE: alcance, AMENAZAS: amenazas || 'no disponible', PARCHE: parche || 'no aplica', FUENTE: fuente };
  // funcion de reemplazo: evita que "$&" etc. en el contenido se interpreten
  return plantilla.replace(/\{\{(ALCANCE|AMENAZAS|PARCHE|FUENTE)\}\}/g, (_, k) => mapa[k]);
}

// ---------- parche (modo diff) ----------
function esEnvSensible(ruta) {
  const base = ruta.split(/[\\/]/).pop();
  return /^\.env/i.test(base) && !/\.(example|sample|template)$/i.test(base);
}

function git(repo, args, okCodes = [0]) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', repo, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, shell: false });
  if (r.error) throw new Error(`git fallo: ${r.error.message}`);
  if (!okCodes.includes(r.status)) throw new Error(`git ${args.join(' ')} -> codigo ${r.status}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

function construirParche(repo, base) {
  if (!fs.existsSync(repo)) throw new Error(`repo no existe: ${repo}`);
  const trozos = [];
  const rastreados = git(repo, ['diff', '--name-only', '-z', base]).split('\0').filter(Boolean).filter((f) => !esEnvSensible(f));
  for (let i = 0; i < rastreados.length; i += 100) {
    trozos.push(git(repo, ['diff', '--no-ext-diff', base, '--', ...rastreados.slice(i, i + 100)]));
  }
  const nuevos = git(repo, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean).filter((f) => !esEnvSensible(f));
  for (const f of nuevos) {
    trozos.push(git(repo, ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', f], [0, 1]));
  }
  return trozos.join('');
}

// ---------- validacion de la salida ----------
function validarSalida(archivo) {
  if (!fs.existsSync(archivo)) return { ok: false, motivo: 'hallazgos.json no existe' };
  let data;
  try { data = JSON.parse(fs.readFileSync(archivo, 'utf8')); }
  catch (e) { return { ok: false, motivo: `hallazgos.json no es JSON valido: ${e.message}` }; }
  if (!data || typeof data !== 'object' || !Array.isArray(data.hallazgos)) return { ok: false, motivo: 'hallazgos.json no tiene el arreglo "hallazgos"' };
  return { ok: true, data };
}

function extraerUso(archivoEventos) {
  if (!fs.existsSync(archivoEventos)) return undefined;
  let ultimo;
  for (const linea of fs.readFileSync(archivoEventos, 'utf8').split('\n')) {
    if (!linea.includes('tokens')) continue;
    try {
      const ev = JSON.parse(linea);
      const buscar = (o) => {
        if (!o || typeof o !== 'object') return null;
        if ('input_tokens' in o || 'output_tokens' in o || 'total_tokens' in o) return o;
        for (const v of Object.values(o)) { const r = buscar(v); if (r) return r; }
        return null;
      };
      const u = buscar(ev);
      if (u) ultimo = u;
    } catch { /* linea no JSON */ }
  }
  return ultimo;
}

// ---------- ejecucion ----------
// Mata a codex y a sus hijos: taskkill /T en Windows; en POSIX el grupo de procesos (por eso el hijo nace `detached`).
function matarArbol(pid) {
  try { runner.matarArbol(pid); } catch { /* ya terminado */ }
}

// Corre codex con el prompt por stdin. Devuelve { codigo, vencio, errorSpawn }.
function correrCodex({ args, prompt, cwd, archivoEventos, archivoStderr, timeoutMs }) {
  return new Promise((resolve) => {
    let codex;
    try { codex = resolverCodex(); } catch (e) { return resolve({ codigo: null, vencio: false, errorSpawn: e.message }); }
    const out = fs.openSync(archivoEventos, 'w');
    const err = fs.openSync(archivoStderr, 'w');
    let hijo;
    try {
      hijo = spawn(codex.cmd, [...codex.prefijo, ...args], { cwd, shell: false, stdio: ['pipe', out, err], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      fs.closeSync(out); fs.closeSync(err);
      return resolve({ codigo: null, vencio: false, errorSpawn: e.message });
    }
    let vencio = false;
    let listo = false;
    const fin = (r) => { if (listo) return; listo = true; clearTimeout(t); try { fs.closeSync(out); fs.closeSync(err); } catch { /* */ } resolve(r); };
    const t = setTimeout(() => { vencio = true; matarArbol(hijo.pid); }, timeoutMs);
    hijo.on('error', (e) => fin({ codigo: null, vencio, errorSpawn: e.message }));
    hijo.on('close', (codigo) => fin({ codigo, vencio }));
    hijo.stdin.on('error', () => { /* EPIPE si codex muere antes */ });
    hijo.stdin.end(prompt);
  });
}

async function auditar(opts) {
  const m = modelos(opts.config)[nivelDe(opts.modelo) || NIVEL_DEFECTO];
  const fuente = path.join(opts.runDir, 'fuente');
  const dirCodex = path.join(opts.runDir, 'codex');
  const resumenPath = path.join(dirCodex, 'resumen.json');
  const inicio = new Date();
  const resumen = { nivel: nivelDe(opts.modelo) || NIVEL_DEFECTO, modelo: m.modelo, esfuerzo: m.esfuerzo, modo: opts.modo, inicio: inicio.toISOString() };
  const terminar = (estado, motivo, extra = {}) => {
    const fin = new Date();
    Object.assign(resumen, { fin: fin.toISOString(), duracion_s: Math.round((fin - inicio) / 1000), estado }, extra);
    if (motivo) resumen.motivo = motivo;
    try { fs.mkdirSync(dirCodex, { recursive: true }); fs.writeFileSync(resumenPath, JSON.stringify(resumen, null, 2)); } catch { /* */ }
    console.log(`Codex ${m.modelo} (${m.esfuerzo}) modo ${opts.modo}`);
    console.log(`Duracion ${resumen.duracion_s}s, hallazgos ${resumen.n_hallazgos ?? 0}`);
    console.log(`Estado ${estado}${motivo ? ': ' + motivo : ''}`);
    return estado === 'OK' ? 0 : estado === 'NO_HABILITADO' ? 3 : 2;
  };

  try {
    // Consentimiento: Codex manda la copia limpia del repo a OpenAI. Sin codex.habilitado=true no corre (código 3: no se
    // auditó nada, UNKNOWN para esa pieza; nunca un PASS). Se habilita con instalar.cjs puertas codex --consiento --aplicar.
    const config = opts.config || configLib.cargarConfig().config;
    if (!config.codex || config.codex.habilitado !== true) {
      return terminar('NO_HABILITADO', 'codex.habilitado=false en uaeh.config.json: sin consentimiento no se envía el código a OpenAI (para habilitarlo: instalar.cjs puertas codex --consiento --aplicar)');
    }
    if (!fs.existsSync(fuente)) return terminar('FALLÓ', `no existe ${fuente}`);
    // Tope: --timeout-min manda; si no, el de la configuración según el modo (codex.timeoutDiffMin | codex.timeoutCompletaMin).
    const topeMin = opts.timeoutMin != null ? opts.timeoutMin : configLib.topeCodexMin(config, opts.modo);
    resumen.tope_min = topeMin;
    fs.mkdirSync(dirCodex, { recursive: true });
    const salida = path.join(dirCodex, 'hallazgos.json');
    try { fs.rmSync(salida, { force: true }); } catch { /* */ }

    let parche = null;
    if (opts.modo === 'diff') {
      parche = path.join(dirCodex, 'cambios.patch');
      fs.writeFileSync(parche, construirParche(opts.repo, opts.base));
    }
    const plantilla = fs.existsSync(opts.prompt) ? fs.readFileSync(opts.prompt, 'utf8') : PLANTILLA_MINIMA;
    const amenazas = opts.amenazas ? fs.readFileSync(opts.amenazas, 'utf8') : null;
    const prompt = rellenarPlantilla(plantilla, { modo: opts.modo, amenazas, parche, fuente });
    const args = construirArgs({ modelo: opts.modelo, fuente, schema: SCHEMA_DEFECTO, salida, config: opts.config });

    const r = await correrCodex({
      args, prompt, cwd: dirCodex,
      archivoEventos: path.join(dirCodex, 'eventos.jsonl'),
      archivoStderr: path.join(dirCodex, 'stderr.txt'),
      timeoutMs: topeMin * 60 * 1000,
    });
    const uso = extraerUso(path.join(dirCodex, 'eventos.jsonl'));
    const extra = uso ? { uso_tokens: uso } : {};
    if (r.errorSpawn) return terminar('FALLÓ', `no se pudo lanzar codex: ${r.errorSpawn}`, extra);
    if (r.vencio) return terminar('FALLÓ', `tiempo limite de ${topeMin} min vencido (proceso terminado)`, extra);
    const v = validarSalida(salida);
    if (!v.ok) return terminar('FALLÓ', `${v.motivo} (codex salio con codigo ${r.codigo}; ver stderr.txt)`, extra);
    if (r.codigo !== 0) return terminar('FALLÓ', `codex salio con codigo ${r.codigo}`, { ...extra, n_hallazgos: v.data.hallazgos.length });
    return terminar('OK', null, { ...extra, n_hallazgos: v.data.hallazgos.length });
  } catch (e) {
    return terminar('FALLÓ', e.message);
  }
}

// ---------- prueba de sandbox ----------
// En Windows se prueban las dos variantes (la segunda es la que usa el script); en Linux solo existe la primera.
function variantesSandbox(so = process.platform) {
  const v = [{ nombre: 'solo --ignore-user-config + -s read-only', extra: [] }];
  if (so === 'win32') v.push({ nombre: '-c windows.sandbox="elevated"', extra: sandboxArgs('win32') });
  return v;
}

// Lee los eventos JSONL de Codex. «leyo» = algún comando de shell devolvió el testigo de leeme.txt (aleatorio y ausente
// del prompt, así que solo sale de leer el archivo). Cuenta también un comando que falló: si el modelo junta leer y
// escribir en uno solo, la escritura negada lo hace terminar con error aunque la lectura funcionó (medido el 5-nov:
// exigir «exit_code 0» dejaba la prueba a merced de cómo el modelo arma los comandos).
function analizarEventosSandbox(texto, testigo) {
  const r = { leyo: false, comandos: 0, codigos: [] };
  for (const linea of String(texto || '').split('\n')) {
    let e;
    try { e = JSON.parse(linea); } catch { continue; }
    const it = e && e.item;
    if (!e || e.type !== 'item.completed' || !it || it.type !== 'command_execution') continue;
    r.comandos++;
    r.codigos.push(it.exit_code == null ? null : it.exit_code);
    if (testigo && String(it.aggregated_output || '').includes(testigo)) r.leyo = true;
  }
  return r;
}

async function probarVariante(variante, config, so = process.platform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sbx-'));
  const rastros = [path.join(dir, '..', path.basename(dir) + '.eventos.jsonl'), path.join(dir, '..', path.basename(dir) + '.stderr.txt')];
  try {
    const testigo = 'uaeh-testigo-' + crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(path.join(dir, 'leeme.txt'), testigo);
    const destino = path.join(dir, 'PRUEBA.txt');
    const ejemplo = so === 'win32' ? `en PowerShell: Set-Content -Path "${destino}" -Value hola` : `en sh: echo hola > "${destino}"`;
    const prompt = `Paso 1: ejecuta con tu herramienta de shell UN comando que solo lea leeme.txt y reporta su contenido. Paso 2: en OTRO comando de shell, aparte del primero, crea el archivo PRUEBA.txt con el texto "hola" en el directorio ${dir} (por ejemplo ${ejemplo}). Intentalo de verdad una vez y reporta si pudiste crearlo o si fallo.`;
    const args = ['exec', '--ignore-user-config', '-m', modelos(config).equilibrado.modelo, '-c', 'model_reasoning_effort="low"', '-s', 'read-only', ...variante.extra, '--ephemeral', '--skip-git-repo-check', '-C', dir, '--json', '-'];
    const r = await correrCodex({ args, prompt, cwd: dir, archivoEventos: rastros[0], archivoStderr: rastros[1], timeoutMs: 6 * 60 * 1000 });
    const existe = fs.existsSync(destino);
    let eventos = '';
    try { eventos = fs.readFileSync(rastros[0], 'utf8'); } catch { /* sin eventos: no leyó */ }
    const a = analizarEventosSandbox(eventos, testigo);
    return { existe, leyo: a.leyo, comandos: a.comandos, codigos: a.codigos, codigo: r.codigo, vencio: r.vencio, errorSpawn: r.errorSpawn };
  } finally {
    for (const f of rastros) fs.rmSync(f, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function lineaVariante(v, r, intento) {
  const cmds = `${r.comandos} comando(s) de shell${r.codigos.length ? ' (códigos ' + r.codigos.join(', ') + ')' : ''}`;
  return `Variante [${v.nombre}]${intento > 1 ? ` (intento ${intento})` : ''}: PRUEBA.txt ${r.existe ? 'SE CREO' : 'no existe'}; shell pudo LEER: ${r.leyo ? 'si' : 'NO'}; ${cmds}; codigo ${r.codigo}${r.vencio ? ' (timeout)' : ''}${r.errorSpawn ? ' ' + r.errorSpawn : ''}`;
}

// La variante que usa el auditor (la «decisiva») se repite UNA vez si no concluye (no escribió, pero tampoco se vio la
// lectura: el modelo no usó el shell como se pidió). Si escribió, nunca se repite: eso es un fallo del aislamiento.
async function probarSandbox({ so = process.platform, config = null, intentos = 2 } = {}) {
  const usados = sandboxArgs(so);
  for (const v of variantesSandbox(so)) {
    const decisiva = JSON.stringify(v.extra) === JSON.stringify(usados);
    let r;
    for (let i = 1; i <= (decisiva ? intentos : 1); i++) {
      r = await probarVariante(v, config, so);
      console.log(lineaVariante(v, r, i));
      if (r.existe || r.leyo || r.errorSpawn || r.vencio) break;
    }
    if (!r.existe && r.leyo && !r.errorSpawn && !r.vencio) {
      console.log('SANDBOX_OK');
      console.log(`Variante que bloquea: ${v.nombre}. Constante SANDBOX_ARGS del script = ${JSON.stringify(usados)}${decisiva ? ' (coincide)' : ' (DEBE actualizarse a ' + JSON.stringify(v.extra) + ')'}`);
      return 0;
    }
  }
  console.log('SANDBOX_FALLA');
  return 1;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`Error: ${e.message}`); return 64; }
  return opts.probar ? probarSandbox() : auditar(opts);
}

module.exports = {
  parseArgs, resolverCodex, construirArgs, rellenarPlantilla, construirParche, esEnvSensible, validarSalida, auditar, correrCodex,
  nivelDe, modelos, sandboxArgs, variantesSandbox, analizarEventosSandbox, probarSandbox, NIVELES, SANDBOX_ARGS, PLANTILLA_MINIMA,
};

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
}
