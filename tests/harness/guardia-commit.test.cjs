// Pruebas de la guarda de git del plugin uaeh-harness: git-hooks/ + hooks/guardia-commit.cjs (y la capa de texto
// hooks/guardia-git.js en los casos de B24). Correr: node --test tests/harness/guardia-commit.test.cjs
//
// Commits REALES con git y shells REALES en repos temporales: Bash siempre (Git Bash en Windows, bash en POSIX) y
// PowerShell solo en Windows (esos casos se registran únicamente allí). Hermética: casa temporal
// (tests/helpers/entorno.cjs); cada corrida fija GIT_CONFIG_GLOBAL=<temporal> con core.hooksPath=<git-hooks/ del plugin>
// (guarda ACTIVA) o sin hooksPath (control: demuestra que el commit SÍ ocurre cuando la guarda no está, o sea que lo
// detiene la guarda y no otra cosa). git-hooks/ y hooks/ son carpetas hermanas, igual que en el espejo estable del plugin.
// Política de commits: la suite principal corre con commits.credito = prohibir y una firma de ejemplo (UAEH_COMMIT_*);
// un bloque aparte cubre la política por defecto (permitir): el crédito y las identidades de Claude pasan, los secretos no.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, gitConfigGlobal, requiereBash, rutaBash, RAIZ_HARNESS, SECRETO_FALSO } = require('../helpers/entorno.cjs');

const WIN = process.platform === 'win32';
const SHELLS = WIN ? ['bash', 'ps'] : ['bash']; // 'ps' = PowerShell 5.1 real (solo Windows)
const tool = (sh) => (sh === 'bash' ? 'Bash' : 'PowerShell');
const HOOKS_GLOBAL = path.join(RAIZ_HARNESS, 'git-hooks');
const GUARDIA = path.join(RAIZ_HARNESS, 'hooks', 'guardia-commit.cjs');
const GUARDIA_GIT = path.join(RAIZ_HARNESS, 'hooks', 'guardia-git.js');
const BASH = rutaBash();
const FIRMA = 'Authored By: ejemplo.com';
const AKIA = SECRETO_FALSO; // armada por partes: este archivo no dispara el propio guardia
const ENV_VALOR = 'VALOR_ENV_' + 'SECRETO_123';
const p = (x) => x.replace(/\\/g, '/');

const E = entornoTemporal('uaeh-guardia-commit-');
process.on('exit', () => E.limpiar());
const RAIZ = E.dir;
const GC_OFF = gitConfigGlobal(E);                         // sin guarda (control)
const GC_ON = gitConfigGlobal(E, { hooksPath: HOOKS_GLOBAL }); // con la guarda del plugin

// Comprobaciones acumuladas: una prueba muestra TODOS sus fallos, no solo el primero.
let FALLOS = null;
function chequear(nombre, cond, detalle) {
  if (cond) return;
  const m = nombre + (detalle ? '  ->  ' + detalle : '');
  if (FALLOS) FALLOS.push(m); else assert.fail(m);
}
// Una prueba. bash:true (por defecto) necesita un bash real: sin él es fallo en modo estricto (UAEH_CI=1), salto con motivo si no.
function prueba(nombre, fn, { bash = true } = {}) {
  test(nombre, (t) => {
    if (bash && !requiereBash(t)) return;
    const previo = FALLOS;
    FALLOS = [];
    try {
      fn(t);
      if (FALLOS.length) assert.fail('\n' + FALLOS.join('\n'));
    } finally { FALLOS = previo; }
  });
}
const pruebaSinBash = (nombre, fn) => prueba(nombre, fn, { bash: false });

// Entorno de git/shell de una corrida: sin las GIT_* del proceso, con el gitconfig global dado y la política de commits.
// politica 'prohibir' (suite principal: credito=prohibir + firma de ejemplo) | 'permitir' (la de defecto: sin variables UAEH_COMMIT_*).
// UAEH_GIT_HOOKS: la guarda que espera la capa de texto (guardia-git.js) para considerar activa la de git.
function entorno(gc, extra, politica = 'prohibir') {
  const e = {};
  for (const [k, v] of Object.entries(E.env)) if (!/^GIT_/i.test(k)) e[k] = v;
  e.GIT_CONFIG_GLOBAL = gc;
  e.GIT_CONFIG_NOSYSTEM = '1';
  e.UAEH_GIT_HOOKS = HOOKS_GLOBAL;
  delete e.UAEH_COMMIT_CREDITO; delete e.UAEH_COMMIT_FIRMA;
  if (politica === 'prohibir') { e.UAEH_COMMIT_CREDITO = 'prohibir'; e.UAEH_COMMIT_FIRMA = FIRMA; }
  return { ...e, ...(extra || {}) };
}
function git(cwd, gc, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: entorno(gc), timeout: 60000 });
  return r;
}
function gitOk(cwd, ...args) {
  const r = git(cwd, GC_OFF, ...args);
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout;
}
function head(cwd) {
  const r = git(cwd, GC_OFF, 'rev-parse', '-q', '--verify', 'HEAD');
  return r.status === 0 ? r.stdout.trim() : '';
}

// Ejecuta un guion con una shell REAL.
function ejecutar(shell, guion, cwd, gc, extraEnv, politica) {
  const args = shell === 'bash' ? ['-c', guion] : ['-NoProfile', '-Command', guion];
  const exe = shell === 'bash' ? BASH : 'powershell.exe';
  const t0 = process.hrtime.bigint();
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', env: entorno(gc, extraEnv, politica), timeout: 120000, windowsHide: true });
  return { status: r.status, salida: (r.stdout || '') + (r.stderr || ''), stderr: r.stderr || '', ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

// guardia-commit.cjs corrido directo (sin shell ni hooks de git): { cwd, politica, extra, script }.
function guardiaDirecto(modo, args, { cwd, politica = 'prohibir', extra, script = GUARDIA } = {}) {
  return spawnSync(process.execPath, [script, modo, ...args], { cwd, encoding: 'utf8', env: entorno(GC_ON, extra, politica), timeout: 60000 });
}

// Hook LOCAL del repo (.git/hooks/<nombre>), ejecutable: en POSIX git ignora un hook sin permiso de ejecución.
function hookLocal(repo, nombre, contenido) {
  const f = path.join(repo, '.git', 'hooks', nombre);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, contenido);
  fs.chmodSync(f, 0o755);
}
// commit-msg local «de firma»: quita las líneas con el crédito de Claude y firma el mensaje (la firma de un proyecto).
const HOOK_FIRMA_LOCAL = '#!/bin/sh\ngrep -v -i "co-authored-by: claude" "$1" > "$1.tmp" && mv "$1.tmp" "$1"\nprintf "\\nAuthored By: test\\n" >> "$1"\nexit 0\n';
// PNG mínimo de 1×1 (binario real: lleva bytes NUL; la firma de 8 bytes sola es texto para git).
const PNG_MINIMO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let n = 0;
const nuevaCarpeta = (pre) => { const d = path.join(RAIZ, pre + n++); fs.mkdirSync(d, { recursive: true }); return d; };

// Contenidos «malos». `kind` = 'env' (archivo sensible) | 'sec' (llave en una línea de un archivo normal)
const MALO = {
  env: { archivo: '.env', limpio: 'B=0\n', malo: 'A=' + ENV_VALOR + '\n', esperado: '.env (archivo sensible)' },
  sec: { archivo: 'src/cfg.js', limpio: 'const k = 1;\n', malo: 'const a = 1;\nconst k = "' + AKIA + '";\n', esperado: 'src/cfg.js:' },
};
function escribir(dir, rel, contenido) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), contenido);
}

// Prepara un repo. modo: 'staged' (malo en el índice) | 'trackedmod' (rastreado y modificado sin stagear) |
// 'altindex' (malo en un índice alterno, GIT_INDEX_FILE) | 'nohead' (primer commit: malo en el índice, sin HEAD)
function preparar(kind, modo) {
  const m = MALO[kind];
  const repo = nuevaCarpeta('repo');
  gitOk(repo, 'init', '-q');
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'sub', 'x.txt'), 'x\n');
  const ctx = { repo, otro: nuevaCarpeta('otro'), idx: path.join(nuevaCarpeta('idx'), 'indice-alterno'), archivo: m.archivo, m };
  if (modo === 'nohead') {
    escribir(repo, m.archivo, m.malo);
    gitOk(repo, 'add', m.archivo);
    return ctx;
  }
  escribir(repo, 'base.txt', 'hola\n');
  if (modo === 'trackedmod') escribir(repo, m.archivo, m.limpio);
  gitOk(repo, 'add', '-A');
  gitOk(repo, 'commit', '-q', '-m', 'inicial');
  if (modo === 'trackedmod') escribir(repo, m.archivo, m.malo);
  else if (modo === 'altindex') {
    escribir(repo, m.archivo, m.malo);
    const r = spawnSync('git', ['add', m.archivo], { cwd: repo, encoding: 'utf8', env: entorno(GC_OFF, { GIT_INDEX_FILE: ctx.idx }) });
    if (r.status !== 0) throw new Error('add índice alterno: ' + r.stderr);
  } else { escribir(repo, m.archivo, m.malo); gitOk(repo, 'add', m.archivo); }
  return ctx;
}

