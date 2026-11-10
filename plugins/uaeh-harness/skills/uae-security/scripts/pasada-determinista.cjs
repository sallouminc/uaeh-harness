#!/usr/bin/env node
'use strict';
/**
 * pasada-determinista.cjs — la pasada sin modelo de la puerta de seguridad (uae-security). Cero tokens.
 *
 * Uso: node pasada-determinista.cjs <repo-dir> <run-dir> [--base <commit>]
 *
 * Deja en <run-dir>:
 *   fuente/               copia limpia del repo (sin .env*, sin enlaces simbólicos, sin archivos > 5 MB, sin las
 *                         configuraciones de escáner del propio repo)
 *   fuente.json           inventario de la copia
 *   cambiados/            (solo con --base) copia de lo cambiado desde ese commit
 *   deterministico/       salidas crudas de cada herramienta (sin líneas de código ni secretos)
 *   deterministico.json   resultado normalizado
 *
 * Dónde corre cada herramienta:
 *   · gitleaks (historial y carpeta, siempre con --redact), semgrep y osv-scanner: en el motor de Linux (WSL2 en
 *     Windows, directo en Linux; lib/runner.cjs), instalados en /usr/local/bin con las reglas en /opt/uaeh/reglas.
 *   · cyber-neo (secretos y lockfiles): con el Python 3 del equipo, desde la copia vendorizada del plugin
 *     (vendor/cyber-neo), solo si está íntegra y con el parche que enmascara la evidencia.
 *   · npm audit / pnpm audit: con el Node del equipo (consultan el registro de npm: necesitan red).
 * Una herramienta que FALLÓ o NO_INSTALADA deja el estado global en UNKNOWN (UNKNOWN ≠ PASS).
 *
 * Códigos de salida: 0 = estado_global OK · 3 = estado_global UNKNOWN · 2 = uso o entorno inválido.
 * stdout: solo un resumen (una línea por herramienta + ESTADO_GLOBAL). Nunca código ni secretos.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const RAIZ_PLUGIN = path.resolve(__dirname, '..', '..', '..');
const configLib = require(path.join(RAIZ_PLUGIN, 'scripts', 'lib', 'config.cjs'));
const runner = require(path.join(RAIZ_PLUGIN, 'scripts', 'lib', 'runner.cjs'));
const uaehConfig = require(path.join(RAIZ_PLUGIN, 'scripts', 'uaeh-config.cjs'));
const parcheCyberNeo = require(path.join(RAIZ_PLUGIN, 'scripts', 'aplicar-parche-cyber-neo.cjs'));

// Rutas del lado de Linux: iguales en WSL y en Linux nativo (las deja el instalador de la capa 3).
const REGLAS_SEMGREP = '/opt/uaeh/reglas/semgrep/vigente';
const GITLEAKS = '/usr/local/bin/gitleaks';
const SEMGREP = '/usr/local/bin/semgrep';
const OSV = '/usr/local/bin/osv-scanner';
const GITLEAKS_CONFIG = '/opt/uaeh/reglas/gitleaks/vigente.toml';
const GITLEAKS_IGNORE_VACIO = '/opt/uaeh/reglas/gitleaks/ignorar-vacio';
const CYBER_NEO = path.join(RAIZ_PLUGIN, 'vendor', 'cyber-neo');
const MAX_BYTES = 5 * 1024 * 1024;
const T_SEMGREP_S = 15 * 60;
const T_OTRAS_S = 5 * 60;
const MANIFIESTOS = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|bun\.lockb|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|uv\.lock|composer\.(json|lock)|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|pom\.xml|[^/]*\.gradle(\.kts)?|gradle\.lockfile)$/;
// Configuración de escáneres que trae el repo auditado: nunca se copia (un repo no puede apagar los escáneres).
const CONFIG_ESCANER = /(^|\/)(\.gitleaks\.toml|\.gitleaksignore|\.semgrepignore|\.semgrep\.ya?ml|osv-scanner\.toml)$|(^|\/)\.semgrep\//;
const ENV_PERMITIDOS = new Set(['.env.example', '.env.sample', '.env.template']);

// ---------------------------------------------------------------- utilidades

let CONFIG = null;
function config() { return CONFIG || (CONFIG = configLib.cargarConfig().config); }

/** Ruta del equipo → ruta del motor de Linux. Windows: C:\a\b → /mnt/c/a/b (rechaza UNC); Linux: igual. */
function rutaMotor(p, so = process.platform) {
  const s = String(p);
  if (/[\0\r\n]/.test(s)) throw new Error('Ruta con caracteres de control');
  if (so !== 'win32') return s;
  const abs = path.win32.isAbsolute(s) ? s : path.win32.resolve(s);
  if (!/^[A-Za-z]:([\\/]|$)/.test(abs)) throw new Error('Ruta no convertible al motor de Linux (solo unidades con letra): ' + abs);
  return runner.aRutaMotor(abs, so);
}

