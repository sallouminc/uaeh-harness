#!/usr/bin/env node
// lib/runner.cjs — plataforma y ejecución de comandos del arnés UAEH (plugin uaeh-harness).
//
// Dónde corre cada cosa:
//   · Windows 11: las piezas de Linux (escáneres, caja de arena) corren dentro de WSL2 (`wsl.exe -d <distro> -e …`).
//   · Linux: corren directo.
//   · macOS y otros: la capa 3 no está soportada en v1; la capa 2 (candados, sello, guarda de git) sí funciona.
// Reglas:
//   · Sin dependencias; nunca usa una shell para ejecutar (siempre argv), así las comillas no cambian el comando.
//   · Todo lo que pueda tardar lleva tope de tiempo: `segundos` (por defecto 60) con `timeout -k 10` del lado Linux y el
//     `timeout` de spawnSync del lado de quien llama (segundos + 15).
//   · La forma de retorno es la misma para ejecutar() y ejecutarEnLinux(): { codigo, stdout, stderr, agotado, error }.
//   · La distro y el usuario de WSL salen de la configuración (`wsl.distro`, `wsl.usuario`); nunca root.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const configLib = require(path.join(__dirname, 'config.cjs'));

const SEGUNDOS_DEFECTO = 60;
const MARGEN_SEGUNDOS = 15;      // lo que se le da de más al proceso padre respecto al timeout de Linux
const GRACIA_KILL = 10;          // `timeout -k`: segundos entre TERM y KILL
const TIMEOUT_LINUX = '/usr/bin/timeout';
const ENV_LINUX = '/usr/bin/env';
const CAJA = '/opt/uaeh/bin/uaeh-sandbox';

function configEfectiva(config) {
  return config || configLib.cargarConfig().config;
}

// { so, modo } con so = process.platform y modo = 'wsl' (Windows: las piezas de Linux van por WSL2) | 'linux' | 'no-soportado'.
function plataforma(so = process.platform) {
  if (so === 'win32') return { so, modo: 'wsl' };
  if (so === 'linux') return { so, modo: 'linux' };
  return { so, modo: 'no-soportado' };
}

