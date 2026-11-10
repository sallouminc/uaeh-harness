// tests/helpers/entorno.cjs — entorno hermético para las pruebas del repo.
//
// Cada prueba trabaja en una casa temporal: HOME/USERPROFILE, CLAUDE_CONFIG_DIR, UAEH_HOME,
// TEMP/TMP/TMPDIR y GIT_CONFIG_GLOBAL apuntan dentro de ella. Nada toca la configuración real
// del usuario y nada depende de ella. Las variables UAEH_* y las de Claude Code que cambian el
// comportamiento se vacían salvo que la prueba las fije.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ_REPO = path.resolve(__dirname, '..', '..');
const RAIZ_KIT = path.join(RAIZ_REPO, 'plugins', 'uaeh-kit');
const RAIZ_HARNESS = path.join(RAIZ_REPO, 'plugins', 'uaeh-harness');

const VARIABLES_A_VACIAR = [
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR',
  'UAEH_HOME', 'UAEH_TZ', 'UAEH_AHORA', 'UAEH_ARNES', 'UAEH_GIT_HOOKS', 'UAEH_RUNS_DIR', 'USO_RAIZ',
  'USO_PASOS_RAIZ', 'USO_PASOS_AHORA', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
];

function escribir(ruta, contenido) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, contenido, 'utf8');
  return ruta;
}

// Ruta real (larga, con mayúsculas de disco) de una carpeta: en los runners de Windows de GitHub, TEMP viene con nombre
// corto 8.3 (la carpeta de usuario como RUNNER~1) y git, realpath y los scripts devuelven la larga; comparar las dos formas falla.
function rutaReal(p) {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

// Crea la casa temporal y devuelve rutas + env listo para spawn.
function entornoTemporal(prefijo = 'uaeh-prueba-') {
  const dir = rutaReal(fs.mkdtempSync(path.join(os.tmpdir(), prefijo)));
  const home = path.join(dir, 'casa');
  const claudeHome = path.join(home, '.claude');
  const uaehHome = path.join(claudeHome, 'uaeh');
  const tmp = path.join(dir, 'tmp');
  const proyecto = path.join(dir, 'proyecto');
  for (const d of [home, claudeHome, uaehHome, tmp, proyecto]) fs.mkdirSync(d, { recursive: true });
  escribir(path.join(dir, 'gitconfig'), '[user]\n\tname = Prueba UAEH\n\temail = prueba@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');

  const env = { ...process.env };
  for (const k of VARIABLES_A_VACIAR) delete env[k];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeHome, UAEH_HOME: uaehHome,
    TEMP: tmp, TMP: tmp, TMPDIR: tmp, GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1', UAEH_AHORA: '2026-10-30T20:00:00Z', UAEH_TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  });

  return {
    dir, home, claudeHome, uaehHome, tmp, proyecto, env,
    escribir: (rel, contenido) => escribir(path.isAbsolute(rel) ? rel : path.join(dir, rel), contenido),
    limpiar() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* en Windows puede quedar un instante bloqueado */ } },
  };
}

// Corre un script de Node con stdin opcional. Devuelve { status, stdout, stderr, json() }.
function correr(script, args = [], opciones = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    input: opciones.stdin == null ? '' : (typeof opciones.stdin === 'string' ? opciones.stdin : JSON.stringify(opciones.stdin)),
    env: opciones.env || process.env,
    cwd: opciones.cwd || RAIZ_REPO,
    timeout: opciones.timeout || 60000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout || '';
  return {
    status: r.status, signal: r.signal, stdout, stderr: r.stderr || '', error: r.error,
    json() { try { return JSON.parse(stdout); } catch { return null; } },
  };
}

// Corre git en un directorio con el env hermético. Lanza si falla (salvo { tolerar: true }).
function git(cwd, args, env, opciones = {}) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0 && !opciones.tolerar) throw new Error(`git ${args.join(' ')} falló (${r.status}): ${r.stderr}`);
  return r;
}