function ahoraLocal(opciones = {}) {
  return uaehConfig.ahoraLocal({ config: opciones.config || config() });
}

function ejecutar(cmd, args, opc = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: opc.cwd,
    env: opc.env ? { ...process.env, ...opc.env } : process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: opc.timeoutMs,
    killSignal: 'SIGKILL',
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: !!opc.verbatim,
  });
  return {
    codigo: r.status,
    error: r.error || null,
    noExiste: !!(r.error && r.error.code === 'ENOENT'),
    vencio: !!(r.error && r.error.code === 'ETIMEDOUT'),
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    ms: Date.now() - t0,
  };
}

/** Un programa en el motor de Linux con tope de tiempo (timeout -k dentro de Linux + tope por fuera). */
function enLinux(args, segundos, env = {}) {
  const t0 = Date.now();
  const r = runner.ejecutarEnLinux(args, { segundos, env, maxBuffer: 256 * 1024 * 1024 }, config());
  return {
    codigo: r.codigo, error: r.error, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0,
    vencio: !!r.agotado || r.codigo === 124 || r.codigo === 137,
  };
}

function donde() {
  return process.platform === 'win32' ? `WSL (distro ${config().wsl.distro})` : 'Linux';
}

function git(repo, args, extraEnv) {
  return ejecutar('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], {
    env: { GIT_OPTIONAL_LOCKS: '0', ...(extraEnv || {}) },
    timeoutMs: T_OTRAS_S * 1000,
  });
}

function sha256(txt) { return crypto.createHash('sha256').update(txt).digest('hex'); }
function aRel(p) { return String(p).replace(/\\/g, '/').replace(/^\.\//, ''); }
function leerJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function corto(s, n = 300) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '...' : s; }

/** Ruta absoluta (del equipo o del motor) → relativa a alguna de las raíces; si no cuelga de ninguna, se deja normalizada. */
function relativizar(p, raices) {
  const n = aRel(p);
  const nl = n.toLowerCase();
  for (const r of raices) {
    const rl = aRel(r).replace(/\/+$/, '').toLowerCase();
    if (rl && nl.startsWith(rl + '/')) return n.slice(rl.length + 1);
  }
  return n;
}

// ---------------------------------------------------------------- argumentos

function parsearArgs(argv) {
  const pos = [];
  let base = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') { base = argv[++i]; if (!base) throw new Error('--base requiere un commit'); }
    else if (argv[i].startsWith('--base=')) base = argv[i].slice(7);
    else pos.push(argv[i]);
  }
  if (pos.length !== 2) throw new Error('Uso: node pasada-determinista.cjs <repo-dir> <run-dir> [--base <commit>]');
  if (base !== null && !/^[0-9A-Za-z][0-9A-Za-z._\/-]*$/.test(base)) throw new Error('--base con formato inválido');
  return { repo: path.resolve(pos[0]), run: path.resolve(pos[1]), base };
}

// ---------------------------------------------------------------- paso 1: copia limpia

function copiaLimpia(repo, run, fuente) {
  if (fs.existsSync(fuente) && fs.readdirSync(fuente).length > 0) {
    throw new Error('La carpeta ' + fuente + ' ya existe y no está vacía; no se sobrescribe. Usa otro run-dir.');
  }
  const ls = git(repo, ['ls-files', '-co', '--exclude-standard', '-z']);
  if (ls.codigo !== 0) throw new Error('git ls-files falló (código ' + ls.codigo + ')');
  const lista = ls.stdout.split('\0').filter(Boolean);
  const omitidos = [];
  const configsRepo = [];
  const copiados = [];
  fs.mkdirSync(fuente, { recursive: true });
  const raizFuente = path.resolve(fuente);

  for (const rutaGit of [...new Set(lista)]) {
    const ruta = aRel(rutaGit);
    if (path.isAbsolute(ruta) || ruta.split('/').includes('..')) { omitidos.push({ ruta, motivo: 'ruta insegura' }); continue; }
    const base = ruta.split('/').pop();
    if (CONFIG_ESCANER.test(ruta)) { configsRepo.push(ruta); omitidos.push({ ruta, motivo: 'configuración de escáner del repo (ignorada)' }); continue; }
    if (base.startsWith('.env') && !ENV_PERMITIDOS.has(base)) { omitidos.push({ ruta, motivo: 'archivo .env excluido' }); continue; }
    const origen = path.join(repo, ...ruta.split('/'));
    let st;
    try { st = fs.lstatSync(origen); } catch { omitidos.push({ ruta, motivo: 'no existe en disco (borrado)' }); continue; }
    if (st.isSymbolicLink()) { omitidos.push({ ruta, motivo: 'enlace simbólico' }); continue; }
    if (!st.isFile()) { omitidos.push({ ruta, motivo: 'no es archivo regular (submódulo o directorio)' }); continue; }
    if (st.size > MAX_BYTES) { omitidos.push({ ruta, motivo: 'mayor de 5 MB (' + st.size + ' bytes)' }); continue; }
    const destino = path.resolve(raizFuente, ...ruta.split('/'));
    if (!destino.startsWith(raizFuente + path.sep)) { omitidos.push({ ruta, motivo: 'ruta insegura' }); continue; }
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.copyFileSync(origen, destino);
    copiados.push(ruta);
  }
  copiados.sort();

  const head = git(repo, ['rev-parse', 'HEAD']);
  const commit = head.codigo === 0 ? head.stdout.trim() : 'sin-commits';
  const stt = git(repo, ['status', '--porcelain']);
  const sucio = stt.codigo === 0 ? stt.stdout.trim().length > 0 : true;
  const meta = {
    commit, sucio, archivos: copiados.length, omitidos, configs_escaner_del_repo: configsRepo.sort(),
    sha256_lista: sha256(copiados.join('\n')),
    generado: ahoraLocal(),
  };
  fs.writeFileSync(path.join(run, 'fuente.json'), JSON.stringify(meta, null, 2));
  return { copiados, omitidos, commit, sucio, meta, configsRepo };
}

