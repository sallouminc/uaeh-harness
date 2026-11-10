// Pruebas de plugins/uaeh-harness/hooks/solo-navegador.js — la lista BLANCA del verificador de navegador.
//
// Corren el hook de verdad (un proceso por caso, con el JSON por stdin como lo manda Claude Code) dentro de una casa
// temporal: nunca leen la configuración real. Los casos de las tablas vienen del candado original (rondas 1-4 de
// auditoría) y corren como agente «browser-verifier». Además se prueba: la compuerta por identidad (sesión principal,
// agentes no listados, prefijo del plugin, piezas ausentes), la configuración de confianza calculada (plantilla del
// plugin o UAEH_HOME, con espacios y acentos), la paridad del tokenizador con un bash real y que, con los hooks de
// hooks.json encadenados, el verificador de navegador ya no puede interactuar con la página.
// Correr: node --test tests/harness/solo-navegador.test.cjs
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { RAIZ_HARNESS, entornoTemporal, eventoHerramienta, requiereBash } = require('../helpers/entorno.cjs');

const HOOK = path.join(RAIZ_HARNESS, 'hooks', 'solo-navegador.js');
const LECTURA = path.join(RAIZ_HARNESS, 'hooks', 'solo-lectura.js');
const AGENTE = 'browser-verifier';
const WIN = process.platform === 'win32';

function nuevoEntorno(prefijo) {
  const e = entornoTemporal(prefijo);
  // si el desarrollador los tiene exportados, la prueba no sería hermética
  for (const k of Object.keys(e.env)) if (/^(PLAYWRIGHT_MCP_|PWTEST_CLI_GLOBAL_CONFIG$|UAEH_WSL_)/i.test(k)) delete e.env[k];
  return e;
}

// Casa compartida por los casos de las tablas: el hook no escribe nada, con una basta.
const E = nuevoEntorno('uaeh-solo-navegador-');
process.on('exit', () => E.limpiar());

const aBarra = (p) => p.replace(/\\/g, '/');
// Configuración de confianza de la casa temporal (UAEH_HOME) y la plantilla del plugin, con «/» como las escribe el agente.
const CFG = aBarra(path.join(E.uaehHome, 'playwright-cli.config.json'));
const CFG_PLUGIN = aBarra(path.join(RAIZ_HARNESS, 'templates', 'playwright-cli.config.json'));
const SHOT = 'reports/visual-audit/20261015-1200/home-360.png';
const S4 = '-s=uaeh-ensayo-visual-20261015';

// Ronda 4 (R3-1): todo comando de playwright-cli (salvo --help/--version) lleva sesión uaeh-…; se inyecta de forma mecánica
// en los casos que no la traen, para que sigan probando su motivo original.
const ses = (cmd) => (/^playwright-cli (?!-s=|--session|--help|--version)/.test(cmd) ? cmd.replace('playwright-cli ', `playwright-cli ${S4} `) : cmd);

// ── Ejecutar el hook ──────────────────────────────────────────────────────────────────

function resultado(status, stdout, stderr) {
  let json = null;
  try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch { json = null; }
  const salida = json && json.hookSpecificOutput;
  return {
    status, stdout, stderr, json,
    deny: !!salida && salida.permissionDecision === 'deny',
    motivo: (salida && salida.permissionDecisionReason) || '',
  };
}