// Línea de transcript de Claude Code con uso de tokens (forma mínima que leen los scripts).
function lineaUso({ entrada = 0, cacheLeida = 0, cacheEscrita = 0, salida = 0, modelo = 'claude-sonnet-5-5', id, timestamp, lateral = false, tipo = 'assistant' } = {}) {
  return JSON.stringify({
    type: tipo, timestamp: timestamp || '2026-10-30T19:00:00Z', isSidechain: lateral, uuid: id || `u-${Math.random().toString(36).slice(2)}`,
    message: {
      id: id || `msg-${Math.random().toString(36).slice(2)}`, model: modelo, role: 'assistant', content: [],
      usage: { input_tokens: entrada, cache_read_input_tokens: cacheLeida, cache_creation_input_tokens: cacheEscrita, output_tokens: salida },
    },
  });
}

// settings.json mínimo de Claude Code para pruebas.
function settingsBasico(extra = {}) {
  return JSON.stringify({ $schema: 'https://json.schemastore.org/claude-code-settings.json', ...extra }, null, 2);
}

// Salta la prueba si falta una herramienta externa; en CI estricto (UAEH_CI=1) el salto es fallo.
function requiereHerramienta(t, nombre, args = ['--version']) {
  const r = spawnSync(nombre, args, { encoding: 'utf8' });
  if (r.status === 0) return true;
  const motivo = `falta ${nombre} en PATH`;
  if (process.env.UAEH_CI === '1' || process.env.UAEH_PRUEBAS_ESTRICTO === '1') throw new Error(`prueba omitida en modo estricto: ${motivo}`);
  t.skip(motivo);
  return false;
}

// Los hooks miden los CLAUDE.md desde el cwd hasta la raíz del disco (así los carga Claude Code), de modo que
// un CLAUDE.md ajeno en un ancestro de la carpeta temporal del sistema podría cambiar el resultado de una
// prueba. Si alguno trae el bloque UAEH (`bloque`) o pasa del límite de tamaño (`tamano`), la prueba se omite
// con el motivo escrito; en modo estricto (CI) es fallo. Devuelve true si el entorno está limpio.
function exigirAncestrosLimpios(t, { bloque = true, tamano = true } = {}) {
  const comun = require(path.join(RAIZ_KIT, 'scripts', 'lib', 'comun.cjs'));
  const ajenos = comun.claudeMdDelProyecto(os.tmpdir()).filter((f) => {
    const texto = comun.leerTexto(f);
    if (texto == null) return false;
    return (bloque && comun.bloqueUaeh(texto).presente) || (tamano && texto.length > comun.LIMITE_CLAUDE_MD);
  });
  if (!ajenos.length) return true;
  const motivo = `un CLAUDE.md fuera de la casa temporal (${ajenos.join(', ')}) trae el bloque UAEH o pasa del límite: la prueba no sería hermética`;
  if (process.env.UAEH_CI === '1' || process.env.UAEH_PRUEBAS_ESTRICTO === '1') throw new Error(`prueba omitida en modo estricto: ${motivo}`);
  t.skip(motivo);
  return false;
}

// ── Ayudas para la capa 2 (arnés) ──────────────────────────────────────────────────────