// ---------------------------------------------------------------- formas de commit (c4 + V-001/V-002 de verificador B)
// cmd(ctx) → guion; cwd: 'repo' | 'otro' | 'sub'; modo: ver preparar(); silencio: la forma oculta stderr (solo se mira HEAD)
const R = (c) => p(c.repo);
const FORMAS = [
  // --- reportadas en el ciclo 4 (Codex, uae-security, verificador A)
  { n: 'commit -m x --trailer', sh: 'bash', cmd: () => 'git commit -m x --trailer "Reviewed-by: A"' },
  { n: 'commit -m x --trailer (PowerShell)', sh: 'ps', cmd: () => 'git commit -m x --trailer "Reviewed-by: A"' },
  { n: '(cd sub && true) && git add . && git commit', sh: 'bash', cmd: () => '(cd sub && true) && git add . && git commit -m x' },
  { n: 'bash -c "cd otro"; git commit', sh: 'bash', cmd: (c) => `bash -c "cd ${p(c.otro)}"; git commit -m x` },
  { n: 'env -C repoA bash -c "git commit"', sh: 'bash', cwd: 'otro', cmd: (c) => `env -C ${R(c)} bash -c "git commit -m x"` },
  { n: 'find -execdir git commit', sh: 'bash', cwd: 'otro', cmd: (c) => `find ${R(c)} -maxdepth 1 -name .git -execdir git commit -m x ';'` },
  { n: 'node -e execFileSync([git,commit])', sh: 'bash', cmd: () => `node -e "require('child_process').execFileSync('git',['commit','-m','x'],{stdio:'inherit'})"` },
  { n: 'PowerShell if ($true) { git add -A; git commit }', sh: 'ps', cmd: () => 'if ($true) { git add -A; git commit -m x }' },
  { n: 'PowerShell $o = git commit', sh: 'ps', cmd: () => '$o = git commit -m x' },
  { n: 'PowerShell try { git commit } catch {}', sh: 'ps', cmd: () => 'try { git commit -m x } catch {}' },
  { n: 'Bash out=$(git commit)', sh: 'bash', cmd: () => 'out=$(git commit -m x)' },
  { n: 'git --git-dir --work-tree commit', sh: 'bash', cwd: 'otro', cmd: (c) => `git --git-dir=${R(c)}/.git --work-tree=${R(c)} commit -m x` },
  { n: 'git --git-dir --work-tree commit (PowerShell)', sh: 'ps', cwd: 'otro', cmd: (c) => `git --git-dir="${R(c)}/.git" --work-tree="${R(c)}" commit -m x` },
  { n: 'GIT_INDEX_FILE=<i> git commit', sh: 'bash', modo: 'altindex', cmd: (c) => `GIT_INDEX_FILE=${p(c.idx)} git commit -m x` },
  { n: 'PowerShell $env:GIT_INDEX_FILE; git commit', sh: 'ps', modo: 'altindex', cmd: (c) => `$env:GIT_INDEX_FILE = "${p(c.idx)}"; git commit -m x` },
  { n: 'git commit -a con archivo rastreado modificado', sh: 'bash', modo: 'trackedmod', cmd: () => 'git commit -a -m x' },
  { n: 'git commit -am (PowerShell)', sh: 'ps', modo: 'trackedmod', cmd: () => 'git commit -am x' },
  { n: 'git commit -m x -- <ruta> (--only)', sh: 'bash', modo: 'trackedmod', cmd: (c) => `git commit -m x -- ${c.archivo}` },
  { n: 'git commit --only <ruta> (PowerShell)', sh: 'ps', modo: 'trackedmod', cmd: (c) => `git commit --only -m x ${c.archivo}` },
  { n: 'git commit -i <ruta>', sh: 'bash', modo: 'trackedmod', cmd: (c) => `git commit -i -m x ${c.archivo}` },
  { n: 'git commit sin HEAD (primer commit)', sh: 'bash', modo: 'nohead', cmd: () => 'git commit -m x' },
  { n: 'git commit sin HEAD (PowerShell)', sh: 'ps', modo: 'nohead', cmd: () => 'git commit -m x' },
  { n: 'bash scripts && git commit (nada que analizar)', sh: 'bash', cmd: () => 'true && git commit -m x' },
  { n: 'eval "$c" con git commit', sh: 'bash', cmd: () => 'c="git commit -m x"; eval "$c"' },
  { n: 'sh -c anidado 3 niveles', sh: 'bash', cmd: () => `sh -c "sh -c \\"sh -c 'git commit -m x'\\"" ` },
  { n: 'git commit --amend --no-edit (amend de un commit limpio + malo staged)', sh: 'bash', cmd: () => 'git commit --amend --no-edit' },
  // --- la forma MÁS común (verificador B c4, V-001/V-002): redirecciones, comentarios, llaves, funciones, case
  { n: 'git commit -m x 2>&1', sh: 'bash', cmd: () => 'git commit -m x 2>&1' },
  { n: 'git commit -m x >/dev/null 2>&1', sh: 'bash', silencio: true, cmd: () => 'git commit -m x >/dev/null 2>&1' },
  { n: 'git commit -m x # nota', sh: 'bash', cmd: () => 'git commit -m x # nota' },
  { n: '{ git commit -m x; }', sh: 'bash', cmd: () => '{ git commit -m x; }' },
  { n: 'f() { git commit -m x; }; f', sh: 'bash', cmd: () => 'f() { git commit -m x; }; f' },
  { n: 'case 1 in 1) git commit -m x;; esac', sh: 'bash', cmd: () => 'case 1 in 1) git commit -m x;; esac' },
  { n: 'PowerShell git commit -m x *> $null', sh: 'ps', silencio: true, cmd: () => 'git commit -m x *> $null' },
  { n: 'PowerShell & { git commit -m x }', sh: 'ps', cmd: () => '& { git commit -m x }' },
  { n: 'PowerShell 1 | ForEach-Object { git commit }', sh: 'ps', cmd: () => '1 | ForEach-Object { git commit -m x }' },
  { n: 'PowerShell Invoke-Command -ScriptBlock', sh: 'ps', cmd: () => 'Invoke-Command -ScriptBlock { git commit -m x }' },
  { n: 'PowerShell Write-Host (git commit)', sh: 'ps', cmd: () => 'Write-Host (git commit -m x)' },
];

for (const f of FORMAS) {
  if (f.sh === 'ps' && !WIN) continue; // PowerShell real: solo en Windows (se registra allí, no se omite)
  const modo = f.modo || 'staged';
  const cwdDe = (ctx) => (f.cwd === 'otro' ? ctx.otro : f.cwd === 'sub' ? path.join(ctx.repo, 'sub') : ctx.repo);
  for (const kind of ['env', 'sec']) {
    prueba(`[${f.sh}/${kind}] NO commitea: ${f.n}`, () => {
      const ctx = preparar(kind, modo);
      const antes = head(ctx.repo);
      // amend: el commit a enmendar es el inicial; el HEAD no debe cambiar
      const r = ejecutar(f.sh, f.cmd(ctx), cwdDe(ctx), GC_ON);
      const despues = head(ctx.repo);
      chequear('NO commitea', despues === antes, `HEAD ${antes.slice(0, 7)} -> ${despues.slice(0, 7)} salida=${r.salida.slice(0, 300)}`);
      if (!f.silencio) chequear('motivo en la salida', r.salida.includes('Guardia UAEH') && r.salida.includes(ctx.m.esperado), r.salida.slice(0, 300));
      chequear('la salida NO trae el valor', !r.salida.includes(AKIA) && !r.salida.includes(ENV_VALOR), '');
    });
  }
  // CONTROL: sin la guarda (GIT_CONFIG_GLOBAL sin hooksPath) el MISMO comando SÍ commitea → la detiene la guarda
  prueba(`[${f.sh}] CONTROL sin guarda SÍ commitea: ${f.n}`, () => {
    const c2 = preparar('env', modo);
    const a2 = head(c2.repo);
    const r2 = ejecutar(f.sh, f.cmd(c2), cwdDe(c2), GC_OFF);
    chequear('CONTROL sin guarda SÍ commitea', head(c2.repo) !== a2, r2.salida.slice(0, 300));
  });
}

// ---------------------------------------------------------------- controles de comportamiento
function repoLimpio() {
  const repo = nuevaCarpeta('limpio');
  gitOk(repo, 'init', '-q');
  escribir(repo, 'base.txt', 'hola\n');
  gitOk(repo, 'add', '-A');
  gitOk(repo, 'commit', '-q', '-m', 'inicial');
  return repo;
}
function mensajeUltimo(repo) { return git(repo, GC_OFF, 'log', '-1', '--format=%B').stdout; }