// ---------------------------------------------------------------- modo diff

function calcularCambiados(repo, baseIn, copiados) {
  const v = git(repo, ['rev-parse', '--verify', '--quiet', baseIn + '^{commit}']);
  if (v.codigo !== 0) throw new Error('--base no es un commit válido del repo: ' + baseIn);
  const baseSha = v.stdout.trim();
  const d = git(repo, ['diff', '--name-only', '-z', baseSha]);
  if (d.codigo !== 0) throw new Error('git diff falló (código ' + d.codigo + ')');
  const u = git(repo, ['ls-files', '-o', '--exclude-standard', '-z']);
  const todos = new Set([...d.stdout.split('\0'), ...(u.codigo === 0 ? u.stdout.split('\0') : [])].filter(Boolean).map(aRel));
  const enCopia = new Set(copiados);
  const cambiados = [...todos].filter((r) => enCopia.has(r)).sort();
  return { baseSha, todos: [...todos], cambiados };
}

function copiarSubconjunto(fuente, destino, lista) {
  fs.mkdirSync(destino, { recursive: true });
  for (const r of lista) {
    const o = path.join(fuente, ...r.split('/'));
    const d = path.join(destino, ...r.split('/'));
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(o, d);
  }
}

// ---------------------------------------------------------------- registro de herramientas

function nuevaHerramienta(nombre) {
  return { nombre, version: null, estado: 'OK', codigo_salida: null, duracion_ms: 0, archivo_crudo: null, hallazgos: [] };
}
function fallo(h, motivo, r) {
  h.estado = 'FALLÓ'; h.motivo = motivo;
  if (r) { h.codigo_salida = r.codigo; h.duracion_ms = r.ms; }
  return h;
}
function omitida(h, motivo) { h.estado = 'OMITIDA'; h.motivo = motivo; return h; }
function noInstalada(h, motivo) { h.estado = 'NO_INSTALADA'; h.motivo = motivo; return h; }

/** UNKNOWN si alguna herramienta FALLÓ o NO_INSTALADA; si no, OK. OMITIDA (no aplica) no baja el estado. */
function estadoGlobal(herramientas) {
  return herramientas.some((h) => h.estado === 'FALLÓ' || h.estado === 'NO_INSTALADA') ? 'UNKNOWN' : 'OK';
}

// ¿Responde el motor de Linux? Se mide una vez: sin motor, las herramientas de Linux son NO_INSTALADA sin esperar topes.
let MOTOR = null;
function motor() { return MOTOR || (MOTOR = runner.motorListo(config())); }

function versionMotor(bin, args) {
  if (!motor().listo) return null;
  const r = enLinux([bin, ...args], 60);
  if (r.codigo !== 0) return null;
  const m = /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(r.stdout + '\n' + r.stderr);
  return m ? m[0] : corto(r.stdout.split('\n')[0], 60);
}

function motivoSinMotor(nombre) {
  const m = motor();
  return m.listo ? `${nombre} no responde en ${donde()}` : `motor de Linux no disponible: ${m.detalle}`;
}

// ---------------------------------------------------------------- gitleaks

function leerGitleaks(archivoJson, raices, historial) {
  const data = leerJson(archivoJson);
  if (!Array.isArray(data)) return [];
  // El crudo no debe conservar el texto del hallazgo: se reescribe sin Match/Secret/Line.
  const limpio = data.map((x) => { const c = { ...x }; delete c.Match; delete c.Secret; delete c.Line; return c; });
  fs.writeFileSync(archivoJson, JSON.stringify(limpio, null, 2));
  return limpio.map((x) => ({
    regla: x.RuleID,
    archivo: historial ? aRel(x.File) : relativizar(x.File, raices),
    linea: x.StartLine || 0,
    gravedad_herramienta: 'n/a',
    mensaje: corto((x.Description || x.RuleID) + (historial && x.Commit ? ' (commit ' + String(x.Commit).slice(0, 8) + ')' : ''), 200),
  }));
}