// Ruta de un `bash` real para pruebas que lo necesitan: en Windows, el de Git for Windows (hermano de git.exe en
// <Git>/bin/, o <Git>/usr/bin/); en POSIX, el `bash` del PATH. GIT_BASH la fija a mano. null si no hay ninguno.
function rutaBash() {
  if (process.env.GIT_BASH && fs.existsSync(process.env.GIT_BASH)) return process.env.GIT_BASH;
  if (process.platform !== 'win32') {
    const r = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
    return r.status === 0 ? 'bash' : null;
  }
  const where = spawnSync('where.exe', ['git'], { encoding: 'utf8' });
  const candidatos = [];
  for (const linea of (where.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    // <Git>/cmd/git.exe o <Git>/bin/git.exe o <Git>/mingw64/bin/git.exe → <Git>/bin/bash.exe
    let dir = path.dirname(linea);
    for (let i = 0; i < 3; i++) {
      candidatos.push(path.join(dir, 'bin', 'bash.exe'), path.join(dir, 'usr', 'bin', 'bash.exe'));
      dir = path.dirname(dir);
    }
  }
  candidatos.push('C:\\Program Files\\Git\\bin\\bash.exe');
  return candidatos.find((c) => fs.existsSync(c)) || null;
}

// Como requiereHerramienta, para bash: devuelve la ruta o salta la prueba (fallo en modo estricto).
function requiereBash(t) {
  const b = rutaBash();
  if (b) return b;
  const motivo = 'no hay bash disponible para la prueba';
  if (process.env.UAEH_CI === '1' || process.env.UAEH_PRUEBAS_ESTRICTO === '1') throw new Error(`prueba omitida en modo estricto: ${motivo}`);
  t.skip(motivo);
  return null;
}

// Escribe un gitconfig GLOBAL temporal para el entorno `e` (identidad de prueba, sin firma GPG) y, si se pasa
// `hooksPath`, la guarda de git apuntando ahí (con «/», como la escribe el instalador). Devuelve la ruta del archivo.
// El entorno `e.env` queda apuntando a ese archivo (GIT_CONFIG_GLOBAL).
function gitConfigGlobal(e, { hooksPath = null, extra = '' } = {}) {
  const ruta = path.join(e.dir, hooksPath ? 'gitconfig-con-guarda' : 'gitconfig-sin-guarda');
  let texto = '[user]\n\tname = Prueba UAEH\n\temail = prueba@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n';
  if (hooksPath) texto += `[core]\n\thooksPath = ${path.resolve(hooksPath).replace(/\\/g, '/')}\n`;
  if (extra) texto += extra.endsWith('\n') ? extra : `${extra}\n`;
  fs.writeFileSync(ruta, texto, 'utf8');
  e.env.GIT_CONFIG_GLOBAL = ruta;
  return ruta;
}

// Repo git temporal dentro de la casa (con un commit inicial si `inicial` no es false). Devuelve su ruta.
function repoTemporal(e, nombre = 'repo', { inicial = true } = {}) {
  const dir = path.join(e.dir, nombre);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q'], e.env);
  if (inicial) {
    fs.writeFileSync(path.join(dir, 'base.txt'), 'hola\n', 'utf8');
    git(dir, ['add', 'base.txt'], e.env);
    git(dir, ['commit', '-q', '-m', 'inicial'], e.env);
  }
  return dir;
}

// Secreto FALSO armado por partes para que el archivo de prueba no dispare la guarda del repo (llave AWS de juguete).
const SECRETO_FALSO = 'AKIA' + 'ABCDEFGHIJKLMNOP';

// Entrada mínima de un evento PreToolUse de Bash/PowerShell (lo que Claude Code manda por stdin a un hook).
function eventoHerramienta(command, { tool = 'Bash', agente = null, cwd = null, sesion = 'sesion-de-prueba-0123456789' } = {}) {
  const e = { tool_name: tool, tool_input: { command }, cwd: cwd || process.cwd(), session_id: sesion, hook_event_name: 'PreToolUse' };
  if (agente) { e.agent_type = agente; e.agent_id = 'agente-prueba-1'; }
  return e;
}

// Copia recursiva propia. NO usar la copia recursiva de `fs` (cpSync): en Windows, con caracteres no ASCII en la ruta
// (un usuario con acento en el nombre de su carpeta), crea el destino con el nombre mal codificado y no avisa
// (medido con Node 24.14 en noviembre de 2026).
function copiarCarpeta(origen, destino, filtro) {
  if (filtro && !filtro(origen)) return;
  const st = fs.statSync(origen);
  if (!st.isDirectory()) { fs.mkdirSync(path.dirname(destino), { recursive: true }); fs.copyFileSync(origen, destino); return; }
  fs.mkdirSync(destino, { recursive: true });
  for (const n of fs.readdirSync(origen)) copiarCarpeta(path.join(origen, n), path.join(destino, n), filtro);
}

module.exports = {
  copiarCarpeta,
  RAIZ_REPO, RAIZ_KIT, RAIZ_HARNESS, VARIABLES_A_VACIAR, SECRETO_FALSO,
  escribir, entornoTemporal, correr, git, lineaUso, settingsBasico, requiereHerramienta, exigirAncestrosLimpios,
  rutaBash, requiereBash, gitConfigGlobal, repoTemporal, eventoHerramienta, rutaReal,
};