// Una ejecución del hook con `entrada` (objeto → JSON) o con `crudo` (texto tal cual por stdin). Devuelve una promesa.
function ejecutarUna(entrada, { crudo, env = E.env, hook = HOOK } = {}) {
  return new Promise((resolver, rechazar) => {
    const hijo = spawn(process.execPath, [hook], { env, cwd: E.proyecto, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    hijo.stdout.setEncoding('utf8');
    hijo.stderr.setEncoding('utf8');
    hijo.stdout.on('data', (d) => { stdout += d; });
    hijo.stderr.on('data', (d) => { stderr += d; });
    const reloj = setTimeout(() => { hijo.kill(); rechazar(new Error('el hook no terminó en 45 s')); }, 45000);
    hijo.on('error', (e) => { clearTimeout(reloj); rechazar(e); });
    hijo.on('close', (status, senal) => { clearTimeout(reloj); resolver({ ...resultado(status, stdout, stderr), senal }); });
    hijo.stdin.on('error', () => { /* el hook puede salir antes de leer todo stdin */ });
    hijo.stdin.end(crudo !== undefined ? crudo : JSON.stringify(entrada));
  });
}

// El hook SIEMPRE sale con código 0. Un código distinto, una señal o un error al arrancar son fallos del entorno (el
// sistema mata procesos cortos bajo carga…) y no una decisión del candado: se reintenta hasta 3 veces.
async function ejecutar(entrada, opciones = {}) {
  let ultimo = null;
  for (let intento = 1; intento <= 3; intento++) {
    try { ultimo = await ejecutarUna(entrada, opciones); } catch (e) { ultimo = { error: e, status: null }; }
    if (!ultimo.error && ultimo.status === 0) return ultimo;
  }
  if (ultimo.error) throw ultimo.error;
  return ultimo;
}

// Corre `cmd` como `agente` (por defecto browser-verifier) con la sesión uaeh-… inyectada (salvo `sinSesion`).
function correr(cmd, { tool = 'Bash', agente = AGENTE, sinSesion = false, cwd = E.proyecto, env, hook } = {}) {
  const comando = typeof cmd === 'string' && !sinSesion ? ses(cmd) : cmd;
  return ejecutar(eventoHerramienta(comando, { tool, agente, cwd }), { env, hook });
}

const CONCURRENCIA = Math.max(2, Math.min(8, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length));

async function enParalelo(elementos, fn) {
  const salida = new Array(elementos.length);
  let siguiente = 0;
  async function trabajador() {
    for (;;) {
      const i = siguiente++;
      if (i >= elementos.length) return;
      salida[i] = await fn(elementos[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, elementos.length) }, trabajador));
  return salida;
}

// casos: [{ cmd, esperado: 'A'|'D', motivo?: RegExp, ...opciones de correr }]. Devuelve la lista de fallos redactados.
async function fallosDe(casos) {
  const filas = await enParalelo(casos, async (c) => {
    const r = await correr(c.cmd, c);
    const negado = c.esperado === 'D';
    let bien = r.status === 0 && r.deny === negado;
    if (bien && !negado) bien = r.stdout === '';
    if (bien && c.motivo) bien = c.motivo.test(r.motivo);
    return bien ? null : `[${c.tool || 'Bash'}${c.sinSesion ? ', sin sesión inyectada' : ''}] esperaba ${negado ? 'NEGAR' : 'PERMITIR'}: ${JSON.stringify(c.cmd)} → ${r.deny ? `negó (${r.motivo.slice(0, 160)})` : 'permitió'} (código ${r.status})`;
  });
  return filas.filter(Boolean);
}

async function exigir(casos) {
  const f = await fallosDe(casos);
  assert.equal(f.length, 0, `${f.length} de ${casos.length} casos fallaron:\n  ${f.slice(0, 25).join('\n  ')}`);
}
const permitidos = (cmds, o = {}) => cmds.map((cmd) => ({ cmd, esperado: 'A', ...o }));
const negados = (cmds, o = {}) => cmds.map((cmd) => ({ cmd, esperado: 'D', ...o }));

// ── Tablas del candado original ───────────────────────────────────────────────────────

const A0 = [
  `playwright-cli open http://localhost:3000 '--config=${CFG}'`,
  `playwright-cli -s=uaeh-visual open about:blank '--config=${CFG}' --headed --mobile --browser=chrome --idle-timeout=600`,
  `playwright-cli open --config="${CFG}" --device="iPhone 13"`,
  'playwright-cli goto http://localhost:3000/inicio',
  "playwright-cli -s=uaeh-visual --json goto 'https://localhost:8443/x?y=1#z'",
  'playwright-cli goto http://127.0.0.1:4173', "playwright-cli goto 'http://[::1]:3000/a'", 'playwright-cli goto about:blank',
  `playwright-cli open http://127.0.0.1:4173 '--config=${CFG}'`,
  `playwright-cli screenshot --filename=${SHOT}`,
  `playwright-cli screenshot --filename=${SHOT} --full-page --type=png`,
  'playwright-cli screenshot e12 --filename=reports/visual-audit/a/b.webp',
  'playwright-cli snapshot',
  'playwright-cli snapshot --depth=3 --boxes --filename=reports/visual-audit/x/s.yml',
  'playwright-cli eval "() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]"',
  'playwright-cli eval "() =>   getComputedStyle(document.body).fontFamily"',
  `playwright-cli eval "() => getComputedStyle(document.querySelector('h1')).fontFamily" --filename=reports/visual-audit/x/t.json`,
  'playwright-cli eval "() => document.documentElement.lang"',
  `playwright-cli eval "() => matchMedia('(prefers-reduced-motion: reduce)').matches"`,
  'playwright-cli console',
  'playwright-cli requests',
  'playwright-cli resize 360 800',
  'playwright-cli set-reduced-motion reduce', 'playwright-cli tab-list', 'playwright-cli tab-select 1', 'playwright-cli tab-close', 'playwright-cli tab-close 2', 'playwright-cli go-back', 'playwright-cli go-forward', 'playwright-cli console warning',
  'playwright-cli tab-new http://localhost:3000',
  'playwright-cli close',
  'playwright-cli --version',
  'playwright-cli --help',
  'playwright-cli --help open',
  'npx --no-install playwright test',
  'npx --no playwright test --list',
  'npx --no-install playwright test --config=playwright.visual.config.ts --list',
  'npx --no-install playwright test --config playwright.visual.config.ts',
  'npx --no-install playwright test -c ./playwright.config.ts -g captura -x',
  'npx --no-install playwright test -g captura --project=movil-360 -j 2',
  'npx --no-install playwright test --reporter=json --config=playwright.visual.config.ts tests/visual/home.spec.ts',
  'npx --no-install playwright --version',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --output=json --output-path=reports/visual-audit/x/l.json',
  'npx --yes lighthouse@13.5.0 http://127.0.0.1:4173 --output=html --output-path=reports/visual-audit/x/l.html --chrome-flags="--headless=new"',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --output=json --output-path=reports/visual-audit/x/l.json --only-categories=performance,accessibility --form-factor=mobile --preset=desktop --screenEmulation.disabled --throttling-method=simulate --quiet --max-wait-for-load=45000 --chrome-flags=--headless=new', // uaeh-lint: permitir (--preset de Lighthouse)
  'git status', 'git diff', 'git diff --stat HEAD', 'git diff --no-ext-diff --stat', 'git log --since=2026-10-15 --oneline', 'git log --oneline -5', 'git show HEAD', 'git rev-parse HEAD', 'git ls-files',
  'curl -sI http://localhost:3000', 'curl.exe -sI http://127.0.0.1:4173', 'curl -s -I -m 5 http://127.0.0.1:8080/api', "curl.exe --head --max-time=5 'http://[::1]:3000/'", 'curl -sSI http://localhost',
];
const A = A0.map(ses);

const D0 = [
  // subcomandos negados
  ...'attach detach drop upload pdf state-load state-save response-body run-code recording-start recording-stop tracing-start tracing-stop video-start video-stop video-chapter video-show-actions video-hide-actions show pause-at resume step-over webmcp-list webmcp-call install install-browser close-all kill-all'.split(' ').map((s) => `playwright-cli ${s}`),
  'playwright-cli inventado', 'playwright-cli', 'playwright-cli -x close', 'playwright-cli -s=a/b close', 'playwright-cli -s visual close',
  'playwright-cli --help a b c', 'playwright-cli --version x',
  // open
  'playwright-cli open http://localhost:3000',
  'playwright-cli open http://localhost:3000 --config=.playwright/cli.config.json',
  'playwright-cli open http://localhost:3000 --config=C:/otro/cli.config.json',
  `playwright-cli open http://localhost:3000 --config ${CFG}`,
  `playwright-cli open '--config=${CFG}' --persistent`,
  `playwright-cli open '--config=${CFG}' --profile=x`,
  `playwright-cli open '--config=${CFG}' --cdp=http://localhost:9222`,
  `playwright-cli open '--config=${CFG}' --endpoint=ws://x`,
  `playwright-cli open '--config=${CFG}' --extension`,
  `playwright-cli open '--config=${CFG}' --browser=opera`,
  `playwright-cli open '--config=${CFG}' --device "iPhone 13"`,
  `playwright-cli open file:///C:/x.html '--config=${CFG}'`,
  `playwright-cli open localhost:3000 '--config=${CFG}'`,
  // URLs
  'playwright-cli goto file:///C:/Windows/win.ini', 'playwright-cli goto data:text/html,hola', 'playwright-cli goto javascript:alert(1)',
  'playwright-cli goto localhost:3000', 'playwright-cli goto chrome://settings', 'playwright-cli goto view-source:http://localhost',
  'playwright-cli tab-new file:///x',
  // screenshot / filename
  'playwright-cli screenshot', 'playwright-cli screenshot --full-page',
  'playwright-cli screenshot --filename=reports/visual-audit/../../x.png',
  'playwright-cli screenshot --filename=C:/x.png', 'playwright-cli screenshot --filename=/tmp/x.png',
  'playwright-cli screenshot --filename=otra/carpeta/x.png', 'playwright-cli screenshot --filename=reports/visual-audit/x.exe',
  'playwright-cli screenshot --filename reports/visual-audit/x.png',
  'playwright-cli snapshot --filename=x.yml', 'playwright-cli snapshot --filename=reports/visual-audit/x.png',
  'playwright-cli eval "() => 1" --filename=C:/x.json', 'playwright-cli snapshot --mala',
  'playwright-cli click e1 --filename=x', 'playwright-cli click e1 --config=x', 'playwright-cli goto http://localhost --path=x',
  // encadenados / sintaxis
  'playwright-cli close; rm x', 'playwright-cli close && rm x', 'playwright-cli close | cat', 'playwright-cli console > out.txt',
  'playwright-cli eval $(whoami)', 'playwright-cli eval `whoami`', 'playwright-cli close\nrm x', 'playwright-cli close\r\nrm x',
  'playwright-cli fill e1 "%PATH%"', 'playwright-cli fill e1 "a$b"', 'playwright-cli click "e1', 'playwright-cli close ^& x',
  'playwright-cli close (x)', 'playwright-cli close & calc',
  // npx
  'npx playwright test -u', 'npx playwright test --update-snapshots', 'npx playwright test --update-snapshots=all',
  'npx playwright test --update-source-method=3way', 'npx playwright test --ui', 'npx playwright test --debug',
  'npx playwright install', 'npx playwright show-report', 'npx playwright codegen', 'npx vercel', 'npx eslint .', 'npx', 'npx --yes playwright test',
  'npx lighthouse http://localhost:3000', 'npx --yes lighthouse http://localhost:3000', 'npx --yes lighthouse@12.0.0 http://localhost:3000',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --output-path=C:/x.json',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --output-path=reports/visual-audit/x.exe',
  'npx --yes lighthouse@13.5.0 file:///C:/x.html', 'npx --yes lighthouse@13.5.0', 'npx --yes lighthouse@13.5.0 http://localhost:3000 --view',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --plugins=x', 'npx --yes lighthouse@13.5.0 http://localhost:3000 --output=csv',
  // git
  'git -C x status', 'git -c core.pager=x log', 'git diff --output=x', 'git diff --ext-diff', 'git log -o x',
  'git commit -m x', 'git push', 'git add .', 'git branch', 'git',
  // curl / iwr
  'curl http://localhost:3000', 'curl -o x.txt -I http://localhost:3000', 'curl -d x -I http://localhost:3000', 'curl -sI http://evil.com',
  'curl -sI https://localhost:3000', 'curl -sI http://localhost@evil.com', 'curl -sI http://localhost:3000 http://localhost:3001',
  'curl -sI -m x http://localhost:3000', 'curl -X POST -I http://localhost:3000', 'curl -I',
  'Invoke-WebRequest -Method Get -Uri http://localhost:3000', 'Invoke-WebRequest -Uri http://localhost:3000',
  'Invoke-WebRequest -Method Head -Uri http://localhost:3000 -OutFile x', 'Invoke-WebRequest -Method Head -Uri http://evil.com',
  'Invoke-WebRequest -Method Post -Uri http://localhost:3000', 'Invoke-WebRequest -Method Head -Uri http://localhost:3000 -Body x',
  // A1 navegación solo local
  'playwright-cli goto https://example.com', 'playwright-cli goto http://evil.com', 'playwright-cli goto http://localhost.evil.com',
  'playwright-cli goto http://localhost@evil.com', 'playwright-cli goto http://127.0.0.1.evil.com', 'playwright-cli goto http://10.0.0.5:3000',
  'playwright-cli goto http://0.0.0.0:3000', 'playwright-cli goto http://localhost:3000@evil.com', 'playwright-cli tab-new https://evil.com',
  `playwright-cli open https://example.com '--config=${CFG}'`, `playwright-cli open http://169.254.169.254/ '--config=${CFG}'`,
  'npx --yes lighthouse@13.5.0 https://example.com --output-path=reports/visual-audit/x/l.json',
  'npx --yes lighthouse@13.5.0 http://evil.com --output-path=reports/visual-audit/x/l.json',
  'npx --yes lighthouse@13.5.0 about:blank --output-path=reports/visual-audit/x/l.json',
  // A2 eval lista cerrada
  'playwright-cli eval "() => document.title"', 'playwright-cli eval "() => document.cookie"', 'playwright-cli eval "() => fetch(\'http://evil.com\')"',
  'playwright-cli eval "() => localStorage"', 'playwright-cli eval "() => document.documentElement.scrollWidth"',
  'playwright-cli eval "() => getComputedStyle(document.body).fontFamily; fetch(1)"', 'playwright-cli eval', 'playwright-cli eval "() => document.documentElement.lang" e5',
  'playwright-cli eval "() => document.documentElement.lang" "() => document.documentElement.lang"',
  'playwright-cli eval "() => document.documentElement.lang" --filename=C:/x.json',
  'playwright-cli eval "() => document.documentElement.lang" --config=x', 'playwright-cli run-code "async page => 1"',
  // A3 lighthouse
  'npx --yes lighthouse@13.5.0 http://localhost:3000', 'npx --yes lighthouse@13.5.0 http://localhost:3000 --output=json',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --output-path=reports/visual-audit/x/l.json --chrome-flags="--headless=new --no-sandbox"',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --output-path=reports/visual-audit/x/l.json --chrome-flags="--user-data-dir=C:/x"',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --output-path=reports/visual-audit/x/l.json --chrome-flags=--remote-debugging-port=9222',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --output-path=reports/visual-audit/x/l.json --chrome-flags=',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --output-path=reports/visual-audit/x/l.json --output=csv',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --output-path=reports/visual-audit/x/l.json --output=json,html',
  'npx --yes lighthouse@13.5.0 http://localhost:3000 --output-path=otra/l.json',
  // A4 playwright test
  'npx playwright test', 'npx playwright test --list', 'npx playwright --version', 'npx --yes playwright test',
  'npx --no-install playwright test --output=C:/x', 'npx --no-install playwright test --output C:/x', 'npx --no-install playwright test -o C:/x',
  'npx --no-install playwright test -oC:/x', 'npx --no-install playwright test -xo foo', 'npx --no-install playwright test --output-dir=x',
  'npx --no-install playwright test -xu', 'npx --no-install playwright test -ux', 'npx --no-install playwright test --',
  'npx --no-install playwright test --config=C:/x/playwright.config.ts', 'npx --no-install playwright test --config=../playwright.config.ts',
  'npx --no-install playwright test --config=/etc/playwright.config.ts', 'npx --no-install playwright test --config=sub/playwright.config.ts',
  'npx --no-install playwright test --config=playwright.config.exe', 'npx --no-install playwright test --config=evil.config.ts',
  'npx --no-install playwright test --config evil.js', 'npx --no-install playwright test --config', 'npx --no-install playwright test -c ../playwright.config.ts',
  'npx --no-install playwright test -c C:/x/playwright.config.ts', 'npx --no-install playwright test -c=playwright.config.ts',
  'npx --no-install playwright test -cevil.js', 'npx --no-install playwright test -p x', 'npx --no --yes playwright test',
  // A5 git
  'git diff --ext', 'git diff --ext-', 'git diff --ext-diff=x', 'git log --ext-d', 'git diff --textc', 'git diff --textconv', 'git show --textconv=x HEAD',
  'git show HEAD:.env', 'git show HEAD:src/app.ts', 'git show :0:x', 'git show :x', 'git diff HEAD:a HEAD:b', 'git log HEAD:x', 'git show C:/x/y',
  'git diff --outpu=x', 'git diff --out=x', 'git diff --no-index a b',
  // A6 curl / iwr
  'curl -sIL http://localhost:3000', 'curl -I -L http://localhost:3000', 'curl --head --location http://localhost:3000', 'curl -sI --location-trusted http://localhost:3000',
  'curl -sI --max-redirs 5 http://localhost:3000', 'curl.exe -sI -L http://127.0.0.1:4173', 'curl.exe -sIL http://127.0.0.1:4173', 'curl -sI http://evil.com', 'curl.exe -sI https://example.com',
  'Invoke-WebRequest -Method Head -Uri http://localhost:3000', 'Invoke-WebRequest http://localhost:3000 -method head -UseBasicParsing -TimeoutSec 5', 'iwr -Method Head http://localhost:3000',
  // otros
  'rm -rf x', 'node -e "1"', 'python -c "1"', 'powershell -c "ls"', 'ls', 'bash script.sh', 'C:\\x\\git.exe status', 'wsl -e ls', '',
  '   ',
  // R4 SEC-010: invertidos (antes permitidos)
  'PLAYWRIGHT-CLI.cmd close', 'playwright-cli.exe reload',
];
const D = D0.map(ses);

const SUBCOMANDOS_OK = 'open close goto go-back go-forward reload resize snapshot screenshot console requests eval tab-list tab-select tab-close tab-new set-reduced-motion'.split(' ');
const CUERPO_DE = { open: `open http://127.0.0.1:4173 '--config=${CFG}'`, goto: 'goto http://localhost:3000', resize: 'resize 360 800', screenshot: `screenshot --filename=${SHOT}`, eval: 'eval "() => document.documentElement.lang"', 'tab-select': 'tab-select 0', 'set-reduced-motion': 'set-reduced-motion reduce' };
const SUBCOMANDOS_NEGADOS = 'click dblclick fill type press keydown keyup hover drag drop select check uncheck upload request request-headers request-body response-headers response-body route route-list unroute cookie-list cookie-get cookie-set cookie-delete cookie-clear localstorage-list localstorage-get localstorage-set localstorage-delete localstorage-clear sessionstorage-list sessionstorage-get sessionstorage-set sessionstorage-delete sessionstorage-clear state-load state-save pdf run-code find dialog-accept dialog-dismiss mousemove mousedown mouseup mousewheel set-color-scheme set-forced-colors set-contrast set-media clear-color-scheme clear-reduced-motion clear-forced-colors clear-contrast clear-media network-state-set delete-data generate-locator highlight list'.split(' ');

// ── Tablas ────────────────────────────────────────────────────────────────────────────

test('tablas · conservan los casos del candado original (al menos 60 permitidos y 230 negados)', () => {
  assert.ok(A.length >= 60, `permitidos: ${A.length}`);
  assert.ok(D.length >= 230, `negados: ${D.length}`);
});

test('tablas · cada forma permitida pasa (sin salida) y cada forma negada se niega, como browser-verifier por Bash', { timeout: 300000 }, async () => {
  await exigir([...permitidos(A0), ...negados(D0)]);
});

test('una sola gramática · TODO lo que llega por PowerShell se niega (también las formas legítimas), con el motivo «solo Bash»', { timeout: 300000 }, async () => {
  await exigir(negados([...A0, ...D0, 'playwright-cli close'], { tool: 'PowerShell', motivo: /solo Bash/i }));
  await exigir(negados(['playwright-cli close', 'rm x', 'git status', 'git push'], { tool: 'powershell' }));
  await exigir(permitidos(['playwright-cli close']));
});

test('R3 · reproducciones de SEC-006 (el hook veía un token y el programa recibía opciones sin revisar) se niegan', async () => {
  const RAW = String.raw;
  await exigir(negados([
    RAW`git log -1 '--format=tformat:AAA\" --name-only'`,
    RAW`git log -1 --format=tformat:AAA\" --name-only "\""`,
    RAW`npx --no-install playwright test '--grep=x\" --output=C:/x'`,
    RAW`playwright-cli request 1 'x\" --filename=C:/x.txt'`,
    '@HOME', 'playwright-cli @HOME', 'playwright-cli goto @HOME', 'git log @HOME',
  ]));
});

test('R3 · tokenizador Bash estricto: barra invertida, comodines, tilde, comentario e historia fuera de comillas se niegan', async () => {
  const RAW = String.raw;
  await exigir(negados([
    RAW`playwright-cli goto http://localhost:3000\x`, RAW`playwright-cli goto 'http://localhost:3000\x'`, RAW`playwright-cli goto "http://localhost:3000\x"`,
    RAW`playwright-cli goto http://localhost:3000/a\ b`, RAW`playwright-cli \close`, RAW`playwright-cli screenshot --filename=reports\visual-audit\a.png`,
    'playwright-cli goto http://localhost:3000/*', 'playwright-cli goto http://localhost:3000/a?b=1', 'playwright-cli goto http://[::1]:3000',
    'playwright-cli goto http://localhost:3000/a#b', 'playwright-cli goto ~', 'playwright-cli goto http://localhost:3000/~x',
    'playwright-cli close !x', 'playwright-cli close # comentario', 'playwright-cli close ]', 'git log a[0-9]',
    `playwright-cli goto "http://localhost:3000/a'b"`, `playwright-cli goto 'http://localhost:3000/a"b'`,
    `git log --grep="a'b"`, `git log --grep='a"b'`,
    `playwright-cli eval "() => document.title + 'x'"`,
  ]));
  // lo que sí se puede escribir: comodines entre comillas simples (literales para Bash)
  await exigir(permitidos(["playwright-cli goto 'http://[::1]:3000/a?b=1#c'", "playwright-cli goto 'http://localhost:3000/a?b=1#c'"]));
});

test('R3 · subcomandos de playwright-cli en lista CERRADA: los que no interactúan pasan; click, fill, cookies, storage… se niegan', { timeout: 120000 }, async () => {
  await exigir(permitidos(SUBCOMANDOS_OK.map((s) => 'playwright-cli ' + (CUERPO_DE[s] || s))));
  await exigir([
    ...negados(SUBCOMANDOS_NEGADOS.map((s) => `playwright-cli ${s}`)),
    ...negados(SUBCOMANDOS_NEGADOS.map((s) => `playwright-cli -s=uaeh-a ${s} e1`)),
    ...negados(['playwright-cli console --clear', 'playwright-cli requests --static', 'playwright-cli requests --filter=x',
      'playwright-cli resize 360', 'playwright-cli resize a b', 'playwright-cli set-reduced-motion x',
      'playwright-cli goto', 'playwright-cli goto http://localhost:3000 http://localhost:3001', 'playwright-cli close now', 'playwright-cli tab-select',
      'playwright-cli tab-new http://localhost:3000 http://localhost:3001']),
  ]);
});

test('R3 · --session= admite la misma expresión que -s=', async () => {
  await exigir(permitidos(['playwright-cli --session=uaeh-visual-1 close', 'playwright-cli --session=uaeh-visual-1 --json snapshot']));
  await exigir(negados(['playwright-cli --session=a/b close', 'playwright-cli --session= close', 'playwright-cli --session visual close',
    'playwright-cli --session=' + 'a'.repeat(65) + ' close', 'playwright-cli -s= close', 'playwright-cli -s=a --session=b/c close']));
});

test('R3 · playwright test: opciones largas en lista blanca; posicionales solo rutas relativas', async () => {
  await exigir(permitidos([
    'npx --no-install playwright test --project=movil-360 --grep=captura --grep-invert=lento --workers=2 --retries=1 --max-failures=3 --timeout=30000 --list --quiet --forbid-only',
    'npx --no-install playwright test --config=playwright.visual.config.ts --reporter=list', 'npx --no-install playwright test --reporter=line,json,junit,dot,null',
    'npx --no-install playwright test tests/visual/home.spec.ts ./tests/otro.spec.ts', 'npx --no-install playwright test home',
  ]));
  await exigir(negados([
    'npx --no-install playwright test --pass-with-no-tests', 'npx --no-install playwright test --pass-with-no-tests=true',
    'npx --no-install playwright test --headed', 'npx --no-install playwright test --trace=on', 'npx --no-install playwright test --shard=1/2', 'npx --no-install playwright test --global-timeout=5',
    'npx --no-install playwright test --reporter=html', 'npx --no-install playwright test --reporter=./mio.js', 'npx --no-install playwright test --reporter=json,html', 'npx --no-install playwright test --reporter',
    'npx --no-install playwright test --workers=50%', 'npx --no-install playwright test --workers', 'npx --no-install playwright test --workers=x', 'npx --no-install playwright test --retries=-1',
    'npx --no-install playwright test --list=x', 'npx --no-install playwright test --quiet=1', 'npx --no-install playwright test --project', 'npx --no-install playwright test --grep',
    'npx --no-install playwright test --tsconfig=../x.json', 'npx --no-install playwright test --repeat-each=3', 'npx --no-install playwright test --last-failed', 'npx --no-install playwright test --only-changed',
    'npx --no-install playwright test /etc/passwd', 'npx --no-install playwright test C:/x/t.spec.ts', 'npx --no-install playwright test ../t.spec.ts', 'npx --no-install playwright test tests/../../t.spec.ts',
    'npx --no-install playwright test tests/..', 'npx --no-install playwright test //srv/share/t', 'npx --no-install playwright test -g --output=C:/x', 'npx --no-install playwright test -j x',
  ]));
});

test('R4 · SEC-010: programas solo por su nombre exacto (sin .cmd/.bat/.ps1/.exe de más, rutas ni otras mayúsculas)', async () => {
  await exigir(negados([
    `playwright-cli.cmd ${S4} close`, `PLAYWRIGHT-CLI.cmd ${S4} close`, `playwright-cli.bat ${S4} close`, `playwright-cli.ps1 ${S4} close`, `playwright-cli.exe ${S4} reload`,
    `Playwright-Cli ${S4} close`, `./playwright-cli ${S4} close`, `/c/x/playwright-cli ${S4} close`, `playwright-cli. ${S4} close`, `playwright-cli.cmd. ${S4} close`,
    'npx.cmd --no-install playwright test', 'NPX.CMD --no-install playwright test', 'npx.exe --no-install playwright test', 'npx.ps1 --no-install playwright test', 'NPX --no-install playwright test',
    'git.cmd status', 'git.bat status', 'GIT status', 'Git.exe status', 'git.EXE status', './git status', 'git. status', 'git.exe.cmd status',
    'curl.cmd -sI http://127.0.0.1:4173', 'CURL -sI http://127.0.0.1:4173', 'Curl.exe -sI http://127.0.0.1:4173', 'curl.bat -sI http://127.0.0.1:4173',
  ], { sinSesion: true }));
});

test('R4 · defensa en profundidad: & | < > ( ) dentro de comillas se niegan, salvo las 5 expresiones de eval', async () => {
  await exigir(negados([
    `playwright-cli ${S4} goto 'http://localhost:3000/a?x=1&y=2'`, `playwright-cli ${S4} goto 'http://localhost:3000/a|b'`, `playwright-cli ${S4} goto 'http://localhost:3000/a>b'`,
    `playwright-cli ${S4} goto 'http://localhost:3000/a<b'`, `playwright-cli ${S4} goto 'http://localhost:3000/a(b)'`, `playwright-cli ${S4} goto 'http://localhost:3000/&calc'`,
    "git log '--grep=a&calc'", "git log '--grep=a|b'", "git log '--grep=a>b'", "git log '--grep=(a)'", "git log '--grep=a<b'",
    "npx --no-install playwright test '--grep=a&calc'", "npx --no-install playwright test '--grep=(a)'", "curl -sI 'http://127.0.0.1:4173/?a&b'", "curl -sI 'http://127.0.0.1:4173/(x)'",
    `playwright-cli ${S4} eval 'a&b'`, `playwright-cli ${S4} eval "() => document.title"`,
  ], { sinSesion: true }));
  await exigir(permitidos([
    '() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]', '() => getComputedStyle(document.body).fontFamily',
    "() => getComputedStyle(document.querySelector('h1')).fontFamily", '() => document.documentElement.lang', "() => matchMedia('(prefers-reduced-motion: reduce)').matches",
  ].map((e) => `playwright-cli ${S4} eval "${e}"`), { sinSesion: true }));
});

test('R4 · SEC-012: «/x», «=/x», «X:/x», opción corta pegada a «/» y «:/» se niegan; la única excepción es el --config de confianza de open', async () => {
  // La forma de Git Bash (/c/…) de la configuración de confianza no es la configuración de confianza.
  const cfgOtraForma = WIN ? '/' + CFG[0].toLowerCase() + CFG.slice(2) : '/otra' + CFG;
  await exigir(negados([
    'git log /x', 'git diff -- /etc/passwd', "git log '--grep=/x'", 'git log --grep=/x', 'git log --since=/x', 'git log C:/Windows/win.ini', 'git show HEAD -- D:/x',
    'npx --no-install playwright test --grep=/x', 'npx --no-install playwright test --project=/x', 'npx --no-install playwright test --grep-invert=a=/x',
    'curl -sI /x', 'curl -sI http://127.0.0.1:4173 --max-time=/5',
    `playwright-cli ${S4} goto 'http://localhost:3000/a?x=/y'`, `playwright-cli ${S4} goto /x`, `playwright-cli ${S4} screenshot --filename=/x/reports/visual-audit/a.png`,
    `playwright-cli ${S4} open http://127.0.0.1:4173 --config=C:/otro/cli.config.json`, `playwright-cli ${S4} open http://127.0.0.1:4173 --config=${cfgOtraForma}`,
    `playwright-cli ${S4} open http://127.0.0.1:4173 '--config=${CFG}'x`, `playwright-cli ${S4} console C:/x`,
    'git log -g/c/x', 'git log -S/c/x', 'git log -O/c/x', 'git log --grep=.:/x', 'curl -sI -o/c/x http://127.0.0.1:4173', 'npx --no-install playwright test --grep=a:/x',
    // fuera de open, el --config de confianza no sirve de nada
    `playwright-cli ${S4} console '--config=${CFG}'`, `playwright-cli ${S4} goto http://localhost:3000 '--config=${CFG}'`, `git log '--config=${CFG}'`,
  ], { sinSesion: true }));
  await exigir(permitidos([
    `playwright-cli ${S4} open http://127.0.0.1:4173 '--config=${CFG}'`,
    `playwright-cli ${S4} open --config="${CFG}" http://127.0.0.1:4173`,
    `playwright-cli open --config="${CFG}" http://127.0.0.1:4173`,
    `playwright-cli open --config='${CFG}' 'http://127.0.0.1:4173'`,
  ], { sinSesion: false }));
});

test('R4 · sesiones ajenas (SEC-013): todo comando salvo --help/--version exige una sesión propia uaeh-…', { timeout: 120000 }, async () => {
  const casos = [];
  for (const s of SUBCOMANDOS_OK) {
    const cuerpo = CUERPO_DE[s] || s;
    casos.push(...negados([`playwright-cli ${cuerpo}`, `playwright-cli --json ${cuerpo}`], { sinSesion: true }));
    casos.push(...permitidos([`playwright-cli ${S4} ${cuerpo}`, `playwright-cli --session=uaeh-ensayo-visual-20261015 --json ${cuerpo}`], { sinSesion: true }));
  }
  casos.push(...negados([
    'playwright-cli -s=visual close', 'playwright-cli -s=default close', 'playwright-cli -s=UAEH-x close', 'playwright-cli -s=Uaeh-x close', 'playwright-cli -s=uaeh close', 'playwright-cli -s=uaeh- close',
    'playwright-cli -s=uaeh--x close', 'playwright-cli -s=uaeh-X close', 'playwright-cli -s=uaeh-a_b close', 'playwright-cli -s=uaeh-a.b close', 'playwright-cli -s=xuaeh-a close', 'playwright-cli -s=uaeh-a-ñ close',
    'playwright-cli -s=uaeh-' + 'a'.repeat(64) + ' close', 'playwright-cli --session=otra-sesion close', 'playwright-cli --session=uaeh- close',
    `playwright-cli ${S4} -s=uaeh-otra close`, `playwright-cli ${S4} --session=uaeh-otra close`, 'playwright-cli close -s=uaeh-a', 'playwright-cli close --session=uaeh-a',
    'playwright-cli --json close', 'playwright-cli --raw snapshot', 'playwright-cli --help a b c', 'playwright-cli --version x',
  ], { sinSesion: true }));
  casos.push(...permitidos(['playwright-cli -s=uaeh-a close', 'playwright-cli -s=uaeh-0 close', 'playwright-cli -s=uaeh-' + 'a'.repeat(63) + ' close',
    'playwright-cli --help', 'playwright-cli --help open', 'playwright-cli --version'], { sinSesion: true }));
  await exigir(casos);
});

test('R4 · las formas legítimas completas de un recorrido del verificador pasan', async () => {
  await exigir(permitidos([
    'curl -sI http://127.0.0.1:4173',
    'npx --no-install playwright test --config=playwright.visual.config.ts',
    `playwright-cli ${S4} open http://127.0.0.1:4173 '--config=${CFG}'`,
    `playwright-cli ${S4} resize 360 800`, `playwright-cli ${S4} resize 1440 900`,
    `playwright-cli ${S4} goto http://127.0.0.1:4173/inicio`, `playwright-cli ${S4} snapshot`, `playwright-cli ${S4} console`, `playwright-cli ${S4} requests`,
    `playwright-cli ${S4} screenshot --filename=reports/visual-audit/20261015-1200/inicio-360.png --full-page`,
    `playwright-cli ${S4} set-reduced-motion reduce`, `playwright-cli ${S4} close`,
    'git status', 'git diff', 'git diff --stat HEAD', 'git log --oneline -5', 'git.exe status', 'curl.exe -sI http://127.0.0.1:4173',
  ], { sinSesion: true }));
});

// SEC-001/002 (revisión de D6): el CLI convierte una opción repetida en lista y la reenvía unida con comas; el candado solo
// miraba el último valor (--config) o cada valor por separado (--filename). Una opción repetida se niega siempre.
test('R5 · opciones repetidas en playwright-cli y Lighthouse se niegan (SEC-001/002); en playwright test, --project repetido sigue valiendo', async () => {
  await exigir(negados([
    `playwright-cli open --config=playwright-cli.config.json '--config=${CFG}' http://localhost:3000`,
    `playwright-cli open --config= '--config=${CFG}' http://localhost:3000`,
    `playwright-cli open '--config=${CFG}' '--config=${CFG}' http://localhost:3000`,
    `playwright-cli open '--config=${CFG}' --browser=chrome --browser=firefox http://localhost:3000`,
    `playwright-cli open '--config=${CFG}' --headed --headed`,
    'playwright-cli screenshot --filename=reports/visual-audit/q.png --filename=reports/visual-audit/z.png',
    'playwright-cli screenshot --filename=reports/visual-audit/q.png --full-page --full-page',
    'playwright-cli snapshot --filename=reports/visual-audit/a.yml --filename=reports/visual-audit/b.yml',
    'playwright-cli eval "() => document.documentElement.lang" --filename=reports/visual-audit/a.json --filename=reports/visual-audit/b.json',
    `playwright-cli ${S4} --json --json snapshot`,
    `playwright-cli ${S4} --raw --raw snapshot`,
    'npx --yes lighthouse@13.5.0 http://localhost:3000 --output-path=reports/visual-audit/a.json --output-path=reports/visual-audit/b.json',
    'npx --yes lighthouse@13.5.0 http://localhost:3000 --output=json --output=html --output-path=reports/visual-audit/a.json',
  ], { motivo: /repetida/ }));
  await exigir(permitidos([
    'npx --no-install playwright test --project=movil-360 --project=escritorio-1440',
    `playwright-cli ${S4} --json snapshot --filename=reports/visual-audit/a.yml`,
  ]));
});

// ── Evidencia en disco y entorno de open ──────────────────────────────────────────────

test('A7 · enlaces simbólicos o junctions en la ruta de evidencia se niegan; carpetas y archivos reales pasan', async () => {
  const e = nuevoEntorno('uaeh-solo-nav-a7-');
  try {
    const SHOT_CMD = 'playwright-cli screenshot --filename=reports/visual-audit/a/b.png';
    const nuevo = (n) => { const d = path.join(e.dir, n); fs.mkdirSync(d, { recursive: true }); return d; };
    const cwd = nuevo('cwd1');
    const fuera = nuevo('fuera');
    assert.ok(!(await correr(SHOT_CMD, { cwd })).deny, 'sin carpetas existentes: permitido');
    fs.mkdirSync(path.join(cwd, 'reports', 'visual-audit', 'a'), { recursive: true });
    assert.ok(!(await correr(SHOT_CMD, { cwd })).deny, 'carpetas reales existentes: permitido');
    fs.writeFileSync(path.join(cwd, 'reports', 'visual-audit', 'a', 'b.png'), 'x');
    assert.ok(!(await correr(SHOT_CMD, { cwd })).deny, 'archivo regular existente: permitido');

    // junction en Windows (no pide privilegios) o enlace de carpeta en POSIX, en un componente intermedio
    const cwd2 = nuevo('cwd2');
    fs.mkdirSync(path.join(cwd2, 'reports'), { recursive: true });
    fs.symlinkSync(fuera, path.join(cwd2, 'reports', 'visual-audit'), WIN ? 'junction' : 'dir');
    const j = await correr(SHOT_CMD, { cwd: cwd2 });
    assert.ok(j.deny && /enlace/.test(j.motivo), j.motivo);
    for (const cmd of ['playwright-cli eval "() => document.documentElement.lang" --filename=reports/visual-audit/t.json',
      'playwright-cli snapshot --filename=reports/visual-audit/s.yml',
      'npx --yes lighthouse@13.5.0 http://localhost:3000 --output-path=reports/visual-audit/l.json']) {
      assert.ok((await correr(cmd, { cwd: cwd2 })).deny, `el enlace también niega: ${cmd}`);
    }

    // enlace simbólico al archivo final (en Windows sin privilegios puede no poder crearse: lo cubre la junction)
    const cwd3 = nuevo('cwd3');
    fs.mkdirSync(path.join(cwd3, 'reports', 'visual-audit'), { recursive: true });
    let simbolico = true;
    try { fs.symlinkSync(path.join(fuera, 'x.png'), path.join(cwd3, 'reports', 'visual-audit', 'b.png'), 'file'); } catch { simbolico = false; }
    if (!WIN) assert.ok(simbolico, 'en POSIX el enlace de archivo siempre se puede crear');
    if (simbolico) assert.ok((await correr('playwright-cli screenshot --filename=reports/visual-audit/b.png', { cwd: cwd3 })).deny, 'enlace al archivo final niega');

    // lstat falla por otra razón que «no existe» (archivo donde se esperaba carpeta): POSIX da ENOTDIR → niega; Windows lo
    // reporta como ENOENT (no se puede escribir debajo de un archivo) → pasa.
    const cwd4 = nuevo('cwd4');
    fs.mkdirSync(path.join(cwd4, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(cwd4, 'reports', 'visual-audit'), 'soy un archivo');
    assert.equal((await correr(SHOT_CMD, { cwd: cwd4 })).deny, !WIN);
  } finally { e.limpiar(); }
});

test('A8 · open se niega con ~/.playwright/cli.config.json, PLAYWRIGHT_MCP_* o PWTEST_CLI_GLOBAL_CONFIG; los demás subcomandos no', async () => {
  const OPEN = `playwright-cli open http://127.0.0.1:4173 '--config=${CFG}'`;
  assert.ok(!(await correr(OPEN)).deny, 'open limpio: permitido');
  const casa = path.join(E.dir, 'casa-con-config-de-playwright');
  fs.mkdirSync(path.join(casa, '.playwright'), { recursive: true });
  fs.writeFileSync(path.join(casa, '.playwright', 'cli.config.json'), '{}');
  const envCasa = { ...E.env, HOME: casa, USERPROFILE: casa };
  const c = await correr(OPEN, { env: envCasa });
  assert.ok(c.deny && /cli\.config\.json/.test(c.motivo), c.motivo);
  assert.ok(!(await correr('playwright-cli snapshot', { env: envCasa })).deny, 'snapshot no se ve afectado por ~/.playwright');
  for (const v of ['PLAYWRIGHT_MCP_BROWSER', 'PLAYWRIGHT_MCP_CDP_ENDPOINT', 'playwright_mcp_user_data_dir']) {
    const r = await correr(OPEN, { env: { ...E.env, [v]: 'x' } });
    assert.ok(r.deny && /PLAYWRIGHT_MCP_/.test(r.motivo), `${v}: ${r.motivo}`);
  }
  assert.ok(!(await correr('playwright-cli console', { env: { ...E.env, PLAYWRIGHT_MCP_BROWSER: 'x' } })).deny);
  const p = await correr(OPEN, { env: { ...E.env, PWTEST_CLI_GLOBAL_CONFIG: 'C:/x/c.json' } });
  assert.ok(p.deny && /PWTEST_CLI_GLOBAL_CONFIG/.test(p.motivo), p.motivo);
  assert.ok(!(await correr('playwright-cli console', { env: { ...E.env, PWTEST_CLI_GLOBAL_CONFIG: 'x' } })).deny);
});

// ── Configuración de confianza (sin rutas fijas de una máquina) ───────────────────────

test('confianza · valen la plantilla del plugin y UAEH_HOME/playwright-cli.config.json; otra casa u otro archivo no', async () => {
  await exigir(permitidos([
    `playwright-cli open http://127.0.0.1:4173 '--config=${CFG}'`,
    `playwright-cli open http://127.0.0.1:4173 --config=${CFG_PLUGIN}`,
    `playwright-cli open --config='${CFG_PLUGIN}' about:blank`,
  ]));
  const otraCasa = aBarra(path.join(E.dir, 'otra-casa', '.claude', 'uaeh', 'playwright-cli.config.json'));
  await exigir(negados([
    `playwright-cli open http://127.0.0.1:4173 --config=${otraCasa}`,
    `playwright-cli open http://127.0.0.1:4173 --config=${aBarra(path.join(E.uaehHome, 'otro.config.json'))}`,
    `playwright-cli open http://127.0.0.1:4173 --config=${aBarra(path.join(RAIZ_HARNESS, 'templates', 'uaeh.config.example.json'))}`,
    'playwright-cli open http://127.0.0.1:4173 --config=playwright-cli.config.json',
  ], { motivo: /configuración de confianza|empieza por «\/»/ }));
});

test('confianza · mayúsculas: en Windows no distinguen (rutas de Windows); en Linux sí', async () => {
  const r = await correr(`playwright-cli open http://127.0.0.1:4173 '--config=${CFG.toUpperCase()}'`);
  assert.equal(r.status, 0);
  assert.equal(r.deny, !WIN, WIN ? 'en Windows la misma ruta en mayúsculas es la misma configuración' : 'en Linux otra capitalización es otro archivo');
});

test('confianza · la negativa nombra las configuraciones válidas de ESTA instalación (calculadas al correr)', async () => {
  const r = await correr('playwright-cli open http://127.0.0.1:4173 --config=playwright-cli.config.json');
  assert.ok(r.deny);
  assert.ok(r.motivo.includes(CFG), `debe nombrar ${CFG}: ${r.motivo.slice(0, 300)}`);
  assert.ok(r.motivo.includes(CFG_PLUGIN), `debe nombrar ${CFG_PLUGIN}`);
  const { configsDeConfianza } = require(HOOK);
  assert.equal(typeof configsDeConfianza, 'function');
});

test('confianza · UAEH_HOME con espacios y acentos (perfil «Ana Pérez»): open con el --config entre comillas pasa', async () => {
  const e = nuevoEntorno('uaeh-solo-nav-perfil-');
  try {
    const uaeh = path.join(e.dir, 'Ana Pérez', '.claude', 'uaeh');
    fs.mkdirSync(uaeh, { recursive: true });
    const env = { ...e.env, UAEH_HOME: uaeh };
    const cfg = aBarra(path.join(uaeh, 'playwright-cli.config.json'));
    const bien = await correr(`playwright-cli open http://127.0.0.1:4173 '--config=${cfg}'`, { env });
    assert.equal(bien.deny, false, bien.motivo);
    assert.equal(bien.stdout, '');
    const sinComillas = await correr(`playwright-cli open http://127.0.0.1:4173 --config=${cfg}`, { env });
    assert.ok(sinComillas.deny, 'sin comillas el espacio parte la ruta en dos argumentos');
  } finally { e.limpiar(); }
});

// ── Compuerta por identidad ───────────────────────────────────────────────────────────

const INTERACTUA = `playwright-cli ${S4} click e12`;

test('compuerta · la sesión principal (sin agent_type) no queda bajo el candado y no deja ruido', async () => {
  const casos = [];
  for (const cmd of [INTERACTUA, 'rm -rf x', 'git commit -m x', 'npm install', 'node -e "1"']) for (const tool of ['Bash', 'PowerShell']) casos.push({ cmd, tool });
  const filas = await enParalelo(casos, async ({ cmd, tool }) => ({ cmd, tool, r: await ejecutar(eventoHerramienta(cmd, { tool, cwd: E.proyecto })) }));
  for (const { cmd, tool, r } of filas) {
    assert.equal(r.status, 0, `${tool} ${cmd}`);
    assert.equal(r.stdout, '', `la sesión principal no debe recibir negativa: ${tool} ${cmd}`);
    assert.equal(r.stderr, '', `ni avisos: ${tool} ${cmd}`);
  }
});

test('compuerta · un agent_type que no es texto, vacío o sin nombre cuenta como sesión principal', async () => {
  for (const valor of [5, null, true, ['browser-verifier'], { a: 1 }, '', '   ', 'uaeh-harness:']) {
    const r = await ejecutar({ ...eventoHerramienta(INTERACTUA, { cwd: E.proyecto }), agent_type: valor });
    assert.equal(r.status, 0, JSON.stringify(valor));
    assert.equal(r.stdout, '', JSON.stringify(valor));
  }
});

test('compuerta · los agentes que no figuran en la clave solo-navegador pasan sin salida (también uae-verifier y uae-security)', async () => {
  const agentes = ['uae-verifier', 'uae-security', 'uaeh-harness:uae-verifier', 'uae-builder', 'general-purpose', 'Explore', 'design-auditor',
    'browser-verifier-2', 'mi-browser-verifier', 'Browser-Verifier'];
  const casos = [];
  for (const agente of agentes) for (const cmd of [INTERACTUA, 'npm install']) casos.push({ agente, cmd });
  const filas = await enParalelo(casos, async ({ agente, cmd }) => ({ agente, cmd, r: await correr(cmd, { agente, sinSesion: true }) }));
  for (const { agente, cmd, r } of filas) {
    assert.equal(r.status, 0, `${agente}: ${cmd}`);
    assert.equal(r.stdout, '', `${agente} no está bajo este candado: ${cmd}`);
    assert.equal(r.stderr, '', `${agente}: sin avisos`);
  }
});

test('compuerta · browser-verifier queda bajo el candado con el prefijo del plugin o de cualquier otro', async () => {
  for (const agente of ['browser-verifier', 'uaeh-harness:browser-verifier', 'otro-plugin:browser-verifier']) {
    const niega = await correr(INTERACTUA, { agente, sinSesion: true });
    assert.ok(niega.deny, `${agente} debe quedar bajo el candado`);
    const pasa = await correr(`playwright-cli ${S4} snapshot`, { agente, sinSesion: true });
    assert.equal(pasa.stdout, '', `${agente}: snapshot sí pasa`);
  }
});

test('falla cerrado · browser-verifier sin comando de texto (o en blanco) NIEGA; el motivo explica la lista blanca', async () => {
  const base = { tool_name: 'Bash', agent_type: 'uaeh-harness:browser-verifier', cwd: E.proyecto };
  for (const [nombre, entrada] of [['sin tool_input', base], ['command numérico', { ...base, tool_input: { command: 5 } }],
    ['command vacío', { ...base, tool_input: { command: '' } }], ['command en blanco', { ...base, tool_input: { command: '   ' } }],
    ['tool_input no es objeto', { ...base, tool_input: 'rm x' }]]) {
    const r = await ejecutar(entrada);
    assert.equal(r.status, 0, nombre);
    assert.ok(r.deny, `${nombre}: debe negar`);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse', nombre);
  }
  const r = await correr('rm x');
  assert.match(r.motivo, /lista blanca/);
  assert.match(r.motivo, /Formas permitidas:/);
});

test('stdin ilegible · ya no se sabe quién ejecuta: sale 0 sin negar y deja un aviso en stderr', async () => {
  for (const [nombre, crudo] of [['vacía', ''], ['no es JSON', 'hola'], ['llaves rotas', '{{{'],
    ['JSON truncado del verificador', '{"agent_type":"browser-verifier","tool_input":{"command":']]) {
    const r = await ejecutar(null, { crudo });
    assert.equal(r.status, 0, nombre);
    assert.equal(r.stdout, '', nombre);
    assert.match(r.stderr, /solo-navegador: stdin no es un JSON legible/, nombre);
  }
  for (const crudo of ['null', '5', '"texto"', '[1,2]']) {
    const r = await ejecutar(null, { crudo });
    assert.equal(r.stdout, '', `${crudo}: JSON válido sin evento = sesión principal`);
    assert.equal(r.stderr, '', crudo);
  }
});

// ── Copias incompletas del plugin ─────────────────────────────────────────────────────

let copias = 0;
// Copia solo-navegador.js (y, según opciones, _identidad.js, candados.json, scripts/lib y la plantilla) a una carpeta nueva.
function copiarPlugin(e, { candados = true, identidad = true, lib = true, plantilla = true } = {}) {
  const raiz = path.join(e.dir, `plugin-copia-${++copias}`);
  const hooks = path.join(raiz, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const origen = path.join(RAIZ_HARNESS, 'hooks');
  fs.copyFileSync(path.join(origen, 'solo-navegador.js'), path.join(hooks, 'solo-navegador.js'));
  if (identidad) fs.copyFileSync(path.join(origen, '_identidad.js'), path.join(hooks, '_identidad.js'));
  if (candados) fs.copyFileSync(path.join(origen, 'candados.json'), path.join(hooks, 'candados.json'));
  if (lib) {
    const destino = path.join(raiz, 'scripts', 'lib');
    fs.mkdirSync(destino, { recursive: true });
    fs.copyFileSync(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'comun.cjs'), path.join(destino, 'comun.cjs'));
  }
  if (plantilla) {
    fs.mkdirSync(path.join(raiz, 'templates'), { recursive: true });
    fs.copyFileSync(path.join(RAIZ_HARNESS, 'templates', 'playwright-cli.config.json'), path.join(raiz, 'templates', 'playwright-cli.config.json'));
  }
  return { raiz, hook: path.join(hooks, 'solo-navegador.js'), candados: path.join(hooks, 'candados.json'), plantilla: aBarra(path.join(raiz, 'templates', 'playwright-cli.config.json')) };
}

test('copia del plugin · completa: niega al verificador, calla ante la sesión principal y su plantilla es de confianza', async () => {
  const c = copiarPlugin(E);
  assert.ok((await correr(INTERACTUA, { hook: c.hook, sinSesion: true })).deny);
  const principal = await ejecutar(eventoHerramienta(INTERACTUA, { cwd: E.proyecto }), { hook: c.hook });
  assert.equal(principal.stdout, '');
  assert.equal(principal.stderr, '');
  assert.equal((await correr(`playwright-cli open about:blank '--config=${c.plantilla}'`, { hook: c.hook })).stdout, '', 'la plantilla de ESA copia');
  assert.ok((await correr(`playwright-cli open about:blank --config=${CFG_PLUGIN}`, { hook: c.hook })).deny, 'la plantilla de otra instalación no');
});

test('copia del plugin · sin candados.json, roto o sin la clave solo-navegador: no aplica a nadie y avisa por stderr', async () => {
  const sinArchivo = copiarPlugin(E, { candados: false });
  const r0 = await correr(INTERACTUA, { hook: sinArchivo.hook, sinSesion: true });
  assert.equal(r0.stdout, '');
  assert.match(r0.stderr, /solo-navegador: candados\.json ilegible o sin la clave "solo-navegador"/);
  for (const [nombre, texto] of [['JSON roto', '{ "solo-navegador": ['], ['sin la clave', '{"solo-lectura":["browser-verifier"]}'], ['no es lista', '{"solo-navegador":"browser-verifier"}']]) {
    const c = copiarPlugin(E);
    fs.writeFileSync(c.candados, texto, 'utf8');
    const r = await correr(INTERACTUA, { hook: c.hook, sinSesion: true });
    assert.equal(r.status, 0, nombre);
    assert.equal(r.stdout, '', nombre);
    assert.match(r.stderr, /candados\.json ilegible o sin la clave "solo-navegador"/, nombre);
  }
});

test('copia del plugin · la lista sale de candados.json: otro agente listado queda bajo el candado', async () => {
  const c = copiarPlugin(E);
  fs.writeFileSync(c.candados, JSON.stringify({ 'solo-navegador': ['verificador-propio'] }), 'utf8');
  assert.ok((await correr(INTERACTUA, { hook: c.hook, agente: 'uaeh-harness:verificador-propio', sinSesion: true })).deny);
  const ya = await correr(INTERACTUA, { hook: c.hook, sinSesion: true });
  assert.equal(ya.stdout, '', 'browser-verifier ya no está en la lista de esta copia');
  assert.equal(ya.stderr, '');
});

test('copia del plugin · sin _identidad.js no se sabe quién ejecuta: sale 0 sin negar y avisa', async () => {
  const c = copiarPlugin(E, { identidad: false });
  const r = await correr(INTERACTUA, { hook: c.hook, sinSesion: true });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no se pudo cargar hooks\/_identidad\.js/);
});

test('copia del plugin · sin scripts/lib solo vale la plantilla (UAEH_HOME ya no) y el candado sigue funcionando', async () => {
  const c = copiarPlugin(E, { lib: false });
  assert.equal((await correr(`playwright-cli open about:blank '--config=${c.plantilla}'`, { hook: c.hook })).stdout, '');
  const r = await correr(`playwright-cli open about:blank '--config=${CFG}'`, { hook: c.hook });
  assert.ok(r.deny, 'sin comun.cjs no se calcula UAEH_HOME');
  assert.ok(!r.motivo.includes(CFG), 'y la negativa no la ofrece');
  assert.ok((await correr(INTERACTUA, { hook: c.hook, sinSesion: true })).deny);
});

// ── Paridad del tokenizador con un bash real ──────────────────────────────────────────

test('paridad · lo que el hook cree que recibe el programa es lo que recibe con bash real (corpus ≥ 25 comandos)', { timeout: 300000 }, (t) => {
  const bash = requiereBash(t);
  if (!bash) return;
  const { tokenizar } = require(HOOK);
  const dir = fs.mkdtempSync(path.join(E.tmp, 'paridad-'));
  const argvJs = aBarra(path.join(dir, 'argv.js'));
  fs.writeFileSync(argvJs, 'console.log(JSON.stringify(process.argv.slice(2)))\n');
  const nodo = WIN ? 'node' : aBarra(process.execPath);
  const PAR = [
    ...A,
    "playwright-cli goto 'http://[::1]:3000/a?b=1#c'", 'playwright-cli eval "() => 1" ""', "git log '--grep=a b' \"c  d\" e'f'\"g\"h",
    "git log --grep='a\"b' --grep=\"a'b\"", "curl -sI 'http://127.0.0.1:4173'", 'git   log\t-1\t--oneline', "playwright-cli fill e1 'a  b'", '  git status  ',
    'git log -1 --name-only -- "dir con espacio/x"', "playwright-cli goto 'http://localhost:3000/a?x=*&y=(1)|z;w'",
  ];
  assert.ok(PAR.length >= 25);
  const distintos = [];
  for (const cmd of PAR) {
    const esperado = tokenizar(cmd);
    const r = spawnSync(bash, ['-c', `${nodo} '${argvJs}' ${cmd}`], { encoding: 'utf8', env: E.env });
    let real = null;
    try { real = JSON.parse(r.stdout.trim()); } catch { /* abajo */ }
    if (real === null || JSON.stringify(real) !== JSON.stringify(esperado)) distintos.push(`${cmd}\n    bash=${JSON.stringify(real)} hook=${JSON.stringify(esperado)} ${(r.stderr || '').slice(0, 120)}`);
  }
  assert.equal(distintos.length, 0, `el tokenizador no coincide con bash en:\n  ${distintos.join('\n  ')}`);
});

test('paridad · Git Bash convierte «/x», «--grep=/x» y opciones cortas pegadas a «/» en rutas de Windows (por eso se niegan); un .cmd re-corta la línea', { timeout: 120000 }, async (t) => {
  // El hook niega estas formas en cualquier sistema (tabla SEC-012 de arriba). Aquí se demuestra la razón con el bash real.
  const bash = requiereBash(t);
  if (!bash) return;
  const dir = fs.mkdtempSync(path.join(E.tmp, 'paridad-r4-'));
  fs.writeFileSync(path.join(dir, 'argv.js'), 'console.log(JSON.stringify(process.argv.slice(2)))\n');
  const nodo = WIN ? 'node' : aBarra(process.execPath);
  const correrBash = (c) => spawnSync(bash, ['-c', c], { encoding: 'utf8', env: E.env, cwd: dir });
  for (const arg of ['/x', '--grep=/x', '-g/c/x', '-S/c/x', '-O/c/x', '--grep=.:/x']) {
    const r = correrBash(`${nodo} argv.js ${arg}`);
    let real = null;
    try { real = JSON.parse(r.stdout.trim())[0]; } catch { /* abajo */ }
    if (WIN) assert.ok(real !== null && real !== arg && /[A-Za-z]:[\\/]/.test(real), `Git Bash debería convertir ${arg}: ${real}`);
    else assert.equal(real, arg, `bash de Linux no convierte ${arg}`);
  }
  if (WIN) {
    // SEC-010: vía .cmd, un «&» sin espacios (Git Bash no lo protege con comillas) hace que cmd.exe re-corte la línea
    fs.writeFileSync(path.join(dir, 'probe.cmd'), '@echo off\r\necho ARGS: %*\r\n');
    const viaCmd = correrBash("./probe.cmd 'a&echo' EXTRA_EJECUTADO");
    assert.ok(viaCmd.stdout.split(/\r?\n/).map((l) => l.trim()).includes('EXTRA_EJECUTADO'), JSON.stringify(viaCmd.stdout));
    const sinCmd = correrBash("node argv.js 'a&echo' EXTRA_EJECUTADO");
    const lineas = sinCmd.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    assert.deepEqual(lineas.length === 1 ? JSON.parse(lineas[0]) : lineas, ['a&echo', 'EXTRA_EJECUTADO'], 'sin .cmd: argumento intacto y nada extra');
  }
  await exigir(negados([`playwright-cli.cmd ${S4} goto 'http://localhost:3000/?a&echo' EXTRA_EJECUTADO`, `playwright-cli.cmd ${S4} close`], { sinSesion: true }));
});

// ── Encadenado con los demás hooks del plugin ─────────────────────────────────────────

// Corre, en orden, todos los hooks de PreToolUse de hooks.json que casan con la herramienta; devuelve la primera negativa.
async function cadenaDeHooksJson(cmd, { agente = AGENTE, tool = 'Bash' } = {}) {
  const datos = JSON.parse(fs.readFileSync(path.join(RAIZ_HARNESS, 'hooks', 'hooks.json'), 'utf8'));
  const e = nuevoEntorno('uaeh-solo-nav-cadena-');
  try {
    for (const grupo of datos.hooks.PreToolUse) {
      if (grupo.matcher && !new RegExp(`^(?:${grupo.matcher})$`).test(tool)) continue;
      for (const h of grupo.hooks) {
        const script = h.args[0].replace('${CLAUDE_PLUGIN_ROOT}', RAIZ_HARNESS);
        const r = spawnSync(process.execPath, [script, ...h.args.slice(1)], {
          input: JSON.stringify(eventoHerramienta(cmd, { tool, agente, cwd: e.proyecto })), encoding: 'utf8', env: e.env, cwd: e.proyecto, timeout: 30000,
        });
        const res = resultado(r.status, r.stdout || '', r.stderr || '');
        if (res.deny) return { negado: true, hook: path.basename(script), motivo: res.motivo };
      }
    }
    return { negado: false };
  } finally { e.limpiar(); }
}

test('hooks.json · con todos los hooks del plugin encadenados, browser-verifier ya no puede interactuar con la página ni salir a otro host', async () => {
  for (const cmd of [`playwright-cli ${S4} click e12`, `playwright-cli ${S4} fill e3 hola`, `playwright-cli ${S4} goto https://example.com`, `playwright-cli ${S4} cookie-list`]) {
    for (const agente of ['browser-verifier', 'uaeh-harness:browser-verifier']) {
      const r = await cadenaDeHooksJson(cmd, { agente });
      assert.ok(r.negado, `${agente}: «${cmd}» debe quedar negado por la cadena de hooks.json`);
      assert.equal(r.hook, 'solo-navegador.js', `${agente}: lo niega el candado del navegador (${r.motivo.slice(0, 80)})`);
    }
  }
  const principal = await cadenaDeHooksJson(`playwright-cli ${S4} click e12`, { agente: null });
  assert.equal(principal.negado, false, 'la sesión principal no queda bajo el candado');
  const legitimo = await cadenaDeHooksJson(`playwright-cli ${S4} open http://127.0.0.1:4173 --config=${CFG_PLUGIN}`);
  assert.equal(legitimo.negado, false, `un open legítimo pasa toda la cadena: ${legitimo.hook} ${legitimo.motivo}`);
});

test('solo-lectura (el otro candado de browser-verifier) no niega ninguna de las formas permitidas aquí', { timeout: 300000 }, async () => {
  const filas = await enParalelo(A, async (cmd) => ({ cmd, r: await correr(cmd, { hook: LECTURA, sinSesion: true }) }));
  const chocan = filas.filter(({ r }) => r.deny).map(({ cmd, r }) => `${cmd}  =>  ${r.motivo.slice(0, 120)}`);
  assert.equal(chocan.length, 0, `solo-lectura niega formas permitidas por solo-navegador:\n  ${chocan.join('\n  ')}`);
});

// ── Módulo ────────────────────────────────────────────────────────────────────────────

test('el módulo expone tokenizar, revisar, Denegar y configsDeConfianza, y no ejecuta nada al cargarse', () => {
  const m = require(HOOK);
  assert.deepEqual(Object.keys(m).sort(), ['Denegar', 'configsDeConfianza', 'revisar', 'tokenizar']);
  assert.throws(() => m.revisar('playwright-cli -s=uaeh-a click e1', 'Bash'), m.Denegar);
  assert.doesNotThrow(() => m.revisar('git status', 'Bash'));
  assert.deepEqual(m.tokenizar("git log '--grep=a b'"), ['git', 'log', '--grep=a b']);
});

test('la plantilla de configuración de confianza es aislada, sin cabeza y sin acceso libre a archivos', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ_HARNESS, 'templates', 'playwright-cli.config.json'), 'utf8'));
  assert.equal(cfg.browser.isolated, true);
  assert.equal(cfg.browser.launchOptions.headless, true);
  assert.equal(cfg.allowUnrestrictedFileAccess, false);
  assert.equal(cfg.codegen, 'none');
});