function gitleaks(modo, destino, argsExtra, raices, crudoRel, run, historial) {
  const h = nuevaHerramienta(modo);
  h.version = versionMotor(GITLEAKS, ['version']);
  if (!h.version) return noInstalada(h, motivoSinMotor('gitleaks'));
  const crudo = path.join(run, crudoRel);
  h.archivo_crudo = aRel(crudoRel);
  const r = enLinux([GITLEAKS, ...(historial ? ['git'] : ['dir']), '--redact', '--no-banner',
    '--report-format', 'json', '--report-path', rutaMotor(crudo),
    '--config', GITLEAKS_CONFIG, '--gitleaks-ignore-path', GITLEAKS_IGNORE_VACIO, '--ignore-gitleaks-allow', ...argsExtra, destino], T_OTRAS_S,
  historial ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' } : {});
  h.codigo_salida = r.codigo; h.duracion_ms = r.ms;
  if (r.vencio) return fallo(h, 'tiempo límite de 5 min agotado', r);
  if (r.codigo !== 0 && r.codigo !== 1) return fallo(h, 'gitleaks terminó con código ' + r.codigo, r);
  if (!fs.existsSync(crudo)) fs.writeFileSync(crudo, '[]');
  h.hallazgos = leerGitleaks(crudo, raices, historial);
  return h;
}

// ---------------------------------------------------------------- semgrep

function elegirPaquetes(fuente, archivos) {
  const paquetes = ['default', 'owasp-top-ten', 'secrets'];
  const base = (r) => r.split('/').pop();
  const pkgs = archivos.filter((r) => base(r) === 'package.json');
  if (pkgs.length) {
    paquetes.push('javascript', 'nodejsscan');
    if (archivos.some((r) => /^tsconfig.*\.json$/.test(base(r)) || /\.(ts|tsx|mts|cts)$/.test(r))) paquetes.push('typescript');
    const usaReact = pkgs.slice(0, 30).some((r) => {
      const j = leerJson(path.join(fuente, ...r.split('/')));
      return j && ['dependencies', 'devDependencies', 'peerDependencies'].some((k) => j[k] && Object.prototype.hasOwnProperty.call(j[k], 'react'));
    });
    if (usaReact) paquetes.push('react');
  }
  if (archivos.some((r) => base(r) === 'composer.json' || r.endsWith('.php'))) paquetes.push('php');
  if (archivos.some((r) => base(r) === 'pyproject.toml' || /^requirements.*\.txt$/.test(base(r)) || r.endsWith('.py'))) paquetes.push('python');
  return paquetes;
}

function semgrep(objetivo, archivosTec, fuente, raices, run, diffSinCambios) {
  const h = nuevaHerramienta('semgrep');
  h.version = versionMotor(SEMGREP, ['--version']);
  if (!h.version) return noInstalada(h, motivoSinMotor('semgrep'));
  if (diffSinCambios) return omitida(h, 'modo diff: sin archivos cambiados');
  const paquetes = elegirPaquetes(fuente, archivosTec);
  const crudo = path.join(run, 'deterministico', 'semgrep.json');
  h.archivo_crudo = 'deterministico/semgrep.json';
  h.paquetes = paquetes;
  const configs = [];
  for (const p of paquetes) configs.push('--config', REGLAS_SEMGREP + '/' + p + '.yml');
  const r = enLinux([SEMGREP, 'scan', '--metrics=off', '--disable-version-check', '--json', '--output', rutaMotor(crudo), ...configs, rutaMotor(objetivo)],
    T_SEMGREP_S, { SEMGREP_ENABLE_VERSION_CHECK: '0' });
  h.codigo_salida = r.codigo; h.duracion_ms = r.ms;
  if (r.vencio) return fallo(h, 'tiempo límite de 15 min agotado', r);
  if (r.codigo !== 0 && r.codigo !== 1) return fallo(h, 'semgrep terminó con código ' + r.codigo, r);
  const data = leerJson(crudo);
  if (!data || !Array.isArray(data.results)) return fallo(h, 'semgrep no produjo JSON válido', r);

  const vistos = new Set();
  const limpios = [];
  for (const x of data.results) {
    const rel = relativizar(x.path, raices);
    const linea = (x.start && x.start.line) || 0;
    const clave = [x.check_id, rel, linea].join('\u0000');
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    const extra = { ...(x.extra || {}) };
    // Nada de código en disco: lines, metavars (abstract_content), trazas y fixes pueden contener secretos.
    for (const k of ['lines', 'metavars', 'dataflow_trace', 'fix', 'fix_regex', 'fingerprint']) delete extra[k];
    limpios.push({ ...x, path: rel, extra });
  }
  data.results = limpios;
  if (Array.isArray(data.errors)) data.errores_total = data.errors.length;
  delete data.errors; // los mensajes de error de parseo pueden citar código
  fs.writeFileSync(crudo, JSON.stringify(data, null, 2));
  if (data.errores_total) h.errores_semgrep = data.errores_total;

  const sensible = /secret|token|password|passwd|credential|api[-_]?key|private[-_]?key/i;
  h.hallazgos = limpios.map((x) => ({
    regla: x.check_id,
    archivo: x.path,
    linea: (x.start && x.start.line) || 0,
    gravedad_herramienta: (x.extra && x.extra.severity) || 'n/a',
    mensaje: sensible.test(x.check_id) ? 'Regla ' + String(x.check_id).split('.').pop() : corto((x.extra && x.extra.message) || x.check_id, 300),
  }));
  return h;
}

// ---------------------------------------------------------------- osv-scanner

function osv(fuente, raices, run, omitirMotivo) {
  const h = nuevaHerramienta('osv-scanner');
  h.version = versionMotor(OSV, ['--version']);
  if (!h.version) return noInstalada(h, motivoSinMotor('osv-scanner'));
  if (omitirMotivo) return omitida(h, omitirMotivo);
  const crudo = path.join(run, 'deterministico', 'osv.json');
  h.archivo_crudo = 'deterministico/osv.json';
  const r = enLinux([OSV, 'scan', 'source', '-r', '--format', 'json', '--output', rutaMotor(crudo), rutaMotor(fuente)], T_OTRAS_S);
  h.codigo_salida = r.codigo; h.duracion_ms = r.ms;
  if (r.vencio) return fallo(h, 'tiempo límite de 5 min agotado', r);
  if (![0, 1, 128].includes(r.codigo)) return fallo(h, 'osv-scanner terminó con código ' + r.codigo + ' (sin red o error)', r);
  if (r.codigo === 128) { if (!fs.existsSync(crudo)) fs.writeFileSync(crudo, '{"results":[]}'); h.nota = 'sin manifiestos'; return h; }
  const data = leerJson(crudo);
  if (!data) return fallo(h, 'osv-scanner no produjo JSON válido', r);
  const vistos = new Set();
  for (const res of data.results || []) {
    const archivo = relativizar((res.source && res.source.path) || '', raices);
    for (const pk of res.packages || []) {
      const nombre = pk.package ? pk.package.name + '@' + pk.package.version : '?';
      for (const v of pk.vulnerabilities || []) {
        const clave = [v.id, archivo, nombre].join('\u0000');
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        const grupo = (pk.groups || []).find((g) => (g.ids || []).includes(v.id));
        const grav = (grupo && grupo.max_severity) || (v.database_specific && v.database_specific.severity) || 'n/a';
        h.hallazgos.push({ regla: v.id, archivo, linea: 0, gravedad_herramienta: String(grav), mensaje: corto(nombre + ': ' + (v.summary || v.id), 300) });
      }
    }
  }
  return h;
}

// ---------------------------------------------------------------- cyber-neo (Python del equipo, copia vendorizada)

function pythonCmd() {
  const cmd = runner.comandoPython();
  if (!cmd) return null;
  const pre = cmd === 'py' ? ['-3', '-I'] : ['-I'];
  const r = ejecutar(cmd, [...pre, '-c', 'import sys;print(sys.version.split()[0])'], { timeoutMs: 60000 });
  return r.codigo === 0 ? { cmd, pre, version: r.stdout.trim() } : null;
}

// La copia vendorizada se comprueba una vez: los dos scripts íntegros y scan_secrets.py PARCHEADO (si no, la
// evidencia de un secreto saldría con el secreto). Las referencias no cuentan: la pasada no las usa.
let VENDOR = null;
function vendorCyberNeo() {
  return VENDOR || (VENDOR = parcheCyberNeo.verificarVendor(CYBER_NEO, { archivos: ['scripts/scan_secrets.py', 'scripts/check_lockfiles.py'] }));
}

function cyberNeo(nombre, script, extraArgs, dir, raices, run, crudoRel, py, omitirMotivo, esperados) {
  const h = nuevaHerramienta(nombre);
  if (!py) return noInstalada(h, 'sin Python 3 (python3, python o py)');
  h.version = 'python ' + py.version;
  const ruta = path.join(CYBER_NEO, 'scripts', script);
  if (!fs.existsSync(ruta)) return noInstalada(h, 'falta ' + script + ' en vendor/cyber-neo');
  const v = vendorCyberNeo();
  if (v.estado !== 'PARCHEADO') return fallo(h, 'copia de cyber-neo no verificada (' + v.estado + '): ' + corto(v.detalle, 160));
  if (omitirMotivo) return omitida(h, omitirMotivo);
  const r = ejecutar(py.cmd, [...py.pre, ruta, dir, ...extraArgs], { env: { PYTHONIOENCODING: 'utf-8' }, timeoutMs: T_OTRAS_S * 1000 });
  h.codigo_salida = r.codigo; h.duracion_ms = r.ms;
  h.archivo_crudo = aRel(crudoRel);
  if (r.vencio) return fallo(h, 'tiempo límite de 5 min agotado', r);
  if (r.codigo !== 0 && r.codigo !== 1) return fallo(h, 'terminó con código ' + r.codigo, r);
  let data;
  try { data = JSON.parse(r.stdout); } catch { return fallo(h, 'salida no es JSON', r); }
  if (data.error) return fallo(h, 'la herramienta reportó un error', r);
  // cyber-neo salta un archivo si CUALQUIER carpeta de su ruta absoluta se llama build, dist, env, vendor, target…
  // Si la carpeta de corridas cuelga de una así, revisaría 0 archivos sin avisar: eso no es «sin hallazgos».
  const revisados = data.metadata && Number.isFinite(data.metadata.files_scanned) ? data.metadata.files_scanned : null;
  if (esperados > 0 && revisados === 0) return fallo(h, 'no revisó ningún archivo (¿la ruta del run contiene una carpeta que cyber-neo salta, como build, dist, env o vendor?)', r);
  const lista = Array.isArray(data.findings) ? data.findings : [];
  // evidence puede contener fragmentos de código: no se guarda.
  const limpio = lista.map((x) => { const c = { ...x }; delete c.evidence; return c; });
  fs.writeFileSync(path.join(run, crudoRel), JSON.stringify({ findings: limpio, metadata: data.metadata }, null, 2));
  h.hallazgos = limpio.map((x) => ({
    regla: x.type || 'cyber-neo',
    archivo: relativizar(x.file || '', raices),
    linea: x.line || 0,
    gravedad_herramienta: x.severity || 'n/a',
    mensaje: corto(x.description || x.type, 300),
  }));
  return h;
}

// ---------------------------------------------------------------- npm / pnpm audit

/** npm del Node que corre este script (Windows: <node>/node_modules/npm; POSIX: <prefijo>/lib/node_modules/npm). */
function resolverNpm(execPath = process.execPath, so = process.platform) {
  const dir = path.dirname(execPath);
  for (const cli of [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (fs.existsSync(cli)) return { cmd: execPath, pre: [path.resolve(cli)], verbatim: false };
  }
  if (so === 'win32') return { cmd: 'cmd.exe', pre: null, fijo: 'npm', verbatim: true };
  return { cmd: 'npm', pre: [], verbatim: false };
}

/** pnpm del PATH: su .cjs con el Node actual si se encuentra; si no, el lanzador (cmd.exe solo en Windows). */
function resolverPnpm(entornoPath = process.env.PATH || process.env.Path || '', so = process.platform) {
  for (const d of entornoPath.split(path.delimiter)) {
    if (!d) continue;
    if (so === 'win32') {
      if (!fs.existsSync(path.join(d, 'pnpm.cmd')) && !fs.existsSync(path.join(d, 'pnpm'))) continue;
      for (const rel of [['node_modules', 'pnpm', 'bin', 'pnpm.cjs'], ['node_modules', 'pnpm', 'bin', 'pnpm.mjs']]) {
        const cli = path.join(d, ...rel);
        if (fs.existsSync(cli)) return { cmd: process.execPath, pre: [cli], verbatim: false };
      }
      return { cmd: 'cmd.exe', pre: null, fijo: 'pnpm', verbatim: true };
    }
    const lanzador = path.join(d, 'pnpm');
    if (!fs.existsSync(lanzador)) continue;
    let real = lanzador;
    try { real = fs.realpathSync(lanzador); } catch { /* se usa el lanzador */ }
    if (/\.(c|m)?js$/.test(real)) return { cmd: process.execPath, pre: [real], verbatim: false };
    return { cmd: lanzador, pre: [], verbatim: false };
  }
  return null;
}

/** Corre el gestor con argumentos FIJOS; cwd lleva la ruta (nunca se concatena en el comando). */
function correrGestor(g, args, cwd, ms) {
  if (g.pre) return ejecutar(g.cmd, [...g.pre, ...args], { cwd, timeoutMs: ms });
  return ejecutar('cmd.exe', ['/d', '/s', '/c', g.fijo + ' ' + args.join(' ')], { cwd, timeoutMs: ms, verbatim: true });
}

function auditoria(gestor, archivos, fuente, run, omitirMotivo) {
  const nombre = gestor + ' audit';
  const h = nuevaHerramienta(nombre);
  const lock = gestor === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';
  const dirs = [];
  for (const r of archivos) {
    if (r.split('/').pop() !== lock) continue;
    const d = r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '';
    if (gestor === 'npm' && archivos.includes((d ? d + '/' : '') + 'pnpm-lock.yaml')) continue; // pnpm manda en esa carpeta
    if (!r.split('/').includes('node_modules')) dirs.push(d);
  }
  if (!dirs.length) return omitida(h, 'sin ' + lock);
  const g = gestor === 'pnpm' ? resolverPnpm() : resolverNpm();
  if (!g) return noInstalada(h, 'pnpm no encontrado en PATH');
  const v = correrGestor(g, ['--version'], fuente, 60000);
  if (v.codigo !== 0) return noInstalada(h, gestor + ' no responde');
  h.version = v.stdout.trim().split('\n').pop().trim();
  if (omitirMotivo) return omitida(h, omitirMotivo);
  h.archivo_crudo = 'deterministico/' + gestor + '-audit.json';
  const crudoTodo = {};
  const vistos = new Set();
  let tiempo = 0;
  for (const d of dirs.slice(0, 10)) {
    const cwd = path.join(fuente, ...(d ? d.split('/') : []));
    const r = correrGestor(g, ['audit', '--json'], cwd, T_OTRAS_S * 1000);
    tiempo += r.ms;
    h.codigo_salida = r.codigo; h.duracion_ms = tiempo;
    if (r.vencio) return fallo(h, 'tiempo límite de 5 min agotado en ' + (d || '.'), r);
    let data;
    try { data = JSON.parse(r.stdout); } catch { return fallo(h, 'salida no es JSON (código ' + r.codigo + ')', r); }
    if (data.error || (r.codigo !== 0 && r.codigo !== 1)) {
      const cod = data.error && (data.error.code || data.error.summary) ? corto(data.error.code || data.error.summary, 80) : 'código ' + r.codigo;
      return fallo(h, gestor + ' audit devolvió error (' + cod + ')', r);
    }
    crudoTodo[d || '.'] = data;
    const archivo = (d ? d + '/' : '') + lock;
    if (data.vulnerabilities) { // formato npm
      for (const [pkg, info] of Object.entries(data.vulnerabilities)) {
        const vias = (info.via || []).filter((x) => x && typeof x === 'object');
        const entradas = vias.length ? vias.map((x) => ({ id: (x.url && String(x.url).split('/').pop()) || String(x.source || pkg), t: x.title })) : [{ id: 'npm-audit:' + pkg, t: 'vulnerable por dependencia transitiva' }];
        for (const e of entradas) {
          const k = [e.id, pkg, archivo].join('\u0000');
          if (vistos.has(k)) continue; vistos.add(k);
          h.hallazgos.push({ regla: e.id, archivo, linea: 0, gravedad_herramienta: info.severity || 'n/a', mensaje: corto(pkg + ': ' + (e.t || e.id), 300) });
        }
      }
    } else if (data.advisories) { // formato pnpm
      for (const a of Object.values(data.advisories)) {
        const id = a.github_advisory_id || String(a.id);
        const k = [id, a.module_name, archivo].join('\u0000');
        if (vistos.has(k)) continue; vistos.add(k);
        h.hallazgos.push({ regla: id, archivo, linea: 0, gravedad_herramienta: a.severity || 'n/a', mensaje: corto(a.module_name + ': ' + (a.title || id), 300) });
      }
    }
  }
  fs.writeFileSync(path.join(run, h.archivo_crudo), JSON.stringify(crudoTodo, null, 2));
  return h;
}

// ---------------------------------------------------------------- principal

function main() {
  let a;
  try { a = parsearArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const { repo, run } = a;
  try {
    if (!fs.existsSync(repo)) throw new Error('No existe el repo: ' + repo);
    const dentro = git(repo, ['rev-parse', '--is-inside-work-tree']);
    if (dentro.codigo !== 0 || dentro.stdout.trim() !== 'true') throw new Error('No es un repo git: ' + repo);
    let ancestro = run;
    const resto = [];
    while (!fs.existsSync(ancestro) && path.dirname(ancestro) !== ancestro) { resto.unshift(path.basename(ancestro)); ancestro = path.dirname(ancestro); }
    const rr = path.join(fs.realpathSync(ancestro), ...resto);
    const rp = fs.realpathSync(repo);
    if ((rr + path.sep).toLowerCase().startsWith((rp + path.sep).toLowerCase())) throw new Error('El run-dir no puede estar dentro del repo auditado');
  } catch (e) { console.error(e.message); process.exit(2); }

  let ctx;
  try {
    fs.mkdirSync(run, { recursive: true });
    const fuente = path.join(run, 'fuente');
    const det = path.join(run, 'deterministico');
    ctx = { fuente, det, copia: copiaLimpia(repo, run, fuente) };
    fs.mkdirSync(det, { recursive: true });
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(2); }

  const { fuente, copia } = ctx;
  const diff = a.base !== null;
  let cambios = null;
  let objetivo = fuente; // carpeta que ven los escáneres de código
  try {
    if (diff) {
      cambios = calcularCambiados(repo, a.base, copia.copiados);
      objetivo = path.join(run, 'cambiados');
      copiarSubconjunto(fuente, objetivo, cambios.cambiados);
    }
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(2); }

  const sinCambios = diff && cambios.cambiados.length === 0;
  const manifiestoCambiado = !diff || cambios.todos.some((r) => MANIFIESTOS.test(r));
  const motivoDeps = manifiestoCambiado ? null : 'modo diff: no cambió ningún manifiesto ni lockfile';
  const raices = [fuente, rutaMotor(fuente), objetivo, rutaMotor(objetivo)];

  const herramientas = [];
  // gitleaks lee el .gitleaksignore del directorio fuente aunque se le pase --gitleaks-ignore-path (medido en 8.30.1).
  // Por eso el historial se escanea en un clon bare del repo (sin árbol de trabajo): no hay .gitleaksignore que leer.
  const clon = path.join(run, 'historial.git');
  let clonBorrado = true;
  if (!motor().listo) {
    herramientas.push(noInstalada(nuevaHerramienta('gitleaks-historial'), motivoSinMotor('gitleaks')));
  } else {
    try {
      const rc = git(repo, ['clone', '--mirror', '--no-hardlinks', '--quiet', repo, clon]);
      if (rc.codigo !== 0) {
        const hh = nuevaHerramienta('gitleaks-historial');
        herramientas.push(fallo(hh, 'no se pudo clonar el historial (git clone código ' + rc.codigo + ')', rc));
      } else herramientas.push(gitleaks('gitleaks-historial', rutaMotor(clon), diff ? ['--log-opts=' + cambios.baseSha + '..HEAD'] : [], [], 'deterministico/gitleaks-historial.json', run, true));
    } finally {
      // El clon contiene los secretos del historial: se borra siempre (éxito, fallo o tiempo agotado).
      try { fs.rmSync(clon, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* se verifica abajo */ }
      clonBorrado = !fs.existsSync(clon);
    }
  }
  herramientas.push(sinCambios
    ? omitida(nuevaHerramienta('gitleaks-dir'), 'modo diff: sin archivos cambiados')
    : gitleaks('gitleaks-dir', rutaMotor(objetivo), [], raices, 'deterministico/gitleaks-dir.json', run, false));
  herramientas.push(semgrep(objetivo, copia.copiados, fuente, raices, run, sinCambios));
  herramientas.push(osv(fuente, raices, run, motivoDeps));
  const py = pythonCmd();
  const enObjetivo = diff ? cambios.cambiados.length : copia.copiados.length;
  herramientas.push(cyberNeo('cyber-neo-secretos', 'scan_secrets.py', ['--json'], objetivo, raices, run, 'deterministico/cyber-neo-secretos.json', py,
    sinCambios ? 'modo diff: sin archivos cambiados' : null, enObjetivo));
  herramientas.push(cyberNeo('cyber-neo-lockfiles', 'check_lockfiles.py', [], fuente, raices, run, 'deterministico/cyber-neo-lockfiles.json', py, motivoDeps, 0));
  herramientas.push(auditoria('pnpm', copia.copiados, fuente, run, motivoDeps));
  herramientas.push(auditoria('npm', copia.copiados, fuente, run, motivoDeps));

  const porHerr = {};
  let total = 0;
  for (const h of herramientas) { porHerr[h.nombre] = h.hallazgos.length; total += h.hallazgos.length; }
  const global = estadoGlobal(herramientas);
  const salida = {
    generado: ahoraLocal(), repo, commit: copia.commit, modo: diff ? 'diff' : 'completa',
    base: diff ? cambios.baseSha : null, motor: { listo: motor().listo, detalle: motor().detalle },
    herramientas, resumen: { total, por_herramienta: porHerr }, historial_clon_borrado: clonBorrado, estado_global: global,
  };
  if (diff) salida.archivos_cambiados = cambios.cambiados.length;
  fs.writeFileSync(path.join(run, 'deterministico.json'), JSON.stringify(salida, null, 2));

  for (const h of herramientas) {
    const motivo = h.motivo && h.estado !== 'OK' ? ' (' + corto(h.motivo, 80) + ')' : '';
    console.log([h.nombre, h.version || '-', h.estado + motivo, 'hallazgos=' + h.hallazgos.length, (h.duracion_ms / 1000).toFixed(1) + 's'].join(' '));
  }
  console.log('AVISO configs de escáner del repo ignoradas: ' + copia.configsRepo.length);
  console.log('ESTADO_GLOBAL ' + global + ' total=' + total + ' modo=' + salida.modo);
  console.log('SALIDA ' + path.join(run, 'deterministico.json'));
  process.exit(global === 'OK' ? 0 : 3);
}

if (require.main === module) main();

module.exports = { rutaMotor, relativizar, parsearArgs, ahoraLocal, elegirPaquetes, estadoGlobal, resolverNpm, resolverPnpm, correrGestor };