prueba("commit limpio ocurre (con guarda activa) y .env.example pasa", () => {
  const repo = repoLimpio();
  escribir(repo, 'a.txt', 'nada raro\n'); escribir(repo, '.env.example', 'A=\n');
  gitOk(repo, 'add', '-A');
  const a = head(repo);
  const r = ejecutar('bash', 'git commit -m "docs: ok"', repo, GC_ON);
  chequear('commit limpio OCURRE con la guarda activa', head(repo) !== a && r.status === 0, r.salida.slice(0, 300));
});
prueba("el crédito de Claude en el mensaje → no ocurre; sin crédito → ocurre", () => {
  const repo = repoLimpio();
  escribir(repo, 'a.txt', 'x\n'); gitOk(repo, 'add', '-A');
  const a = head(repo);
  const msg = 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
  const r = ejecutar('bash', `git commit -m "${msg}"`, repo, GC_ON);
  chequear('mensaje con crédito de Claude → NO commitea', head(repo) === a && /prohíbe el crédito de Claude/.test(r.salida), r.salida.slice(0, 300));
  const r2 = ejecutar('bash', 'git commit -F - <<< "feat: y\n\nClaude-Session: https://x"', repo, GC_ON);
  chequear('crédito por -F - (entrada estándar) → NO commitea', head(repo) === a && /prohíbe el crédito de Claude/.test(r2.salida), r2.salida.slice(0, 300));
  for (const sh of SHELLS) {
    const r3 = ejecutar(sh, 'git commit -m "Generated with [Claude Code](https://claude.com/claude-code)"', repo, GC_ON);
    chequear('crédito Generated with Claude Code (' + sh + ') → NO commitea', head(repo) === a, r3.salida.slice(0, 300));
  }
});
prueba("hook commit-msg LOCAL que firma (y quita el crédito): la firma queda y el crédito que él quita NO bloquea", () => {
  const repo = repoLimpio();
  hookLocal(repo, 'commit-msg', HOOK_FIRMA_LOCAL);
  escribir(repo, 'a.txt', 'x\n'); gitOk(repo, 'add', '-A');
  const a = head(repo);
  const r = ejecutar('bash', 'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"', repo, GC_ON);
  const m = mensajeUltimo(repo);
  chequear('commit-msg LOCAL: commitea, firma queda y el crédito que él quita no bloquea', head(repo) !== a && /Authored By: test/.test(m) && !/Claude/i.test(m), r.salida.slice(0, 300) + ' | ' + m);
  // un local que NO quita el crédito: la guarda global lo ve en el mensaje FINAL
  hookLocal(repo, 'commit-msg', '#!/bin/sh\nexit 0\n');
  escribir(repo, 'b.txt', 'y\n'); gitOk(repo, 'add', '-A');
  const b = head(repo);
  ejecutar('bash', 'git commit -m "feat: y\n\nCo-Authored-By: Claude <noreply@anthropic.com>"', repo, GC_ON);
  chequear('commit-msg LOCAL que no quita el crédito: la guarda global lo niega', head(repo) === b, '');
  // un local que FALLA: su código se devuelve (el commit no ocurre)
  hookLocal(repo, 'commit-msg', '#!/bin/sh\necho local-dice-no >&2\nexit 7\n');
  const r4 = ejecutar('bash', 'git commit -m "feat: z"', repo, GC_ON);
  chequear('commit-msg LOCAL que falla: el commit no ocurre y se ve su mensaje', head(repo) === b && /local-dice-no/.test(r4.salida), r4.salida.slice(0, 200));
});
prueba("pre-commit LOCAL: solo se encadena; el contenido se revisa DESPUÉS, en prepare-commit-msg", () => {
  const repo = repoLimpio();
  hookLocal(repo, 'pre-commit', '#!/bin/sh\necho "pre-commit-local-corrio" > "$(git rev-parse --git-dir)/marca-pre"\nexit 0\n');
  escribir(repo, 'a.txt', 'x\n'); gitOk(repo, 'add', '-A');
  const a = head(repo);
  ejecutar('bash', 'git commit -m "feat: x"', repo, GC_ON);
  chequear('pre-commit LOCAL corre (encadenado) en un commit limpio', head(repo) !== a && fs.existsSync(path.join(repo, '.git', 'marca-pre')), '');
  fs.rmSync(path.join(repo, '.git', 'marca-pre'), { force: true });
  escribir(repo, '.env', 'A=1\n'); gitOk(repo, 'add', '-f', '.env');
  const b = head(repo);
  ejecutar('bash', 'git commit -m "feat: y"', repo, GC_ON);
  // CAMBIADA (ciclo 6, B19): antes la revisión iba en pre-commit ANTES del local («el local no corre»); ahora pre-commit
  // solo encadena y la revisión va en prepare-commit-msg (después): el local SÍ corre y el commit igual no ocurre.
  chequear('con .env: el pre-commit local corre y prepare-commit-msg niega el commit', head(repo) === b && fs.existsSync(path.join(repo, '.git', 'marca-pre')), '');
});
prueba("SEC-005 (Codex c5): un pre-commit LOCAL que AGREGA un .env al índice tras la revisión → igual no se commitea", () => {
  const repo = repoLimpio();
  hookLocal(repo, 'pre-commit', '#!/bin/sh\necho "A=' + ENV_VALOR + '" > .env\ngit add -f .env\nexit 0\n');
  escribir(repo, 'a.txt', 'x\n'); gitOk(repo, 'add', '-A');
  const a = head(repo);
  const r = ejecutar('bash', 'git commit -m "feat: x"', repo, GC_ON);
  chequear('pre-commit LOCAL que agrega un .env → NO commitea (revisión en prepare-commit-msg, después)', head(repo) === a && /\.env \(archivo sensible\)/.test(r.salida) && !r.salida.includes(ENV_VALOR), r.salida.slice(0, 300));
});
prueba("prepare-commit-msg LOCAL que SACA el .env del índice: git ya fijó el árbol (medido) → la revisión va ANTES del local", () => {
  const repo = repoLimpio();
  hookLocal(repo, 'prepare-commit-msg', '#!/bin/sh\ngit rm -q --cached .env\nexit 0\n');
  escribir(repo, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(repo, 'add', '-f', '.env');
  const a = head(repo);
  const r = ejecutar('bash', 'git commit -m "feat: x"', repo, GC_ON);
  chequear('prepare-commit-msg LOCAL que hace rm --cached .env → igual NO commitea', head(repo) === a, r.salida.slice(0, 300));
  const c2 = repoLimpio();
  hookLocal(c2, 'prepare-commit-msg', '#!/bin/sh\ngit rm -q --cached .env\nexit 0\n');
  escribir(c2, '.env', 'A=1\n'); gitOk(c2, 'add', '-f', '.env');
  ejecutar('bash', 'git commit -m "feat: x"', c2, GC_OFF);
  chequear('CONTROL (medición): sin la guarda, ese hook local NO evita que el .env entre al commit', /\.env/.test(git(c2, GC_OFF, 'ls-tree', '--name-only', 'HEAD').stdout), '');
});
prueba("prepare-commit-msg LOCAL recibe sus argumentos y puede editar el mensaje", () => {
  const repo = repoLimpio();
  hookLocal(repo, 'prepare-commit-msg', '#!/bin/sh\necho "args:$2" > "$(git rev-parse --git-dir)/pcm-args"\necho "[ticket-1]" >> "$1"\nexit 0\n');
  escribir(repo, 'a.txt', 'x\n'); gitOk(repo, 'add', '-A');
  const a = head(repo);
  ejecutar('bash', 'git commit -m "feat: x"', repo, GC_ON);
  const args = fs.existsSync(path.join(repo, '.git', 'pcm-args')) ? fs.readFileSync(path.join(repo, '.git', 'pcm-args'), 'utf8') : '';
  chequear('prepare-commit-msg LOCAL: recibe argumentos y su edición del mensaje queda', head(repo) !== a && /args:message/.test(args) && /\[ticket-1\]/.test(mensajeUltimo(repo)), args);
});
prueba("pre-push LOCAL recibe su entrada estándar y sus argumentos", () => {
  const repo = repoLimpio();
  const remoto = nuevaCarpeta('remoto');
  gitOk(remoto, 'init', '-q', '--bare');
  gitOk(repo, 'remote', 'add', 'origin', p(remoto));
  hookLocal(repo, 'pre-push', '#!/bin/sh\necho "args:$1" > "$(git rev-parse --git-dir)/pp-args"\ncat > "$(git rev-parse --git-dir)/pp-stdin"\nexit 0\n');
  const r = ejecutar('bash', 'git push -q origin HEAD:refs/heads/main', repo, GC_ON);
  const stdin = fs.existsSync(path.join(repo, '.git', 'pp-stdin')) ? fs.readFileSync(path.join(repo, '.git', 'pp-stdin'), 'utf8') : '';
  const args = fs.existsSync(path.join(repo, '.git', 'pp-args')) ? fs.readFileSync(path.join(repo, '.git', 'pp-args'), 'utf8') : '';
  chequear('pre-push LOCAL recibe la entrada estándar (refs) y los argumentos', /refs\/heads\/main/.test(stdin) && /^args:origin/.test(args) && r.status === 0, `stdin=${JSON.stringify(stdin)} args=${args} ${r.salida.slice(0, 200)}`);
  // y su código de salida se respeta
  hookLocal(repo, 'pre-push', '#!/bin/sh\ncat > /dev/null\nexit 3\n');
  const r2 = ejecutar('bash', 'git push -q origin HEAD:refs/heads/otra', repo, GC_ON);
  chequear('pre-push LOCAL que falla: el push falla', r2.status !== 0, r2.salida.slice(0, 200));
});
prueba("post-rewrite LOCAL (stdin) y post-commit LOCAL (solo encadenan)", () => {
  const repo = repoLimpio();
  hookLocal(repo, 'post-rewrite', '#!/bin/sh\ncat > "$(git rev-parse --git-dir)/pr-stdin"\necho "$1" > "$(git rev-parse --git-dir)/pr-arg"\n');
  hookLocal(repo, 'post-commit', '#!/bin/sh\necho x > "$(git rev-parse --git-dir)/pc-marca"\n');
  const r = ejecutar('bash', 'git commit --amend --no-edit -m "reescrito"', repo, GC_ON);
  const stdin = fs.existsSync(path.join(repo, '.git', 'pr-stdin')) ? fs.readFileSync(path.join(repo, '.git', 'pr-stdin'), 'utf8') : '';
  chequear('post-rewrite LOCAL recibe su entrada estándar (old new) y el argumento', /^[0-9a-f]{40} [0-9a-f]{40}/.test(stdin) && /amend/.test(fs.existsSync(path.join(repo, '.git', 'pr-arg')) ? fs.readFileSync(path.join(repo, '.git', 'pr-arg'), 'utf8') : ''), `stdin=${JSON.stringify(stdin)} ${r.salida.slice(0, 200)}`);
  chequear('post-commit LOCAL corre (encadenado)', fs.existsSync(path.join(repo, '.git', 'pc-marca')), '');
});
prueba("commit en un git worktree: corre la guarda y el hook local del repo COMÚN", () => {
  const repo = repoLimpio();
  hookLocal(repo, 'pre-commit', '#!/bin/sh\necho corrio >> "$(git rev-parse --git-common-dir)/marca-wt"\nexit 0\n');
  const wt = path.join(nuevaCarpeta('wt'), 'arbol');
  gitOk(repo, 'worktree', 'add', '-q', '-b', 'rama-wt', wt);
  escribir(wt, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(wt, 'add', '-f', '.env');
  const a = head(wt);
  const r = ejecutar('bash', 'git commit -m x', wt, GC_ON);
  chequear('worktree: .env → NO commitea y avisa', head(wt) === a && /\.env \(archivo sensible\)/.test(r.salida) && !r.salida.includes(ENV_VALOR), r.salida.slice(0, 300));
  gitOk(wt, 'rm', '-q', '--cached', '.env'); fs.rmSync(path.join(wt, '.env'));
  escribir(wt, 'ok.txt', 'ok\n'); gitOk(wt, 'add', 'ok.txt');
  const r2 = ejecutar('bash', 'git commit -m ok', wt, GC_ON);
  chequear('worktree: commit limpio ocurre y corre el pre-commit local del repo común', head(wt) !== a && fs.existsSync(path.join(repo, '.git', 'marca-wt')), r2.salida.slice(0, 300));
});
prueba("merge sin conflictos de una rama que ya traía un secreto en SU historial → historial (regla de origen): SÍ commitea.", () => {
  // CAMBIADA (ciclo 6, B19 regla de origen; uae-security c5 SEC-006): en c5 este merge se negaba en pre-merge-commit.
  const repo = repoLimpio();
  gitOk(repo, 'checkout', '-q', '-b', 'otra');
  escribir(repo, 'src/cfg.js', 'const k = "' + AKIA + '";\n'); gitOk(repo, 'add', '-A'); gitOk(repo, 'commit', '-q', '-m', 'con secreto');
  gitOk(repo, 'checkout', '-q', 'main');
  escribir(repo, 'otro.txt', 'otro\n'); gitOk(repo, 'add', '-A'); gitOk(repo, 'commit', '-q', '-m', 'en main');
  const a = head(repo);
  const r = ejecutar('bash', 'git merge --no-ff -m "merge" otra', repo, GC_ON);
  chequear('merge --no-ff de una rama con un secreto YA commiteado en ella → SÍ commitea (historial)', head(repo) !== a && r.status === 0, r.salida.slice(0, 300));
});
prueba("la guarda solo mira lo que se commitea: un secreto que YA estaba en el commit anterior no bloquea el siguiente", () => {
  const repo = repoLimpio();
  escribir(repo, 'src/cfg.js', 'const k = "' + AKIA + '";\n'); gitOk(repo, 'add', '-A'); gitOk(repo, 'commit', '-q', '-m', 'viejo');
  escribir(repo, 'n.txt', 'nuevo\n'); gitOk(repo, 'add', 'n.txt');
  const a = head(repo);
  ejecutar('bash', 'git commit -m "docs: solo n"', repo, GC_ON);
  chequear('un secreto ya commiteado antes no bloquea un commit nuevo limpio', head(repo) !== a, '');
});
prueba("evidencias del navegador (mismo texto de motivo que guardia-git)", () => {
  const repo = repoLimpio();
  escribir(repo, '.playwright-cli/page-1.yml', 'x\n'); gitOk(repo, 'add', '-f', '.playwright-cli/page-1.yml');
  const a = head(repo);
  const r = ejecutar('bash', 'git commit -m x', repo, GC_ON);
  chequear('evidencia .playwright-cli → NO commitea con el motivo de evidencias', head(repo) === a && /evidencias del navegador/.test(r.salida) && /\.playwright-cli\/page-1\.yml/.test(r.salida), r.salida.slice(0, 300));
  gitOk(repo, 'rm', '-q', '--cached', '.playwright-cli/page-1.yml');
  // .playwright/ ya NO es evidencia (A21): lleva la configuración de playwright-cli
  escribir(repo, '.playwright/cli.config.json', '{}\n'); gitOk(repo, 'add', '-f', '.playwright/cli.config.json');
  const b = head(repo);
  ejecutar('bash', 'git commit -m "chore: config de playwright-cli"', repo, GC_ON);
  chequear('.playwright/cli.config.json (configuración) SÍ se puede commitear', head(repo) !== b, '');
});
prueba("contraseña en texto / .pem / llave Anthropic con valor fuera del mensaje", () => {
  const repo = repoLimpio();
  escribir(repo, 'k/server.pem', 'abc\n'); gitOk(repo, 'add', '-A');
  const a = head(repo);
  for (const sh of SHELLS) {
    const r = ejecutar(sh, 'git commit -m x', repo, GC_ON);
    chequear('*.pem → NO commitea (' + sh + ')', head(repo) === a && /server\.pem \(archivo sensible\)/.test(r.salida), r.salida.slice(0, 300));
  }
});
prueba("línea muy larga con la llave en medio (ventanas solapadas de guardia-git) también se ve en el índice", () => {
  const repo = repoLimpio();
  escribir(repo, 'min.js', 'x'.repeat(20000) + 'var k="' + AKIA + '";' + 'y'.repeat(20000) + '\n'); gitOk(repo, 'add', '-A');
  const a = head(repo);
  const r = ejecutar('bash', 'git commit -m x', repo, GC_ON);
  chequear('llave dentro de una línea de 40 KB → NO commitea', head(repo) === a && /min\.js:1 \(llave AWS\)/.test(r.salida), r.salida.slice(0, 200));
});
prueba("diff gigante → niega con «divide el commit» (no se cuelga)", () => {
  const repo = repoLimpio();
  const linea = 'x'.repeat(78) + '\n';
  const trozo = linea.repeat(100000); // ~7.9 MB
  const fd = fs.openSync(path.join(repo, 'enorme.txt'), 'w');
  for (let i = 0; i < 10; i++) fs.writeSync(fd, trozo); // ~79 MB > MAX_DIFF (64 MiB)
  fs.closeSync(fd);
  gitOk(repo, 'add', '-A');
  const a = head(repo);
  const r = ejecutar('bash', 'git commit -m x', repo, GC_ON);
  chequear('diff gigante → NO commitea y pide dividir el commit', head(repo) === a && /divide el commit/.test(r.salida), r.salida.slice(0, 200));
});

// ---------------------------------------------------------------- fallar cerrado de guardia-commit.cjs
pruebaSinBash("fallar CERRADO de guardia-commit.cjs (fuera de un repo, estado ilegible, archivos ilegibles, modo desconocido)", () => {
  const fuera = nuevaCarpeta('fuera'); // no es un repo
  const r = spawnSync(process.execPath, [GUARDIA, 'pre-commit'], { cwd: fuera, encoding: 'utf8', env: entorno(GC_ON) });
  chequear('pre-commit fuera de un repo → falla CERRADO (salida 1)', r.status === 1 && /falla cerrado/.test(r.stderr), `${r.status} ${r.stderr.slice(0, 120)}`);
  const r1 = spawnSync(process.execPath, [GUARDIA, 'contenido'], { cwd: fuera, encoding: 'utf8', env: entorno(GC_ON) });
  chequear('contenido fuera de un repo → falla CERRADO (salida 1)', r1.status === 1 && /falla cerrado/.test(r1.stderr), `${r1.status} ${r1.stderr.slice(0, 120)}`);
  const r5 = spawnSync(process.execPath, [GUARDIA, 'applypatch-msg', path.join(fuera, 'no-existe')], { cwd: fuera, encoding: 'utf8', env: entorno(GC_ON) });
  chequear('applypatch-msg con archivo ilegible → falla CERRADO', r5.status === 1, `${r5.status}`);
  { // estado de origen ilegible → falla cerrado
    const repo = repoLimpio();
    fs.writeFileSync(path.join(repo, '.git', 'CHERRY_PICK_HEAD'), 'no-es-un-sha\n');
    const r6 = spawnSync(process.execPath, [GUARDIA, 'contenido'], { cwd: repo, encoding: 'utf8', env: entorno(GC_ON) });
    chequear('CHERRY_PICK_HEAD ilegible → falla CERRADO', r6.status === 1 && /CHERRY_PICK_HEAD ilegible/.test(r6.stderr), r6.stderr.slice(0, 160));
  }
  const r2 = spawnSync(process.execPath, [GUARDIA, 'commit-msg'], { cwd: fuera, encoding: 'utf8', env: entorno(GC_ON) });
  chequear('commit-msg sin archivo → falla CERRADO', r2.status === 1, `${r2.status}`);
  const r3 = spawnSync(process.execPath, [GUARDIA, 'commit-msg', path.join(fuera, 'no-existe')], { cwd: fuera, encoding: 'utf8', env: entorno(GC_ON) });
  chequear('commit-msg con archivo ilegible → falla CERRADO', r3.status === 1, `${r3.status}`);
  const r4 = spawnSync(process.execPath, [GUARDIA, 'otra-cosa'], { cwd: fuera, encoding: 'utf8', env: entorno(GC_ON) });
  chequear('modo desconocido → falla CERRADO', r4.status === 1, `${r4.status}`);
});

// ---------------------------------------------------------------- B13: los hooks de git que git conoce
// Lista de `git help hooks` (git 2.53) + los del lado servidor (un push a un repo local los usaría con core.hooksPath global).
// CAMBIADA (ciclo 6, B22/B22b): fuera los que cambian la conducta de git o amplían el daño si sh falla (lista EXCLUIDOS).
const CLIENTE = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg',
  'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate'];
const SERVIDOR = ['pre-receive', 'update', 'post-receive', 'post-update'];
const EXCLUIDOS = {
  'push-to-checkout': 'su sola presencia cambia la conducta de receive.denyCurrentBranch=updateInstead (uae-security c5 SEC-005)',
  'proc-receive': 'lado servidor: su presencia cambia cómo receive-pack procesa los refs (uae-security c5 SEC-005)',
  'reference-transaction': 'corre en cada cambio de ref: si sh falla, rompe operaciones que no son commits (SEC-011)',
  'post-index-change': 'corre en cada escritura del índice: si sh falla, amplía el daño (SEC-011)',
  'fsmonitor-watchman': 'git no lo usa desde core.hooksPath (lo invoca core.fsmonitor con su propia ruta)',
  'p4-changelist': 'solo git-p4 (Perforce), no se usa', 'p4-prepare-changelist': 'solo git-p4 (Perforce), no se usa',
  'p4-post-changelist': 'solo git-p4 (Perforce), no se usa', 'p4-pre-submit': 'solo git-p4 (Perforce), no se usa',
};
const REVISAN = ['prepare-commit-msg', 'pre-applypatch', 'commit-msg', 'applypatch-msg']; // los que llaman a guardia-commit.cjs
pruebaSinBash('hooks globales: los EXCLUIDOS no existen y git-hooks no trae archivos fuera de la lista', () => {
  for (const h of Object.keys(EXCLUIDOS)) chequear(`hook global EXCLUIDO no existe: ${h} (${EXCLUIDOS[h]})`, !fs.existsSync(path.join(HOOKS_GLOBAL, h)), '');
  const sobran = fs.readdirSync(HOOKS_GLOBAL).filter((f) => ![...CLIENTE, ...SERVIDOR].includes(f));
  chequear('git-hooks no tiene archivos fuera de la lista', sobran.length === 0, sobran.join(','));
});
for (const h of [...CLIENTE, ...SERVIDOR]) {
  pruebaSinBash(`hook global ${h}: #!/bin/sh, LF, sin BOM, ejecutable, encadena el hook local` + (REVISAN.includes(h) ? ' y llama a guardia-commit.cjs' : ' (sin node)'), () => {
    const f = path.join(HOOKS_GLOBAL, h);
    let buf = null;
    try { buf = fs.readFileSync(f); } catch { /* falta */ }
    chequear(`hook global existe: ${h}`, !!buf, '');
    if (!buf) return;
    const txt = buf.toString('utf8');
    chequear(`${h}: #!/bin/sh, LF, sin BOM`, txt.startsWith('#!/bin/sh\n') && !txt.includes('\r') && buf[0] !== 0xEF, JSON.stringify(txt.slice(0, 20)));
    chequear(`${h}: encadena el hook local (git-common-dir)`, txt.includes('--git-common-dir') && txt.includes(`/hooks/${h}"`) && txt.includes('-ef "$0"'), '');
    // CAMBIADA (ciclo 6, B19): los que revisan son prepare-commit-msg, pre-applypatch, commit-msg y applypatch-msg;
    // pre-commit y pre-merge-commit vuelven a SOLO encadenar (un solo escaneo por commit).
    if (!REVISAN.includes(h)) chequear(`${h}: solo encadena (sin node)`, !txt.includes('guardia-commit.cjs"') && !txt.includes('"$n"'), '');
    else chequear(`${h}: llama a guardia-commit.cjs`, txt.includes('guardia-commit.cjs"'), '');
    // En POSIX git ignora (con un aviso) un hook sin permiso de ejecución: la guarda quedaría muda. El bit se fija en el índice
    // de git (git update-index --chmod=+x) y el instalador lo conserva al copiar al espejo.
    if (!WIN) chequear(`${h}: ejecutable`, (fs.statSync(f).mode & 0o111) !== 0, 'falta el bit de ejecución');
  });
}
pruebaSinBash('orden dentro de cada despachador que revisa (ciclo 6)', () => {
  const txt = (h) => fs.readFileSync(path.join(HOOKS_GLOBAL, h), 'utf8');
  const antesQue = (t, a, b) => t.indexOf(a) >= 0 && t.indexOf(b) >= 0 && t.indexOf(a) < t.indexOf(b);
  chequear('prepare-commit-msg: revisa el contenido ANTES del hook local', antesQue(txt('prepare-commit-msg'), 'guardia-commit.cjs" contenido', 'hooks/prepare-commit-msg"'), '');
  chequear('pre-applypatch: hook local y LUEGO el contenido', antesQue(txt('pre-applypatch'), 'hooks/pre-applypatch"', 'guardia-commit.cjs" contenido'), '');
  chequear('commit-msg: hook local y LUEGO el mensaje', antesQue(txt('commit-msg'), 'hooks/commit-msg"', 'guardia-commit.cjs" commit-msg'), '');
  chequear('applypatch-msg: hook local y LUEGO el mensaje', antesQue(txt('applypatch-msg'), 'hooks/applypatch-msg"', 'guardia-commit.cjs" applypatch-msg'), '');
});
// la lista de `git help hooks` está cubierta: cada hook que documenta git tiene archivo global o está en EXCLUIDOS.
// CAMBIADA (ciclo 6, B22b): ids con dígitos (p4-*); los excluidos van en EXCLUIDOS, con su motivo.
function hooksSinCubrir(html) {
  const ids = [...html.matchAll(/id="_([a-z0-9_]+)"/g)].map((m) => m[1].replace(/_/g, '-'));
  const IGNORA = new Set(['name', 'synopsis', 'description', 'hooks', 'see-also', 'git']);
  return { ids, sin: ids.filter((i) => !IGNORA.has(i) && ![...CLIENTE, ...SERVIDOR].includes(i) && !(i in EXCLUIDOS)) };
}
const htmlGithooks = (ids) => '<!DOCTYPE html>\n<html><body>\n' + ids.map((i) => `<h3 id="_${i.replace(/-/g, '_')}">${i}</h3>`).join('\n') + '\n</body></html>\n';
pruebaSinBash('githooks.html (fixture generado): los hooks de la lista y los EXCLUIDOS están cubiertos; los p4-* se ven', () => {
  const { ids, sin } = hooksSinCubrir(htmlGithooks(['name', 'synopsis', 'description', 'hooks', ...CLIENTE, ...SERVIDOR, ...Object.keys(EXCLUIDOS), 'see-also', 'git']));
  chequear('todos los hooks de githooks.html tienen archivo global o están en EXCLUIDOS', sin.length === 0, sin.join(','));
  chequear('githooks.html trae los p4-* (los ve la expresión con dígitos)', ids.includes('p4-pre-submit'), ids.join(','));
});
pruebaSinBash('githooks.html (fixture generado): un hook nuevo de git sin despachador ni exclusión se detecta', () => {
  const { sin } = hooksSinCubrir(htmlGithooks(['hooks', ...CLIENTE, 'pre-hook-nuevo']));
  chequear('detecta el hook nuevo', sin.length === 1 && sin[0] === 'pre-hook-nuevo', sin.join(','));
});
// la documentación REAL del git instalado (`git --html-path`), si está: el aviso de que git sumó un hook que la guarda no conoce.
// Sin documentación instalada no se registra (la lista queda cubierta por las pruebas con fixture de arriba).
const DOC_GITHOOKS = (() => {
  const r = spawnSync('git', ['--html-path'], { encoding: 'utf8' });
  const f = r.status === 0 ? path.join(r.stdout.trim(), 'githooks.html') : '';
  return f && fs.existsSync(f) ? f : null;
})();
if (DOC_GITHOOKS) {
  pruebaSinBash('githooks.html del git instalado: todos sus hooks tienen archivo global o están en EXCLUIDOS', () => {
    const { sin } = hooksSinCubrir(fs.readFileSync(DOC_GITHOOKS, 'utf8'));
    chequear('todos los hooks de githooks.html (git instalado) tienen archivo global o están en EXCLUIDOS', sin.length === 0, sin.join(','));
  });
}
// recursión: si la carpeta local de hooks ES la global, no se vuelve a llamar
prueba("un hook local idéntico al despachador global no entra en bucle (recursión)", () => {
  const repo = repoLimpio();
  escribir(repo, 'a.txt', 'x\n'); gitOk(repo, 'add', '-A');
  const a = head(repo);
  // Un repo cuyo .git/hooks apunta (enlace de directorio/copia) a la global no debe recursar: se simula copiando el despachador
  hookLocal(repo, 'post-commit', fs.readFileSync(path.join(HOOKS_GLOBAL, 'post-commit')));
  const r = ejecutar('bash', 'git commit -m x', repo, GC_ON);
  chequear('hook local idéntico al despachador global no entra en bucle', head(repo) !== a && r.status === 0, r.salida.slice(0, 200));
});

// ---------------------------------------------------------------- ciclo 6 (B24): commits REALES por las vías que no corren pre-commit
// Cada caso se arma sin la guarda (GC_OFF) hasta el punto de crear el commit; el paso final corre con la guarda (GC_ON)
// en Bash y en PowerShell. «HEAD igual» = el commit no ocurrió. CONTROL (Bash): el mismo paso final sin la guarda SÍ
// commitea (demuestra que lo detiene la guarda).
const SEQ = path.join(RAIZ, 'seq-edit.js');
fs.writeFileSync(SEQ, "const fs=require('fs');const f=process.argv[2];fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/^pick/m,'edit'));");
const ENV_SEC = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'node "' + p(SEQ) + '"' };
const Y = (sh) => (sh === 'bash' ? ' && ' : '; ');