// Ejecuta un programa SIN shell. input: texto para stdin. Devuelve { codigo, stdout, stderr, agotado, error }.
function ejecutar(programa, args = [], opciones = {}) {
  const segundos = Number(opciones.segundos) > 0 ? Number(opciones.segundos) : SEGUNDOS_DEFECTO;
  const r = spawnSync(programa, args, {
    encoding: 'utf8',
    input: opciones.input == null ? undefined : String(opciones.input),
    env: opciones.env || process.env,
    cwd: opciones.cwd || undefined,
    timeout: (segundos + (opciones.margenSegundos == null ? MARGEN_SEGUNDOS : Number(opciones.margenSegundos))) * 1000,
    maxBuffer: opciones.maxBuffer || 64 * 1024 * 1024,
    windowsHide: true,
  });
  const agotado = !!(r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM' && r.status == null));
  return {
    codigo: r.status == null ? (r.error ? -1 : 124) : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    agotado,
    error: r.error ? (r.error.code || r.error.message) : null,
  };
}

// `C:\proyectos\repo` → `/mnt/c/proyectos/repo` (Windows); en POSIX la ruta se devuelve tal cual (identidad).
function aRutaMotor(ruta, so = process.platform) {
  if (so !== 'win32') return String(ruta);
  const abs = path.win32.resolve(String(ruta)).replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(abs);
  if (!m) return abs; // UNC u otra forma: no se traduce
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`.replace(/\/+$/, '') || `/mnt/${m[1].toLowerCase()}`;
}

// `/mnt/c/proyectos` → `C:\proyectos` (Windows); otras rutas o POSIX: tal cual.
function deRutaMotor(ruta, so = process.platform) {
  if (so !== 'win32') return String(ruta);
  const m = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(String(ruta));
  if (!m) return String(ruta);
  return `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}`;
}

// Prefijo de argv para entrar al motor de Linux: en Windows `wsl.exe -d <distro> [-u <usuario>] -e`; en Linux, nada.
function prefijoMotor(config, so = process.platform) {
  if (so !== 'win32') return [];
  const c = configEfectiva(config);
  const args = ['wsl.exe', '-d', c.wsl.distro];
  if (c.wsl.usuario && c.wsl.usuario !== 'root') args.push('-u', c.wsl.usuario);
  args.push('-e');
  return args;
}

// Prefijo de argv de la caja de arena (capa 3): motor + `/opt/uaeh/bin/uaeh-sandbox ejecutar`.
function prefijoCaja(config, so = process.platform) {
  return [...prefijoMotor(config, so), CAJA, 'ejecutar'];
}

// Arma (sin ejecutar) el argv para correr `args` en Linux con tope de tiempo, variables y carpeta opcionales.
//   → { programa, args }. Windows: `wsl.exe -d <distro> [-u u] [--cd <ruta /mnt>] -e /usr/bin/timeout -k 10 <s> [/usr/bin/env K=V…] args…`
//     POSIX:   `/usr/bin/timeout -k 10 <s> [/usr/bin/env K=V…] args…` (cwd lo aplica spawnSync).
function argumentosLinux(args, opciones = {}, config, so = process.platform) {
  if (!Array.isArray(args) || !args.length) throw new Error('argumentosLinux: args debe ser una lista no vacía');
  const segundos = Number(opciones.segundos) > 0 ? Math.ceil(Number(opciones.segundos)) : SEGUNDOS_DEFECTO;
  const envLinux = [];
  for (const [k, v] of Object.entries(opciones.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`argumentosLinux: nombre de variable inválido "${k}"`);
    envLinux.push(`${k}=${v == null ? '' : String(v)}`);
  }
  const cola = [TIMEOUT_LINUX, '-k', String(GRACIA_KILL), String(segundos), ...(envLinux.length ? [ENV_LINUX, ...envLinux] : []), ...args];
  if (so === 'win32') {
    const c = configEfectiva(config);
    const wsl = ['-d', c.wsl.distro];
    if (c.wsl.usuario && c.wsl.usuario !== 'root') wsl.push('-u', c.wsl.usuario);
    if (opciones.cwd) wsl.push('--cd', aRutaMotor(opciones.cwd, so));
    return { programa: 'wsl.exe', args: [...wsl, '-e', ...cola] };
  }
  return { programa: cola[0], args: cola.slice(1) };
}

// Ejecuta `args` en Linux (WSL en Windows; directo en Linux). Misma forma de retorno que ejecutar().
// En una plataforma no soportada devuelve codigo 125 y error 'no-soportado' sin lanzar.
function ejecutarEnLinux(args, opciones = {}, config) {
  const p = plataforma();
  if (p.modo === 'no-soportado') return { codigo: 125, stdout: '', stderr: 'plataforma no soportada para el motor de Linux', agotado: false, error: 'no-soportado' };
  const { programa, args: argv } = argumentosLinux(args, opciones, config);
  const segundos = Number(opciones.segundos) > 0 ? Number(opciones.segundos) : SEGUNDOS_DEFECTO;
  return ejecutar(programa, argv, {
    segundos, input: opciones.input, env: opciones.envPadre || process.env,
    cwd: p.modo === 'linux' ? opciones.cwd : undefined, maxBuffer: opciones.maxBuffer,
  });
}

// ¿El motor de Linux responde? → { listo, detalle }. Windows: `wsl.exe -d <distro> -e true` en ≤ 20 s; Linux: existe /usr/bin/timeout.
function motorListo(config) {
  const p = plataforma();
  if (p.modo === 'no-soportado') return { listo: false, detalle: `plataforma ${p.so} sin soporte para las piezas de Linux (capa 3)` };
  if (p.modo === 'linux') {
    const hay = fs.existsSync(TIMEOUT_LINUX);
    return { listo: hay, detalle: hay ? 'Linux nativo' : `falta ${TIMEOUT_LINUX} (paquete coreutils)` };
  }
  const c = configEfectiva(config);
  const r = ejecutar('wsl.exe', ['-d', c.wsl.distro, '-e', 'true'], { segundos: 20, margenSegundos: 5 });
  if (r.codigo === 0) return { listo: true, detalle: `WSL2 · distro ${c.wsl.distro}` };
  const texto = (r.stderr || r.stdout || '').replace(/\0/g, '').trim().split(/\r?\n/)[0] || r.error || `código ${r.codigo}`;
  return { listo: false, detalle: `wsl.exe -d ${c.wsl.distro} no responde: ${texto}` };
}

// Intérprete de Python disponible (nombre de programa) o null. Orden: python3, python, py.
function comandoPython() {
  for (const p of ['python3', 'python', 'py']) {
    const r = ejecutar(p, ['--version'], { segundos: 10, margenSegundos: 2 });
    if (r.codigo === 0 && /Python 3/.test(r.stdout + r.stderr)) return p;
  }
  return null;
}

// Gestor de paquetes de un proyecto Node por su archivo de bloqueo: pnpm | yarn | bun | npm (por defecto).
function resolverGestor(dirProyecto) {
  const hay = (f) => fs.existsSync(path.join(dirProyecto, f));
  if (hay('pnpm-lock.yaml')) return 'pnpm';
  if (hay('yarn.lock')) return 'yarn';
  if (hay('bun.lockb') || hay('bun.lock')) return 'bun';
  return 'npm';
}

// Mata un proceso y sus hijos. Windows: taskkill /T /F; POSIX: el grupo de procesos si existe, si no el pid.
function matarArbol(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return r.status === 0;
  }
  try { process.kill(-pid, 'SIGKILL'); return true; } catch { /* sin grupo propio */ }
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

module.exports = {
  SEGUNDOS_DEFECTO, MARGEN_SEGUNDOS, GRACIA_KILL, TIMEOUT_LINUX, CAJA,
  plataforma, ejecutar, aRutaMotor, deRutaMotor, prefijoMotor, prefijoCaja, argumentosLinux, ejecutarEnLinux,
  motorListo, comandoPython, resolverGestor, matarArbol,
};