function textoNiega(tool, command, cwd) {
  const r = spawnSync(process.execPath, [GUARDIA_GIT], { input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }), encoding: 'utf8', env: entorno(GC_ON) });
  if (!r.stdout.trim()) return false;
  try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny'; } catch { return false; }
}
// repo con a.txt en main y dos ramas k1/k2 que cambian a.txt (conflicto entre ellas)
function repoConflicto() {
  const repo = repoLimpio();
  escribir(repo, 'a.txt', 'base\n'); gitOk(repo, 'add', '-A'); gitOk(repo, 'commit', '-q', '-m', 'a');
  gitOk(repo, 'checkout', '-q', '-b', 'k1'); escribir(repo, 'a.txt', 'k1\n'); gitOk(repo, 'commit', '-qam', 'k1');
  gitOk(repo, 'checkout', '-q', '-b', 'k2', 'main'); escribir(repo, 'a.txt', 'k2\n'); gitOk(repo, 'commit', '-qam', 'k2');
  return repo;
}
const gitEnv = (repo, extra, ...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: entorno(GC_OFF, extra) });
const PARCHES = {}; // repo → ruta del parche de am
const NIEGA = [
  { n: 'node -e spawnSync(git commit --no-verify)', texto: true,
    prep: (r) => { escribir(r, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(r, 'add', '-f', '.env'); },
    cmd: () => `node -e "require('child_process').spawnSync('git',['commit','--no-verify','-m','x'],{stdio:'inherit'})"` },
  { n: 'node -e execFileSync(git commit --no-verify)', texto: true,
    prep: (r) => { escribir(r, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(r, 'add', '-f', '.env'); },
    cmd: () => `node -e "require('child_process').execFileSync('git',['commit','--no-verify','-m','x'],{stdio:'inherit'})"` },
  { n: 'alias git ci = commit --no-verify', textoArmar: 'git config alias.ci "commit --no-verify"',
    prep: (r) => { gitOk(r, 'config', 'alias.ci', 'commit --no-verify'); escribir(r, 'src/cfg.js', 'const k = "' + AKIA + '";\n'); gitOk(r, 'add', '-A'); },
    cmd: () => 'git ci -m x', esperado: 'src/cfg.js:1 (llave AWS)' },
  { n: 'rebase con conflicto + add -A + --continue', base: repoConflicto,
    prep: (r) => { gitEnv(r, ENV_SEC, 'rebase', 'k1'); escribir(r, 'a.txt', 'resuelto\n'); escribir(r, '.env', 'A=' + ENV_VALOR + '\n'); },
    cmd: (sh) => 'git add -A' + Y(sh) + 'git rebase --continue' },
  { n: 'rebase -i edit + add -A + --continue', base: repoConflicto,
    prep: (r) => { gitEnv(r, ENV_SEC, 'rebase', '-i', 'HEAD~1'); escribir(r, '.env', 'A=' + ENV_VALOR + '\n'); },
    cmd: (sh) => 'git add -A' + Y(sh) + 'git rebase --continue' },
  { n: 'am con conflicto + add -A + --continue', base: repoConflicto,
    prep: (r) => {
      const parche = path.join(RAIZ, 'p' + n++ + '.patch');
      fs.writeFileSync(parche, gitOk(r, 'format-patch', '-1', '--stdout', 'k1'));
      gitEnv(r, ENV_SEC, 'am', '-3', parche); escribir(r, 'a.txt', 'resuelto am\n'); escribir(r, '.env', 'A=' + ENV_VALOR + '\n');
    },
    cmd: (sh) => 'git add -A' + Y(sh) + 'git am --continue' },
  { n: 'cherry-pick con conflicto + .env + --continue', base: repoConflicto,
    prep: (r) => { gitEnv(r, ENV_SEC, 'cherry-pick', 'k1'); escribir(r, 'a.txt', 'resuelto cp\n'); escribir(r, '.env', 'A=' + ENV_VALOR + '\n'); },
    cmd: (sh) => 'git add -A' + Y(sh) + 'git cherry-pick --continue' },
  { n: 'merge cuya resolución agrega una llave', base: repoConflicto,
    prep: (r) => { gitEnv(r, ENV_SEC, 'merge', 'k1'); escribir(r, 'a.txt', 'resuelto\nconst k = "' + AKIA + '";\n'); },
    cmd: (sh) => 'git add -A' + Y(sh) + 'git commit --no-edit', esperado: 'a.txt:2 (llave AWS)' },
  { n: 'am (sin conflicto) de un parche que agrega .env', base: repoConflicto,
    prep: (r) => {
      gitOk(r, 'checkout', '-q', '-b', 'pe', 'main'); escribir(r, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(r, 'add', '-f', '.env'); gitOk(r, 'commit', '-qm', 'pe');
      const parche = path.join(RAIZ, 'p' + n++ + '.patch'); fs.writeFileSync(parche, gitOk(r, 'format-patch', '-1', '--stdout', 'pe'));
      gitOk(r, 'checkout', '-q', 'k2'); PARCHES[r] = parche;
    },
    cmd: (sh, r) => 'git am "' + p(PARCHES[r]) + '"' },
  { n: 'am de un parche con crédito de Claude en el mensaje', base: repoConflicto, esperado: 'prohíbe el crédito de Claude',
    prep: (r) => {
      gitOk(r, 'checkout', '-q', '-b', 'pc', 'main'); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', '-A');
      gitOk(r, 'commit', '-q', '-m', 'feat: n', '-m', 'Co-Authored-By: Claude <noreply@anthropic.com>');
      const parche = path.join(RAIZ, 'p' + n++ + '.patch'); fs.writeFileSync(parche, gitOk(r, 'format-patch', '-1', '--stdout', 'pc'));
      gitOk(r, 'checkout', '-q', 'k2'); PARCHES[r] = parche;
    },
    cmd: (sh, r) => 'git am "' + p(PARCHES[r]) + '"' },
  { n: 'am de un parche con AUTOR Claude', base: repoConflicto, esperado: 'autor del commit es Claude',
    prep: (r) => {
      gitOk(r, 'checkout', '-q', '-b', 'pa', 'main'); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', '-A');
      gitOk(r, 'commit', '-q', '-m', 'feat: n', '--author', 'Claude <noreply@anthropic.com>');
      const parche = path.join(RAIZ, 'p' + n++ + '.patch'); fs.writeFileSync(parche, gitOk(r, 'format-patch', '-1', '--stdout', 'pa'));
      gitOk(r, 'checkout', '-q', 'k2'); PARCHES[r] = parche;
    },
    cmd: (sh, r) => 'git am "' + p(PARCHES[r]) + '"' },
  { n: 'commit --author "Claude <noreply@anthropic.com>"', esperado: 'autor del commit es Claude',
    prep: (r) => { escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', '-A'); },
    cmd: () => 'git commit -m x --author "Claude <noreply@anthropic.com>"' },
  { n: 'commit con GIT_COMMITTER_NAME=Claude en el entorno', esperado: 'committer del commit es Claude', env: { GIT_COMMITTER_NAME: 'Claude' },
    prep: (r) => { escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', '-A'); },
    cmd: () => 'git commit -m x' },
  { n: 'revert --no-edit de un commit que QUITÓ el .env (lo vuelve a meter)',
    prep: (r) => {
      escribir(r, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(r, 'add', '-f', '.env'); gitOk(r, 'commit', '-qm', 'con env');
      gitOk(r, 'rm', '-q', '.env'); gitOk(r, 'commit', '-qm', 'quita env');
    },
    cmd: () => 'git revert --no-edit HEAD' },
  { n: 'config.txt UTF-16LE con BOM (como lo escribe PowerShell 5.1 con >) con una llave', esperado: 'config.txt:1 (llave AWS)',
    prep: (r) => {
      fs.writeFileSync(path.join(r, 'config.txt'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('const k = "' + AKIA + '"\r\n', 'utf16le')]));
      gitOk(r, 'add', 'config.txt');
    },
    cmd: () => 'git commit -m x' },
  { n: 'config.txt UTF-16LE escrito de verdad con > de PowerShell 5.1, con una llave', esperado: 'config.txt:1 (llave AWS)', soloWin: true,
    prep: (r) => {
      const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', `'const k = "${AKIA}"' > config.txt`], { cwd: r, encoding: 'utf8' });
      const b = fs.readFileSync(path.join(r, 'config.txt'));
      if (!(b[0] === 0xFF && b[1] === 0xFE)) throw new Error('PowerShell no escribió UTF-16LE con BOM: ' + b.subarray(0, 4).toString('hex') + ' ' + ps.stderr);
      gitOk(r, 'add', 'config.txt');
    },
    cmd: () => 'git commit -m x' },
  { n: 'archivo de texto marcado -diff en .gitattributes con una llave', esperado: 'secreto.txt:2 (llave AWS)',
    prep: (r) => { escribir(r, '.gitattributes', 'secreto.txt -diff\n'); escribir(r, 'secreto.txt', 'hola\nk=' + AKIA + '\n'); gitOk(r, 'add', '-A'); },
    cmd: () => 'git commit -m x' },
];
for (const c of NIEGA) {
  if (c.soloWin && !WIN) continue; // necesita PowerShell real
  for (const sh of SHELLS) {
    prueba(`[${sh}] B24 NO commitea: ${c.n}`, () => {
      const repo = (c.base || repoLimpio)();
      c.prep(repo);
      const a = head(repo);
      const r = ejecutar(sh, c.cmd(sh, repo), repo, GC_ON, { ...ENV_SEC, ...(c.env || {}) });
      chequear('B24 NO commitea', head(repo) === a && r.salida.includes('Guardia UAEH') && (!c.esperado || r.salida.includes(c.esperado)) &&
        !r.salida.includes(AKIA) && !r.salida.includes(ENV_VALOR), `HEAD ${a.slice(0, 7)} -> ${head(repo).slice(0, 7)} ${r.salida.slice(0, 400)}`);
      if (c.texto) chequear('B24 la capa de texto también lo niega', textoNiega(tool(sh), c.cmd(sh, repo), repo), '');
      if (c.textoArmar) chequear('B24 la capa de texto niega armarlo: ' + c.textoArmar, textoNiega(tool(sh), c.textoArmar, repo), '');
    });
  }
  prueba(`[bash] B24 CONTROL sin guarda SÍ commitea: ${c.n}`, () => {
    const r2 = (c.base || repoLimpio)();
    c.prep(r2);
    const a2 = head(r2);
    const s2 = ejecutar('bash', c.cmd('bash', r2), r2, GC_OFF, { ...ENV_SEC, ...(c.env || {}) });
    chequear('B24 CONTROL sin guarda SÍ commitea', head(r2) !== a2, s2.salida.slice(0, 300));
  });
}
// controles que deben PASAR (historial, merges ajenos, revert, crédito ajeno, firma local, binario real)
// (PNG y firma local sintéticos: PNG_MINIMO y HOOK_FIRMA_LOCAL, arriba)
const PASA = [
  { n: 'cherry-pick de un commit que YA tenía una llave de ejemplo (historial)', base: repoConflicto,
    prep: (r) => { gitOk(r, 'checkout', '-q', '-b', 'h', 'main'); escribir(r, 'src/cfg.js', 'const k = "' + AKIA + '";\n'); gitOk(r, 'add', '-A'); gitOk(r, 'commit', '-qm', 'h'); gitOk(r, 'checkout', '-q', 'k2'); },
    cmd: () => 'git cherry-pick h' },
  { n: 'rebase de commits que YA tenían una llave (historial)', base: repoConflicto,
    prep: (r) => {
      gitOk(r, 'checkout', '-q', '-b', 'h', 'main'); escribir(r, 'src/cfg.js', 'const k = "' + AKIA + '";\n'); gitOk(r, 'add', '-A'); gitOk(r, 'commit', '-qm', 'h1');
      escribir(r, '.env', 'A=1\n'); gitOk(r, 'add', '-f', '.env'); gitOk(r, 'commit', '-qm', 'h2');
    },
    cmd: () => 'git rebase k2' },
  { n: 'merge de una rama con fixtures/server.key ajena', base: repoConflicto,
    prep: (r) => { gitOk(r, 'checkout', '-q', '-b', 'fx', 'main'); escribir(r, 'fixtures/server.key', 'abc\n'); gitOk(r, 'add', '-A'); gitOk(r, 'commit', '-qm', 'fx'); gitOk(r, 'checkout', '-q', 'k2'); },
    cmd: () => 'git merge --no-ff -m "merge fx" fx' },
  { n: 'revert --no-edit de un commit normal', prep: (r) => { escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', '-A'); gitOk(r, 'commit', '-qm', 'n'); }, cmd: () => 'git revert --no-edit HEAD' },
  { n: 'cherry-pick de un commit con trailer de crédito (historial)', base: repoConflicto,
    prep: (r) => { gitOk(r, 'checkout', '-q', '-b', 'cr', 'main'); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', '-A'); gitOk(r, 'commit', '-q', '-m', 'feat: n', '-m', 'Co-Authored-By: Claude <noreply@anthropic.com>'); gitOk(r, 'checkout', '-q', 'k2'); },
    cmd: () => 'git cherry-pick cr' },
  { n: 'commit normal con el commit-msg LOCAL de firma (commit-msg local sintético)', firma: true,
    prep: (r) => { hookLocal(r, 'commit-msg', HOOK_FIRMA_LOCAL); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', '-A'); },
    cmd: () => 'git commit -m "feat: n" -m "Co-Authored-By: Claude <noreply@anthropic.com>"' },
  { n: 'imagen PNG real', prep: (r) => { fs.writeFileSync(path.join(r, 'img.png'), PNG_MINIMO); gitOk(r, 'add', 'img.png'); }, cmd: () => 'git commit -m "img"' },
];
for (const c of PASA) {
  for (const sh of SHELLS) {
    prueba(`[${sh}] B24 SÍ commitea: ${c.n}`, () => {
      const repo = (c.base || repoLimpio)();
      c.prep(repo);
      const a = head(repo);
      const r = ejecutar(sh, c.cmd(sh, repo), repo, GC_ON, ENV_SEC);
      let extra = true;
      if (c.firma) { const m = mensajeUltimo(repo); extra = /Authored By: test/.test(m) && !/Claude/i.test(m); }
      chequear('B24 SÍ commitea', head(repo) !== a && r.status === 0 && extra, r.salida.slice(0, 300));
    });
  }
}
pruebaSinBash("capa de texto con la guarda ACTIVA: HOME= y -c include.path junto a un commit → negados", () => {
  const repo = repoLimpio();
  for (const [tool, cmd] of [['Bash', 'HOME=/tmp/x git commit -m x'], ['PowerShell', '$env:HOME = "C:\\x"; git commit -m x'],
    ['Bash', 'git -c include.path=/x/otro.cfg commit -m x'], ['PowerShell', 'git -c include.path=C:/x/otro.cfg commit -m x'],
    ['Bash', 'wsl git commit -m x']]) {
    chequear(`[${tool}] B24 texto (guarda activa) niega: ${cmd}`, textoNiega(tool, cmd, repo), '');
  }
});

// ---------------------------------------------------------------- ciclo 7: C1 (am -n), C2 (crédito/autor en prepare-commit-msg),
// C4b (git replace), C4c (pre-applypatch local que saca un .env del índice). Commits REALES en Bash y PowerShell.
const CRED = 'Co-Authored-By: Claude <noreply@anthropic.com>';

const arbol = (repo) => git(repo, GC_OFF, 'ls-tree', '-r', '--name-only', 'HEAD').stdout;
// repo (base repoConflicto) en la rama k2 con un parche que agrega .env (rama pe)
function repoParcheEnv() {
  const r = repoConflicto();
  gitOk(r, 'checkout', '-q', '-b', 'pe', 'main'); escribir(r, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(r, 'add', '-f', '.env'); gitOk(r, 'commit', '-qm', 'pe');
  const parche = path.join(RAIZ, 'p' + n++ + '.patch'); fs.writeFileSync(parche, gitOk(r, 'format-patch', '-1', '--stdout', 'pe'));
  gitOk(r, 'checkout', '-q', 'k2');
  return { r, parche: p(parche) };
}
for (const sh of SHELLS) {
  prueba('[' + sh + '] C1: git am -n corrido directo (residual de la capa de git), la capa de texto lo niega, y git am sin -n queda en HEAD igual', () => { // C1: `git am -n` salta pre-applypatch y applypatch-msg → lo cierra la capa de TEXTO; la de git no puede (residual medido)
    const { r, parche } = repoParcheEnv();
    const cmd = 'git am -n "' + parche + '"';
    const a = head(r);
    const s = ejecutar(sh, cmd, r, GC_ON, ENV_SEC);
    chequear(`[${sh}] C1 RESIDUAL medido: \`git am -n\` corrido DIRECTO (sin la capa de texto) SÍ commitea el .env`, head(r) !== a && /\.env/.test(arbol(r)), s.salida.slice(0, 200));
    chequear(`[${sh}] C1 la capa de texto NIEGA ese mismo comando`, textoNiega(tool(sh), cmd, r), '');
    chequear(`[${sh}] C1 la capa de texto NIEGA git am -3n / -qn / --no-ver`, ['git am -3n "' + parche + '"', 'git am -qn "' + parche + '"', 'git am --no-ver "' + parche + '"'].every((c) => textoNiega(tool(sh), c, r)), '');
    const o = repoParcheEnv();
    const b = head(o.r);
    const s2 = ejecutar(sh, 'git am "' + o.parche + '"', o.r, GC_ON, ENV_SEC);
    chequear(`[${sh}] C1 git am SIN -n → HEAD igual`, head(o.r) === b && /\.env \(archivo sensible\)/.test(s2.salida), s2.salida.slice(0, 200));
  });
}

// C2: un `git commit -n` que la capa de texto no ve (script en archivo) ya no commitea crédito ni autor Claude
function guion(repo, sh, linea) {
  if (sh === 'bash') { fs.writeFileSync(path.join(repo, 'hacer.sh'), '#!/bin/sh\n' + linea + '\n'); return 'bash hacer.sh'; }
  fs.writeFileSync(path.join(repo, 'hacer.ps1'), linea + '\r\n');
  return 'powershell -NoProfile -ExecutionPolicy Bypass -File hacer.ps1';
}
const NIEGA_C2 = [
  { n: 'script en archivo: git commit -n -m x -m "<crédito>"', esperado: 'prohíbe el crédito de Claude', linea: 'git commit -n -m x -m "' + CRED + '"' },
  { n: 'script en archivo: git commit -n --author "Claude <noreply@anthropic.com>"', esperado: 'autor del commit es Claude', linea: 'git commit -n -m x --author "Claude <noreply@anthropic.com>"' },
  { n: 'script en archivo: git commit -n -F <mensaje con crédito>', esperado: 'prohíbe el crédito de Claude', linea: 'git commit -n -F msg.txt',
    prep: (r) => fs.writeFileSync(path.join(r, 'msg.txt'), 'feat: x\n\nClaude-Session: https://claude.ai/code/session_x\n') },
  { n: 'script: git commit -n con crédito y un commit-msg LOCAL que NO lo quita', esperado: 'prohíbe el crédito de Claude', linea: 'git commit -n -m x -m "' + CRED + '"',
    prep: (r) => hookLocal(r, 'commit-msg', '#!/bin/sh\nexit 0\n') },
];
for (const c of NIEGA_C2) {
  for (const sh of SHELLS) {
    prueba(`[${sh}] C2 NO commitea: ${c.n}`, () => {
      const r = repoLimpio(); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', 'n.txt'); if (c.prep) c.prep(r);
      const a = head(r);
      const s = ejecutar(sh, guion(r, sh, c.linea), r, GC_ON);
      chequear('C2 NO commitea', head(r) === a && s.salida.includes(c.esperado), s.salida.slice(0, 300));
    });
  }
  prueba(`[bash] C2 CONTROL sin guarda SÍ commitea: ${c.n}`, () => {
    const r2 = repoLimpio(); escribir(r2, 'n.txt', 'n\n'); gitOk(r2, 'add', 'n.txt'); if (c.prep) c.prep(r2);
    const a2 = head(r2);
    ejecutar('bash', guion(r2, 'bash', c.linea), r2, GC_OFF);
    chequear('C2 CONTROL sin guarda SÍ commitea', head(r2) !== a2, '');
  });
}
// C2: controles que PASAN (mensaje de historial: $2 = commit / squash, o archivo de origen) y la firma local
function ramaConCredito(r, rama, desde) {
  gitOk(r, 'checkout', '-q', '-b', rama, desde || 'main');
  escribir(r, rama + '1.txt', '1\n'); gitOk(r, 'add', '-A'); gitOk(r, 'commit', '-q', '-m', 'feat: 1', '-m', CRED);
  escribir(r, rama + '2.txt', '2\n'); gitOk(r, 'add', '-A'); gitOk(r, 'commit', '-q', '-m', 'feat: 2', '-m', CRED);
}
const PASA_C2 = [
  { n: 'cherry-pick de un commit con crédito histórico', base: repoConflicto, prep: (r) => { ramaConCredito(r, 'cr'); gitOk(r, 'checkout', '-q', 'k2'); }, cmd: () => 'git cherry-pick cr' },
  { n: 'rebase de dos commits con crédito histórico', base: repoConflicto, prep: (r) => ramaConCredito(r, 'cr'), cmd: () => 'git rebase k2' },
  { n: 'commit --amend --no-edit -n de un commit con crédito histórico ($2 = commit)', prep: (r) => { ramaConCredito(r, 'cr'); escribir(r, 'z.txt', 'z\n'); gitOk(r, 'add', 'z.txt'); }, cmd: () => 'git commit --amend --no-edit -n' },
  { n: 'merge --squash + commit -n --no-edit de una rama con crédito histórico ($2 = squash)', base: repoConflicto, marca2: 'squash',
    prep: (r) => { ramaConCredito(r, 'cr'); gitOk(r, 'checkout', '-q', 'k2'); gitEnv(r, {}, 'merge', '--squash', 'cr'); }, cmd: () => 'git commit -n --no-edit' },
  { n: 'commit -n con crédito y el commit-msg local de firma: el crédito se quita (el local lo quitaría)', firma: true, sinCredito: true,
    prep: (r) => { hookLocal(r, 'commit-msg', HOOK_FIRMA_LOCAL); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', '-A'); },
    cmd: () => 'git commit -n -m "feat: n" -m "' + CRED + '"' },
  { n: 'commit normal (sin -n) con el commit-msg local de firma: firmado y sin crédito', firma: true, sinCredito: true, firmado: true,
    prep: (r) => { hookLocal(r, 'commit-msg', HOOK_FIRMA_LOCAL); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', '-A'); },
    cmd: () => 'git commit -m "feat: n" -m "' + CRED + '"' },
];
for (const c of PASA_C2) {
  for (const sh of SHELLS) {
    prueba(`[${sh}] C2 SÍ commitea: ${c.n}`, () => {
      const r = (c.base || repoLimpio)();
      c.prep(r);
      if (c.marca2) hookLocal(r, 'prepare-commit-msg', '#!/bin/sh\necho "$2" > "$(git rev-parse --git-dir)/marca-2"\nexit 0\n');
      const a = head(r);
      const s = ejecutar(sh, c.cmd(), r, GC_ON, ENV_SEC);
      const m = mensajeUltimo(r);
      let extra = true;
      if (c.sinCredito) extra = !/Claude/i.test(m);
      if (c.firmado) extra = extra && /Authored By: test/.test(m);
      if (c.marca2) extra = fs.existsSync(path.join(r, '.git', 'marca-2')) && fs.readFileSync(path.join(r, '.git', 'marca-2'), 'utf8').trim() === c.marca2;
      chequear('C2 SÍ commitea', head(r) !== a && s.status === 0 && extra, s.salida.slice(0, 300) + ' | ' + m.slice(0, 200));
    });
  }
}
prueba("C2 medición: --amend --no-edit (sin -n) de un commit con crédito → commit-msg lo niega (conducta de c6)", () => {
  // --amend --no-edit y del squash: el crédito histórico copiado a un commit NUEVO se niega ahí.
  const r = repoLimpio(); ramaConCredito(r, 'cr');
  const a = head(r);
  const s = ejecutar('bash', 'git commit --amend --no-edit', r, GC_ON);
  chequear('C2 medición: --amend --no-edit (sin -n) de un commit con crédito → commit-msg lo niega (conducta de c6)', head(r) === a && /prohíbe el crédito de Claude/.test(s.salida), s.salida.slice(0, 200));
});

// C4b (uae-security c6 SEC-005): `git replace HEAD <commit con .env>` no oculta el .env nuevo (GIT_NO_REPLACE_OBJECTS)
for (const sh of SHELLS) {
  const prep = () => {
    const r = repoLimpio();
    gitOk(r, 'checkout', '-q', '-b', 'falso'); escribir(r, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(r, 'add', '-f', '.env'); gitOk(r, 'commit', '-qm', 'falso');
    gitOk(r, 'checkout', '-q', 'main'); gitOk(r, 'replace', 'main', 'falso');
    escribir(r, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(r, 'add', '-f', '.env');
    // con solo el .env git diría «nada que commitear» (compara con el HEAD reemplazado): se agrega otro archivo
    escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', 'n.txt');
    return r;
  };
  const sinReemplazo = (r) => git(r, GC_OFF, '--no-replace-objects', 'rev-parse', 'HEAD').stdout.trim();
  prueba(`[${sh}] C4b git replace HEAD <commit con .env> + .env stageado → NO commitea`, () => {
    const r = prep();
    const a = sinReemplazo(r);
    const s = ejecutar(sh, 'git commit -m x', r, GC_ON);
    chequear('C4b NO commitea', sinReemplazo(r) === a && /\.env \(archivo sensible\)/.test(s.salida), s.salida.slice(0, 200));
  });
  if (sh === 'bash') {
    prueba('[bash] C4b CONTROL sin guarda SÍ commitea', () => {
      const r2 = prep();
      const a2 = sinReemplazo(r2);
      ejecutar(sh, 'git commit -m x', r2, GC_OFF);
      chequear('C4b CONTROL sin guarda SÍ commitea', sinReemplazo(r2) !== a2, '');
    });
  }
}

// C4c (uae-security c6 SEC-004): pre-applypatch LOCAL que hace `git rm --cached .env` → la revisión de ANTES lo ve
for (const sh of SHELLS) {
  const prep = () => {
    const o = repoParcheEnv();
    hookLocal(o.r, 'pre-applypatch', '#!/bin/sh\ngit rm -q --cached .env\nexit 0\n');
    return o;
  };
  prueba(`[${sh}] C4c pre-applypatch LOCAL con rm --cached .env → NO commitea`, () => {
    const o = prep();
    const a = head(o.r);
    const s = ejecutar(sh, 'git am "' + o.parche + '"', o.r, GC_ON, ENV_SEC);
    chequear('C4c NO commitea', head(o.r) === a && /\.env \(archivo sensible\)/.test(s.salida), s.salida.slice(0, 300));
  });
  if (sh === 'bash') {
    prueba('[bash] C4c CONTROL (medición): sin la guarda ese hook local NO evita que el .env entre al commit', () => {
      const o2 = prep();
      const a2 = head(o2.r);
      ejecutar(sh, 'git am "' + o2.parche + '"', o2.r, GC_OFF, ENV_SEC);
      chequear('C4c CONTROL', head(o2.r) !== a2 && /\.env/.test(arbol(o2.r)), arbol(o2.r));
    });
  }
}
pruebaSinBash("C4c: el despachador pre-applypatch revisa ANTES y DESPUÉS del hook local", () => {
  const t = fs.readFileSync(path.join(HOOKS_GLOBAL, 'pre-applypatch'), 'utf8');
  const i = t.indexOf('"$l" "$@"');
  chequear('C4c pre-applypatch: revisión del contenido antes Y después del local', i > 0 && t.lastIndexOf('guardia-commit.cjs" contenido', i) > 0 && t.indexOf('guardia-commit.cjs" contenido', i) > i, '');
});

// ---------------------------------------------------------------- tiempo de un commit normal
prueba('un commit normal con la guarda activa no se alarga de forma notable', (t) => {
  const medir = (gc) => {
    const repo = repoLimpio();
    const ts = [];
    for (let i = 0; i < 7; i++) {
      escribir(repo, 'f' + i + '.txt', 'contenido ' + i + '\n');
      gitOk(repo, 'add', '-A');
      const r = ejecutar('bash', 'git commit -q -m c' + i, repo, gc);
      if (r.status !== 0) throw new Error('commit normal falló: ' + r.salida);
      ts.push(r.ms);
    }
    ts.sort((a, b) => a - b);
    return ts[3];
  };
  const on = medir(GC_ON), off = medir(GC_OFF);
  t.diagnostic(`commit normal (mediana de 7, ms, incluye arrancar bash): con guarda = ${on.toFixed(0)} | sin guarda = ${off.toFixed(0)} | costo = ${(on - off).toFixed(0)}`);
  // Los márgenes son holgados a propósito (un corredor de CI compartido es lento y ruidoso); un costo de varios segundos por
  // commit sí lo detectan. En una máquina normal el costo medido es de unas décimas de segundo.
  chequear('un commit normal con la guarda activa tarda < 3 s de más', on - off < 3000, `costo ${(on - off).toFixed(0)} ms`);
  chequear('un commit normal con la guarda activa tarda < 6 s EN TOTAL (Codex c5 SEC-007)', on < 6000, `con guarda ${on.toFixed(0)} ms`);
});

// ---------------------------------------------------------------- política de commits POR DEFECTO (permitir)
// Sin commits.credito = prohibir, la identidad y el crédito de Claude NO se revisan; secretos, archivos sensibles y
// evidencias del navegador se revisan SIEMPRE. (Todo lo de arriba corre con commits.credito = prohibir.)
const PERMITIR = 'permitir';
const CLAUDE_AUTOR = 'Claude <noreply@anthropic.com>';
prueba('[política permitir] commit con el crédito de Claude en el mensaje: commitea y el crédito queda', () => {
  const r = repoLimpio(); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', 'n.txt');
  const a = head(r);
  const s = ejecutar('bash', 'git commit -m "feat: n" -m "' + CRED + '"', r, GC_ON, undefined, PERMITIR);
  chequear('commitea', head(r) !== a && s.status === 0, s.salida.slice(0, 300));
  chequear('el crédito queda en el mensaje', mensajeUltimo(r).includes(CRED), mensajeUltimo(r));
});
prueba('[política permitir] crédito por -F - (entrada estándar) y Claude-Session: commitea', () => {
  const r = repoLimpio(); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', 'n.txt');
  const a = head(r);
  const s = ejecutar('bash', 'git commit -F - <<< "feat: y\n\nClaude-Session: https://x"', r, GC_ON, undefined, PERMITIR);
  chequear('commitea', head(r) !== a && s.status === 0, s.salida.slice(0, 300));
});
prueba('[política permitir] commit --author "Claude <noreply@anthropic.com>": commitea con ese autor', () => {
  const r = repoLimpio(); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', 'n.txt');
  const a = head(r);
  const s = ejecutar('bash', 'git commit -m x --author "' + CLAUDE_AUTOR + '"', r, GC_ON, undefined, PERMITIR);
  chequear('commitea', head(r) !== a && s.status === 0, s.salida.slice(0, 300));
  chequear('el autor es Claude', git(r, GC_OFF, 'log', '-1', '--format=%an <%ae>').stdout.trim() === CLAUDE_AUTOR, '');
});
prueba('[política permitir] GIT_COMMITTER_NAME=Claude en el entorno: commitea con ese committer', () => {
  const r = repoLimpio(); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', 'n.txt');
  const a = head(r);
  const s = ejecutar('bash', 'git commit -m x', r, GC_ON, { GIT_COMMITTER_NAME: 'Claude' }, PERMITIR);
  chequear('commitea', head(r) !== a && s.status === 0, s.salida.slice(0, 300));
  chequear('el committer es Claude', git(r, GC_OFF, 'log', '-1', '--format=%cn').stdout.trim() === 'Claude', '');
});
prueba('[política permitir] script con git commit -n y crédito (la capa de texto no lo ve): commitea', () => {
  const r = repoLimpio(); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', 'n.txt');
  const a = head(r);
  const s = ejecutar('bash', guion(r, 'bash', 'git commit -n -m x -m "' + CRED + '"'), r, GC_ON, undefined, PERMITIR);
  chequear('commitea', head(r) !== a && s.status === 0, s.salida.slice(0, 300));
});
prueba('[política permitir] git am de un parche con AUTOR Claude y crédito en el mensaje: se aplica', () => {
  const r = repoConflicto();
  gitOk(r, 'checkout', '-q', '-b', 'pa', 'main'); escribir(r, 'n.txt', 'n\n'); gitOk(r, 'add', '-A');
  gitOk(r, 'commit', '-q', '-m', 'feat: n', '-m', CRED, '--author', CLAUDE_AUTOR);
  const parche = path.join(RAIZ, 'p' + n++ + '.patch'); fs.writeFileSync(parche, gitOk(r, 'format-patch', '-1', '--stdout', 'pa'));
  gitOk(r, 'checkout', '-q', 'k2');
  const a = head(r);
  const s = ejecutar('bash', 'git am "' + p(parche) + '"', r, GC_ON, ENV_SEC, PERMITIR);
  chequear('se aplica', head(r) !== a && s.status === 0, s.salida.slice(0, 300));
});
prueba('[política permitir] commit --amend --no-edit de un commit con crédito (sin -n): commitea (con prohibir lo niega commit-msg)', () => {
  const r = repoLimpio(); ramaConCredito(r, 'cr');
  const a = head(r);
  // fecha de committer distinta: sin ella, un amend en el mismo segundo que el commit original da el MISMO hash
  const s = ejecutar('bash', 'git commit --amend --no-edit', r, GC_ON, { GIT_COMMITTER_DATE: '2030-01-02T03:04:05Z' }, PERMITIR);
  chequear('commitea', head(r) !== a && s.status === 0, s.salida.slice(0, 300));
  chequear('el crédito sigue en el mensaje', mensajeUltimo(r).includes(CRED), mensajeUltimo(r));
});
// lo que NO depende de la política: secretos, .env y evidencias, también con la política por defecto
prueba('[política permitir] .env stageado: NO commitea (con y sin -n) y no imprime el valor', () => {
  const r = repoLimpio(); escribir(r, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(r, 'add', '-f', '.env');
  const a = head(r);
  const s = ejecutar('bash', 'git commit -m x', r, GC_ON, undefined, PERMITIR);
  chequear('NO commitea', head(r) === a && /\.env \(archivo sensible\)/.test(s.salida) && !s.salida.includes(ENV_VALOR), s.salida.slice(0, 300));
  const s2 = ejecutar('bash', guion(r, 'bash', 'git commit -n -m x'), r, GC_ON, undefined, PERMITIR);
  chequear('con -n (script) tampoco commitea', head(r) === a && /\.env \(archivo sensible\)/.test(s2.salida), s2.salida.slice(0, 300));
});
prueba('[política permitir] llave en una línea añadida: NO commitea y no imprime el valor', () => {
  const r = repoLimpio(); escribir(r, 'src/cfg.js', 'const k = "' + AKIA + '";\n'); gitOk(r, 'add', '-A');
  const a = head(r);
  const s = ejecutar('bash', 'git commit -m x', r, GC_ON, undefined, PERMITIR);
  chequear('NO commitea', head(r) === a && /src\/cfg\.js:1 \(llave AWS\)/.test(s.salida) && !s.salida.includes(AKIA), s.salida.slice(0, 300));
});
prueba('[política permitir] evidencia del navegador: NO commitea', () => {
  const r = repoLimpio(); escribir(r, '.playwright-cli/page-1.yml', 'x\n'); gitOk(r, 'add', '-f', '.playwright-cli/page-1.yml');
  const a = head(r);
  const s = ejecutar('bash', 'git commit -m x', r, GC_ON, undefined, PERMITIR);
  chequear('NO commitea', head(r) === a && /evidencias del navegador/.test(s.salida), s.salida.slice(0, 300));
});
// los modos de guardia-commit.cjs, directos (sin shell): cada revisión de identidad/crédito depende de la política
pruebaSinBash('[modos directos] commit-msg con crédito: sale 1 con prohibir (y nombra la firma) y 0 con permitir', () => {
  const repo = repoLimpio();
  const msg = path.join(RAIZ, 'msg-' + n++ + '.txt');
  fs.writeFileSync(msg, 'feat: x\n\n' + CRED + '\n');
  const c = guardiaDirecto('commit-msg', [msg], { cwd: repo });
  chequear('prohibir: sale 1 y pide quitar el crédito', c.status === 1 && /prohíbe el crédito de Claude/.test(c.stderr), `${c.status} ${c.stderr}`);
  chequear('prohibir: nombra la firma configurada', c.stderr.includes(FIRMA), c.stderr);
  const s = guardiaDirecto('commit-msg', [msg], { cwd: repo, politica: PERMITIR });
  chequear('permitir: sale 0 sin decir nada', s.status === 0 && s.stderr === '', `${s.status} ${s.stderr}`);
});
pruebaSinBash('[modos directos] contenido: committer Claude → 1 con prohibir, 0 con permitir', () => {
  const repo = repoLimpio(); escribir(repo, 'n.txt', 'n\n'); gitOk(repo, 'add', 'n.txt');
  const extra = { GIT_COMMITTER_NAME: 'Claude' };
  const c = guardiaDirecto('contenido', [], { cwd: repo, extra });
  chequear('prohibir: sale 1 y dice que el committer es Claude', c.status === 1 && /committer del commit es Claude/.test(c.stderr), `${c.status} ${c.stderr}`);
  const s = guardiaDirecto('contenido', [], { cwd: repo, extra, politica: PERMITIR });
  chequear('permitir: sale 0', s.status === 0, `${s.status} ${s.stderr}`);
});
pruebaSinBash('[modos directos] contenido <mensaje> message: crédito → 3 (prohibir) / 0 (permitir); autor Claude → 1 / 0', () => {
  const repo = repoLimpio(); escribir(repo, 'n.txt', 'n\n'); gitOk(repo, 'add', 'n.txt');
  const msg = path.join(RAIZ, 'msg-' + n++ + '.txt');
  fs.writeFileSync(msg, 'feat: x\n\n' + CRED + '\n');
  const c = guardiaDirecto('contenido', [msg, 'message'], { cwd: repo });
  chequear('prohibir: el crédito sale con 3 (el despachador prueba el commit-msg local)', c.status === 3, `${c.status} ${c.stderr}`);
  const s = guardiaDirecto('contenido', [msg, 'message'], { cwd: repo, politica: PERMITIR });
  chequear('permitir: sale 0', s.status === 0, `${s.status} ${s.stderr}`);
  fs.writeFileSync(msg, 'feat: x\n');
  const extra = { GIT_AUTHOR_NAME: 'Claude', GIT_AUTHOR_EMAIL: 'noreply@anthropic.com' };
  const a = guardiaDirecto('contenido', [msg, 'message'], { cwd: repo, extra });
  chequear('prohibir: el autor Claude sale con 1', a.status === 1 && /autor del commit es Claude/.test(a.stderr), `${a.status} ${a.stderr}`);
  const b = guardiaDirecto('contenido', [msg, 'message'], { cwd: repo, extra, politica: PERMITIR });
  chequear('permitir: el autor Claude pasa (0)', b.status === 0, `${b.status} ${b.stderr}`);
});
pruebaSinBash('[modos directos] contenido con .env stageado: sale 1 con las dos políticas', () => {
  const repo = repoLimpio(); escribir(repo, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(repo, 'add', '-f', '.env');
  for (const politica of ['prohibir', PERMITIR]) {
    const c = guardiaDirecto('contenido', [], { cwd: repo, politica });
    chequear(`${politica}: sale 1 por el .env`, c.status === 1 && /\.env \(archivo sensible\)/.test(c.stderr) && !c.stderr.includes(ENV_VALOR), `${c.status} ${c.stderr}`);
  }
});
pruebaSinBash('[modos directos] applypatch-msg: crédito → 1 con prohibir; con permitir sale 0 aunque no haya parche en curso', () => {
  const repo = repoLimpio();
  const msg = path.join(RAIZ, 'msg-' + n++ + '.txt');
  fs.writeFileSync(msg, 'feat: x\n\n' + CRED + '\n');
  const c = guardiaDirecto('applypatch-msg', [msg], { cwd: repo });
  chequear('prohibir: sale 1 por el crédito', c.status === 1 && /prohíbe el crédito de Claude/.test(c.stderr), `${c.status} ${c.stderr}`);
  const s = guardiaDirecto('applypatch-msg', [msg], { cwd: repo, politica: PERMITIR });
  chequear('permitir: sale 0 (no consulta el author-script)', s.status === 0, `${s.status} ${s.stderr}`);
});
pruebaSinBash('[modos directos] credito-local: quita el crédito del mensaje real solo con prohibir', () => {
  const repo = repoLimpio();
  const credito = 'feat: x\n\n' + CRED + '\n';
  const real = path.join(RAIZ, 'real-' + n++ + '.txt');
  const simulado = path.join(RAIZ, 'simulado-' + n++ + '.txt');
  fs.writeFileSync(simulado, 'feat: x\n'); // lo que quedaría tras correr el commit-msg local (sin crédito)
  fs.writeFileSync(real, credito);
  const c = guardiaDirecto('credito-local', [real, simulado], { cwd: repo });
  chequear('prohibir: sale 0 y quita el crédito del mensaje real', c.status === 0 && !/Claude/i.test(fs.readFileSync(real, 'utf8')), `${c.status} ${c.stderr}`);
  fs.writeFileSync(real, credito);
  const s = guardiaDirecto('credito-local', [real, simulado], { cwd: repo, politica: PERMITIR });
  chequear('permitir: sale 0 y no toca el mensaje', s.status === 0 && fs.readFileSync(real, 'utf8') === credito, `${s.status} ${s.stderr}`);
  fs.writeFileSync(simulado, credito); // el commit-msg local NO quita el crédito
  const n3 = guardiaDirecto('credito-local', [real, simulado], { cwd: repo });
  chequear('prohibir: si el local no lo quita, sale 1', n3.status === 1 && /prohíbe el crédito de Claude/.test(n3.stderr), `${n3.status} ${n3.stderr}`);
});
// de dónde sale la política: uaeh.config.json, las variables UAEH_COMMIT_* mandan, un archivo roto cae a permitir, y sin
// scripts/lib/config.cjs (copia suelta del par de hooks) la política es permitir aunque el entorno diga lo contrario
pruebaSinBash('[modos directos] la política sale de uaeh.config.json; la variable manda; un archivo roto cae a permitir', () => {
  const c = entornoTemporal('uaeh-guardia-commit-cfg-');
  try {
    const repo = repoLimpio();
    const msg = path.join(c.dir, 'msg.txt');
    fs.writeFileSync(msg, 'feat: x\n\n' + CRED + '\n');
    const correrCon = (extra) => {
      const env = { ...entorno(GC_ON, undefined, PERMITIR), UAEH_HOME: c.uaehHome, CLAUDE_CONFIG_DIR: c.claudeHome, ...extra };
      return spawnSync(process.execPath, [GUARDIA, 'commit-msg', msg], { cwd: repo, encoding: 'utf8', env, timeout: 60000 });
    };
    chequear('sin archivo ni variables: permitir (0)', correrCon().status === 0, '');
    c.escribir(path.join(c.uaehHome, 'uaeh.config.json'), JSON.stringify({ version: 1, commits: { credito: 'prohibir', firma: 'Firmado: el equipo' } }));
    const r = correrCon();
    chequear('el archivo dice prohibir: sale 1 y nombra su firma', r.status === 1 && r.stderr.includes('«Firmado: el equipo»'), `${r.status} ${r.stderr}`);
    chequear('la variable UAEH_COMMIT_CREDITO=permitir manda sobre el archivo', correrCon({ UAEH_COMMIT_CREDITO: 'permitir' }).status === 0, '');
    c.escribir(path.join(c.uaehHome, 'uaeh.config.json'), '{ esto no es JSON');
    chequear('un archivo roto cae a permitir (0)', correrCon().status === 0, '');
  } finally { c.limpiar(); }
});
pruebaSinBash('[modos directos] sin scripts/lib/config.cjs la política es permitir (aunque el entorno diga prohibir); el .env sigue negado', () => {
  const carpeta = path.join(RAIZ, 'sin-lib-' + n++, 'hooks'); // sin ../scripts/lib/config.cjs al lado
  fs.mkdirSync(carpeta, { recursive: true });
  fs.copyFileSync(GUARDIA, path.join(carpeta, 'guardia-commit.cjs'));
  fs.copyFileSync(GUARDIA_GIT, path.join(carpeta, 'guardia-git.js'));
  const copia = path.join(carpeta, 'guardia-commit.cjs');
  const repo = repoLimpio();
  const msg = path.join(RAIZ, 'msg-' + n++ + '.txt');
  fs.writeFileSync(msg, 'feat: x\n\n' + CRED + '\n');
  const c = guardiaDirecto('commit-msg', [msg], { cwd: repo, script: copia }); // el entorno trae UAEH_COMMIT_CREDITO=prohibir
  chequear('el crédito pasa (0): sin la biblioteca no se lee la política', c.status === 0, `${c.status} ${c.stderr}`);
  escribir(repo, '.env', 'A=' + ENV_VALOR + '\n'); gitOk(repo, 'add', '-f', '.env');
  const s = guardiaDirecto('contenido', [], { cwd: repo, script: copia });
  chequear('el .env sigue negado (1)', s.status === 1 && /\.env \(archivo sensible\)/.test(s.stderr), `${s.status} ${s.stderr}`);
});
