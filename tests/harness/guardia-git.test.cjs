// Pruebas de plugins/uaeh-harness/hooks/guardia-git.js: la guardia de texto (PreToolUse, Bash|PowerShell).
// Correr: node --test tests/harness/guardia-git.test.cjs
//
// Hermética: casa temporal (tests/helpers/entorno.cjs), repos temporales y un gitconfig global temporal CON la guarda de
// git del plugin (git-hooks/) o SIN ella (modo estricto). Nada toca la configuración real del usuario.
// Política de commits: la suite principal corre con commits.credito = prohibir y una firma de ejemplo (la conducta de un
// usuario que prohíbe el crédito de Claude); el bloque «política por defecto» cubre `permitir`, que es lo que trae el
// plugin sin configurar. El hook solo ANALIZA: nunca ejecuta el `git commit` que se le muestra.
// Los repos se crean al cargar el archivo; lo que modifica un repo entre una comprobación y otra va en una «secuencia»
// (una prueba que arma su propio repo). Cada `caso` corre la misma orden como Bash y como PowerShell.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, gitConfigGlobal, RAIZ_HARNESS, SECRETO_FALSO } = require('../helpers/entorno.cjs');

const HOOK = path.join(RAIZ_HARNESS, 'hooks', 'guardia-git.js');
const GUARDA = path.join(RAIZ_HARNESS, 'git-hooks');
const FIRMA = 'Authored By: ejemplo.com';
const MOTIVO_CREDITO_ESPERADO = 'Guardia UAEH: la política de commits de este usuario prohíbe el crédito de Claude. Quita esa línea y termina el mensaje con «' + FIRMA + '».';
// Margen de las pruebas de costo lineal (saltoGuarda con textos hostiles de 48 KB): un costo cuadrático tardaría segundos.
const LIMITE_LINEAL_MS = 1000;
const WIN = process.platform === 'win32';

const E = entornoTemporal('uaeh-guardia-git-');
process.on('exit', () => E.limpiar());
const RAIZ = E.dir;
// La capa de git (core.hooksPath global) NO depende de la configuración real de la máquina: la suite corre con un
// gitconfig global temporal SIN hooksPath (modo estricto) o CON la guarda del plugin (A = capa activa).
const CONFIG_SIN_CAPA = gitConfigGlobal(E);
const CONFIG_CON_CAPA = gitConfigGlobal(E, { hooksPath: GUARDA });
// Llave falsa armada por partes (la del helper) para que ESTE archivo no dispare la guardia del propio repo.
const AKIA = SECRETO_FALSO;
const VALOR_SECRETO = AKIA;

const ENV_GIT = { ...E.env, GIT_CONFIG_GLOBAL: CONFIG_SIN_CAPA };
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: ENV_GIT });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout;
}
let n = 0;
// Repo con un commit inicial; `stage` = archivos que quedan en el índice; `sucios` = rastreados sin stagear.
function repo({ stage = {}, sucios = {} } = {}) {
  const dir = path.join(RAIZ, 'r' + (n++));
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'hola\n');
  fs.writeFileSync(path.join(dir, 'track.txt'), 'uno\n');
  git(dir, 'add', 'base.txt', 'track.txt');
  git(dir, 'commit', '-q', '-m', 'inicial');
  for (const [f, c] of Object.entries(sucios)) fs.writeFileSync(path.join(dir, f), c);
  for (const [f, c] of Object.entries(stage)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
    git(dir, 'add', f);
  }
  return dir;
}

// Entorno del hook. opc.capa: gitconfig global CON la guarda del plugin (true) o sin ella (false, estricto).
// opc.politica: 'prohibir' (la de la suite principal: credito=prohibir + firma de ejemplo) o 'permitir' (la de defecto).
// opc.sinGuardaEsperada: no fija UAEH_GIT_HOOKS (la guarda esperada pasa a ser el espejo, que aquí no existe).
// opc.sinFirma: política prohibir sin firma configurada.
function envHook({ capa = false, politica = 'prohibir', sinGuardaEsperada = false, sinFirma = false } = {}) {
  const env = { ...E.env, GIT_CONFIG_GLOBAL: capa ? CONFIG_CON_CAPA : CONFIG_SIN_CAPA };
  delete env.UAEH_COMMIT_CREDITO; delete env.UAEH_COMMIT_FIRMA; delete env.UAEH_GIT_HOOKS;
  if (!sinGuardaEsperada) env.UAEH_GIT_HOOKS = GUARDA;
  if (politica === 'prohibir') { env.UAEH_COMMIT_CREDITO = 'prohibir'; if (!sinFirma) env.UAEH_COMMIT_FIRMA = FIRMA; }
  return env;
}

function correr(tool, command, cwd, opc) {
  const input = JSON.stringify({ tool_name: tool, tool_input: { command }, cwd, session_id: 't' });
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: envHook(opc), cwd: E.proyecto, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let deny = false, motivo = '';
  if ((r.stdout || '').trim()) {
    const o = JSON.parse(r.stdout);
    deny = o.hookSpecificOutput.permissionDecision === 'deny';
    motivo = o.hookSpecificOutput.permissionDecisionReason;
  }
  return { deny, motivo, status: r.status, ms, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// (ciclo 7) `esp` puede ser { Bash, PowerShell } cuando la respuesta depende de la herramienta; `extra(r, tool)`.
// Devuelve null si el caso se cumple en Bash y en PowerShell; si no, el texto del fallo (nunca el valor de un secreto).
function evaluar(nombre, esp, cmd, cwd, extra, opc) {
  const fallos = [];
  for (const tool of ['Bash', 'PowerShell']) {
    const e = typeof esp === 'object' ? esp[tool] : esp;
    const r = correr(tool, cmd, cwd, opc);
    if (!(r.status === 0 && r.deny === e && (!extra || extra(r, tool)))) {
      fallos.push(`[${tool}] ${e ? 'DENY ' : 'ALLOW'} ${nombre}  ->  status=${r.status} deny=${r.deny} motivo=${r.motivo}`);
    }
  }
  return fallos.length ? fallos.join('\n') : null;
}
// Un caso = una prueba. Los repos de `cwd` ya existen cuando corre (se crean al cargar) y el hook no los modifica.
function caso(nombre, esp, cmd, cwd, extra, opc) {
  test((typeof esp === 'object' ? 'POR HERRAMIENTA ' : esp ? 'DENY ' : 'ALLOW ') + nombre, () => {
    const f = evaluar(nombre, esp, cmd, cwd, extra, opc);
    assert.ok(!f, f);
  });
}
// Una secuencia = una prueba que arma su propio repo y encadena varios casos (entre uno y otro el repo cambia).
// Dentro, `caso` es la versión inmediata: acumula los fallos y la prueba los muestra todos al final.
function secuencia(nombre, fn) {
  test(nombre, () => {
    const fallos = [];
    fn((nom, esp, cmd, cwd, extra, opc) => { const f = evaluar(nom, esp, cmd, cwd, extra, opc); if (f) fallos.push(f); });
    assert.equal(fallos.length, 0, '\n' + fallos.join('\n'));
  });
}
// (ciclo 7, C4a) en PowerShell `bash`/`sh` sin la ruta de Git Bash es el de WSL: se niega con este motivo
const esWsl = (r) => /es el de WSL/.test(r.motivo);
const limpio = repo({ stage: { 'ok.txt': 'nada raro\n' } });
const otro = fs.mkdtempSync(path.join(RAIZ, 'otro-'));

// ---------- reglas 1-4 (no necesitan repo real)
caso('reset --hard', true, 'git reset --hard', limpio);
caso('reset --hard HEAD~1', true, 'git reset --hard HEAD~1', limpio);
caso('-C repo reset --hard', true, 'git -C /x reset --hard', limpio);
caso('reset --soft', false, 'git reset --soft HEAD~1', limpio);
caso('push --force', true, 'git push --force', limpio);
caso('push -f', true, 'git push -f origin main', limpio);
caso('push -uf', true, 'git push -uf origin main', limpio);
caso('push +main', true, 'git push origin +main', limpio);
caso('push --force-with-lease', true, 'git push --force-with-lease', limpio);
caso('push --force-with-lease=ref', true, 'git push --force-with-lease=main:abc origin main', limpio);
caso('push --force-if-includes', true, 'git push --force-if-includes', limpio);
caso('push origin main', false, 'git push origin main', limpio);
caso('push -u origin main', false, 'git push -u origin main', limpio);
// push forzado sin la palabra «force»: espejo y «+» por configuración (revisión independiente del 11-nov)
caso('pushforzado: push --mirror', true, 'git push --mirror origin', limpio);
caso('pushforzado: push --mir (prefijo)', true, 'git push --mir origin', limpio);
caso('pushforzado: -c remote.origin.push=+…', true, 'git -c remote.origin.push=+HEAD:refs/heads/main push origin', limpio);
caso('pushforzado: -c remote.origin.mirror=true', true, 'git -c remote.origin.mirror=true push origin', limpio);
caso('pushforzado: -c remote.origin.mirror (sin valor)', true, 'git -c remote.origin.mirror push origin', limpio);
caso('pushforzado: config remote.origin.push +…', true, 'git config remote.origin.push +HEAD:refs/heads/main', limpio);
caso('pushforzado: config --add remote.origin.push "+…"', true, 'git config --add remote.origin.push "+refs/heads/*:refs/heads/*"', limpio);
caso('pushforzado: config remote.origin.mirror true', true, 'git config remote.origin.mirror true', limpio);
caso('pushforzado: -c remote.origin.push sin «+» se permite', false, 'git -c remote.origin.push=HEAD:refs/heads/x push origin', limpio);
caso('pushforzado: -c remote.origin.mirror=false se permite', false, 'git -c remote.origin.mirror=false push origin', limpio);
caso('pushforzado: config remote.origin.push sin «+» se permite', false, 'git config remote.origin.push HEAD:refs/heads/x', limpio);
caso('pushforzado: leer remote.origin.push se permite', false, 'git config --get remote.origin.push', limpio);
caso('pushforzado: fetch con «+» en la configuración no es push', false, 'git -c remote.origin.fetch=+refs/heads/*:refs/remotes/origin/* fetch origin', limpio);
caso('pushforzado: borrar una rama remota se permite (residual declarado)', false, 'git push origin --delete rama-vieja', limpio);
caso('commit --no-verify', true, 'git commit --no-verify -m x', limpio);
caso('push --no-verify', true, 'git push --no-verify', limpio);
caso('commit -n -m x', true, 'git commit -n -m x', limpio);
caso('commit -nm x', true, 'git commit -nm x', limpio);
caso('commit -anm x', true, 'git commit -anm x', limpio);
// racimos de 5 y 8 letras con n: la búsqueda cruda (B20) solo mira racimos de hasta 3 letras antes y después de la n, así que
// aquí niega el análisis (regla 3b); sin esa regla pasarían
caso('commit -aaaan -m x (racimo de 5 letras: lo niega el analizador)', true, 'git commit -aaaan -m x', limpio, (r) => r.motivo.includes('git commit -n'));
caso('commit -aaaaaaan -m x (racimo de 8 letras: lo niega el analizador)', true, 'git commit -aaaaaaan -m x', limpio, (r) => r.motivo.includes('git commit -n'));
caso('clean -fd', true, 'git clean -fd', limpio);
caso('clean -xdf', true, 'git clean -xdf', limpio);
caso('clean --force', true, 'git clean --force', limpio);
caso('clean -n', false, 'git clean -n', limpio);
caso('encadenado && reset --hard', true, 'cd /tmp && git reset --hard', limpio);
caso('git -c k=v push -f', true, 'git -c core.x=1 push -f', limpio);
caso('git -C ruta push --force', true, 'git -C "/a b/c" push --force', limpio);
caso('bash -c reset --hard', true, 'bash -c "git reset --hard"', limpio);
caso('tubería | git push -f', true, 'echo x | git push -f', limpio);
caso('-c core.hooksPath=/dev/null commit', true, 'git -c core.hooksPath=/dev/null commit -m x', limpio, (r) => r.motivo.includes('core.hooksPath'));
caso('-c core.hookspath=x push', true, 'git -c core.hookspath=x push', limpio);
caso('-c user.name=x commit (limpio)', false, 'git -c user.name=x commit -m ok', limpio);
caso('-c commit.gpgsign=false commit (limpio)', false, 'git -c commit.gpgsign=false commit -m ok', limpio);
caso('git status', false, 'git status', limpio);
caso('git diff', false, 'git diff --stat', limpio);
caso('npm test', false, 'npm test', limpio);
caso('git log -n 5 (n no es commit)', false, 'git log -n 5', limpio);
caso('texto con git reset --hard en echo', false, 'echo "git reset --hard"', limpio);
// CAMBIADAS (ciclo 6, B20): el salto se busca en el texto CRUDO (también entre comillas: `'-n'`, `"-nm"`), así que un
// mensaje que hable literalmente de --no-verify o de «-n» se NIEGA: falso positivo ACEPTADO y declarado en el brief c6.
caso('commit -m con -n en el mensaje (falso positivo aceptado, c6)', true, 'git commit -m "usa -n para algo"', limpio);
caso('commit -m con --no-verify en el mensaje (falso positivo aceptado, c6)', true, 'git commit -m "no uses --no-verify ni push -f"', limpio);
caso('commit --message= con -n (falso positivo aceptado, c6)', true, 'git commit --message="usa -n y -f"', limpio);

// ---------- git commit: secretos y archivos
const rKey = repo({ stage: { 'src/cfg.js': 'const a = 1;\nconst k = "' + VALOR_SECRETO + '";\n' } });
caso('stage con llave AKIA', true, 'git commit -m x', rKey, (r) =>
  r.motivo.includes('src/cfg.js:2 (llave AWS)') && !r.motivo.includes(VALOR_SECRETO) && r.motivo.startsWith('Guardia UAEH: posible secreto en el commit'));

const rEnv = repo({ stage: { '.env': 'A=1\n' } });
caso('.env stageado', true, 'git commit -m x', rEnv, (r) => r.motivo.includes('.env') && !r.motivo.includes('A=1'));
const rEnv2 = repo({ stage: { 'app/.env.local': 'A=1\n' } });
caso('.env.local stageado', true, 'git commit -m x', rEnv2);
const rEx = repo({ stage: { '.env.example': 'A=\n' } });
caso('.env.example stageado', false, 'git commit -m x', rEx);
const rPem = repo({ stage: { 'k/server.pem': 'abc\n' } });
caso('*.pem stageado', true, 'git commit -m x', rPem);
const rRsa = repo({ stage: { 'id_rsa': 'abc\n' } });
caso('id_rsa stageado', true, 'git commit -m x', rRsa);
const rPfx = repo({ stage: { 'c.pfx': 'abc\n' } });
caso('*.pfx stageado', true, 'git commit -m x', rPfx);

// ---------- git commit: evidencias del navegador (/uae-visual) nunca van a git
const esEvidencia = (ruta) => (r) => r.motivo.startsWith('Guardia UAEH: el commit incluye evidencias del navegador') && r.motivo.includes(ruta);
const rCap = repo({ stage: { 'reports/visual-audit/20261015-1200/inicio-360.png': 'png\n' } });
caso('captura de reports/visual-audit stageada', true, 'git commit -m x', rCap, esEvidencia('reports/visual-audit/20261015-1200/inicio-360.png'));
caso('captura en subcarpeta (apps/web/reports/visual-audit)', true, 'git commit -m x',
  repo({ stage: { 'apps/web/reports/visual-audit/a.png': 'png\n' } }), esEvidencia('apps/web/reports/visual-audit/a.png'));
caso('.playwright-cli stageado', true, 'git commit -m x', repo({ stage: { '.playwright-cli/page-1.yml': 'x\n' } }), esEvidencia('.playwright-cli/page-1.yml'));
caso('test-results stageado', true, 'git commit -m x', repo({ stage: { 'test-results/visual/resultado.json': '{}\n' } }), esEvidencia('test-results/visual/resultado.json'));
caso('playwright-report stageado', true, 'git commit -m x', repo({ stage: { 'playwright-report/index.html': 'x\n' } }), esEvidencia('playwright-report/index.html'));
caso('storage-state stageado', true, 'git commit -m x', repo({ stage: { 'e2e/admin.storage-state.json': '{}\n' } }), esEvidencia('e2e/admin.storage-state.json'));
caso('auth-state stageado', true, 'git commit -m x', repo({ stage: { 'auth-state.json': '{}\n' } }), esEvidencia('auth-state.json'));
const rEvi = repo();
fs.writeFileSync(path.join(rEvi, '.gitignore'), 'reports/visual-audit/\n');
fs.mkdirSync(path.join(rEvi, 'reports', 'visual-audit'), { recursive: true });
fs.writeFileSync(path.join(rEvi, 'reports', 'visual-audit', 'x.png'), 'png\n');
caso('add -f de captura ignorada + commit en el mismo comando', true, 'git add -f reports/visual-audit/x.png && git commit -m x', rEvi, esEvidencia('reports/visual-audit/x.png'));
caso('add -A -f + commit con captura ignorada', true, 'git add -A -f && git commit -m x', rEvi, esEvidencia('reports/visual-audit/x.png'));
caso('baseline aprobada (tests/visual/*-snapshots) se permite', false, 'git commit -m baseline',
  repo({ stage: { 'tests/visual/visual.spec.ts-snapshots/inicio-movil-360-win32.png': 'png\n' } }));
caso('archivo "reports/visual-audit.md" (no es la carpeta) se permite', false, 'git commit -m x', repo({ stage: { 'docs/reports/visual-audit.md': 'x\n' } }));
caso('carpeta "my-test-results" no es evidencia', false, 'git commit -m x', repo({ stage: { 'my-test-results/a.txt': 'x\n' } }));

// rutas de evidencia añadidas (ronda de reparación): cada una negada por commit stageado, por `add -A` y por `add -f` de ignorada
const NUEVAS_EVI = ['.playwright-cli/page-x.yml', 'app/.playwright-cli/state.json', '.auth/user.json', 'e2e/.auth/admin.json', 'blob-report/report-1.zip',
  'red/captura.har', 'trace.zip', 'out/trace-home.zip', 'lighthouse/localhost_2026.report.html', 'lh/x.report.json', 'lh/x.report.csv'];
for (const ruta of NUEVAS_EVI) secuencia('evidencia nueva: ' + ruta + ' (stageada, add -A y add -f de ignorada)', (caso) => {
  caso('evidencia nueva stageada: ' + ruta, true, 'git commit -m x', repo({ stage: { [ruta]: 'x\n' } }), esEvidencia(ruta));
  const rN = repo();
  fs.mkdirSync(path.dirname(path.join(rN, ruta)), { recursive: true });
  fs.writeFileSync(path.join(rN, ruta), 'x\n');
  caso('evidencia nueva con git add -A && commit: ' + ruta, true, 'git add -A && git commit -m x', rN, esEvidencia(ruta));
  fs.writeFileSync(path.join(rN, '.gitignore'), path.dirname(ruta) === '.' ? ruta + '\n' : path.dirname(ruta) + '/\n');
  caso('evidencia nueva ignorada con git add -f && commit: ' + ruta, true, 'git add -f ' + ruta + ' && git commit -m x', rN, esEvidencia(ruta));
});
// A21 (ciclo 5): `.playwright/` NO es salida de evidencia (playwright-cli carga `.playwright/cli.config.json` por defecto)
caso('A21: .playwright/cli.config.json (configuración) se permite', false, 'git commit -m x', repo({ stage: { '.playwright/cli.config.json': '{}\n' } }));
caso('A21: app/.playwright/otro.json se permite', false, 'git commit -m x', repo({ stage: { 'app/.playwright/otro.json': '{}\n' } }));
caso('baseline en subcarpeta de snapshots sigue permitida', false, 'git commit -m b', repo({ stage: { 'tests/visual/home/home.spec.ts-snapshots/a-win32.png': 'png\n' } }));
caso('"trace.zip" como carpeta no es evidencia; "mytrace.zip" tampoco', false, 'git commit -m x', repo({ stage: { 'docs/mytrace.zip': 'x\n', 'docs/report.html': 'x\n' } }));
// >3001 nombres nuevos: la ruta de evidencia al final también se revisa (el tope solo es del escaneo de contenido)
secuencia('más archivos nuevos que el tope de escaneo de contenido (tres repos de ~3 000 archivos)', (caso) => {
  const rMuchos = repo();
  fs.mkdirSync(path.join(rMuchos, 'masa'), { recursive: true });
  for (let i = 0; i < 3100; i++) fs.writeFileSync(path.join(rMuchos, 'masa', 'f' + String(i).padStart(5, '0') + '.txt'), 'x\n');
  fs.mkdirSync(path.join(rMuchos, 'zz', 'reports', 'visual-audit'), { recursive: true });
  fs.writeFileSync(path.join(rMuchos, 'zz', 'reports', 'visual-audit', 'tarde.png'), 'png\n');
  caso('>3001 nombres nuevos: captura al final se niega', true, 'git add -A && git commit -m x', rMuchos, esEvidencia('zz/reports/visual-audit/tarde.png'));
  const rMuchosOk = repo();
  fs.mkdirSync(path.join(rMuchosOk, 'masa'), { recursive: true });
  for (let i = 0; i < 3100; i++) fs.writeFileSync(path.join(rMuchosOk, 'masa', 'f' + String(i).padStart(5, '0') + '.txt'), 'x\n');
  // Contrato nuevo (ronda 3): más archivos nuevos que el tope de CONTENIDO (3000) = commit demasiado grande → falla cerrado.
  caso('>3000 nombres nuevos sin evidencia: se niega (demasiado grande para revisar secretos)', true, 'git add -A && git commit -m x', rMuchosOk, (r) => /commit demasiado grande para revisar secretos: divídelo en commits más pequeños/.test(r.motivo));
  const rTope = repo();
  fs.mkdirSync(path.join(rTope, 'masa'), { recursive: true });
  for (let i = 0; i < 2999; i++) fs.writeFileSync(path.join(rTope, 'masa', 'f' + String(i).padStart(5, '0') + '.txt'), 'x\n');
  caso('2999 nombres nuevos sin evidencia se permite', false, 'git add -A && git commit -m x', rTope);
});

caso('commit limpio', false, 'git commit -m ok', limpio);
caso('commit limpio con -m "usa -n" (CAMBIADA c6, B20: falso positivo aceptado)', true, 'git commit -m "usa -n para algo"', limpio);

// -a con llave en archivo rastreado no stageado
const rSucio = repo({ sucios: { 'track.txt': 'uno\nclave ' + VALOR_SECRETO + '\n' } });
caso('commit -am con llave sin stagear', true, 'git commit -am x', rSucio, (r) => r.motivo.includes('track.txt:2'));
caso('commit sin -a con llave sin stagear', false, 'git commit -m x', rSucio);
caso('commit --all con llave sin stagear', true, 'git commit --all -m x', rSucio);

// otros patrones (cada uno en su repo, línea 1)
const OTROS = [
  ['sk-ant', 'x = "sk-ant-' + 'api03-' + 'A'.repeat(30) + '"'],
  ['sk- con dígito', 'k = sk-' + 'proj-' + 'abcdefghij1234567890abcdefgh'],
  ['Stripe', 'k = sk_' + 'live_' + 'a1b2c3d4e5f6g7h8i9j0'],
  ['llave privada', '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
  ['service_role + JWT', 'SERVICE_ROLE = "eyJ' + 'hbGciOiJIUzI1NiJ9.abc.def"'],
  ['GitHub', 'tok = gh' + 'p_' + 'a'.repeat(36)],
  ['Google', 'g = AI' + 'za' + 'A'.repeat(35)],
  ['Slack', 'x = xox' + 'b-' + '1234567890-abcdef'],
  // Armadas por partes: así ni la guarda de texto ni la de git ven una contraseña en ESTE archivo al commitearlo.
  ['password', 'pass' + 'word = "Sup3rS3creta"'],
  ['contraseña', 'contra' + "seña: 'MiClaveReal9'"],
];
for (const [nombre, linea] of OTROS) {
  const r = repo({ stage: { 'a.js': linea + '\n' } });
  caso('patrón ' + nombre, true, 'git commit -m x', r, (res) => res.motivo.includes('a.js:1'));
}
// no deben disparar
const SEGUROS = [
  ['sk- sin dígito', 'nombre = sk-' + 'abcdefghijklmnopqrstuvwxyzabc'],
  ['password example', 'password = "changeme123"'],
  ['password env', 'password = "${DB_PASS_VALUE}"'],
  ['password corta', 'password = "abc"'],
  ['service_role sin JWT', 'usa service_role en el servidor'],
  ['password test', 'password = "test-password-1"'],
];
for (const [nombre, linea] of SEGUROS) {
  const r = repo({ stage: { 'a.js': linea + '\n' } });
  caso('seguro: ' + nombre, false, 'git commit -m x', r);
}
// numeración de línea con varios hunks
{
  const base = Array.from({ length: 20 }, (_, i) => 'l' + (i + 1)).join('\n') + '\n';
  const r = repo({});
  fs.writeFileSync(path.join(r, 'multi.txt'), base);
  git(r, 'add', 'multi.txt'); git(r, 'commit', '-q', '-m', 'm');
  const nuevo = base.split('\n'); nuevo.splice(14, 0, 'k = "' + VALOR_SECRETO + '"'); nuevo[2] = 'cambio';
  fs.writeFileSync(path.join(r, 'multi.txt'), nuevo.join('\n'));
  git(r, 'add', 'multi.txt');
  caso('línea correcta tras varios hunks', true, 'git commit -m x', r, (res) => res.motivo.includes('multi.txt:15 ('));
}
// borrar un .env rastreado no debe disparar
{
  const r = repo({ stage: { '.env': 'A=1\n' } });
  git(r, 'commit', '-q', '-m', 'con env');
  git(r, 'rm', '-q', '.env');
  caso('commit que BORRA .env', false, 'git commit -m quitar', r);
}
// commit inicial sin HEAD
{
  const dir = path.join(RAIZ, 'sinhead'); fs.mkdirSync(dir); git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.js'), 'k = "' + VALOR_SECRETO + '"\n'); git(dir, 'add', 'a.js');
  caso('repo sin HEAD, secreto stageado', true, 'git commit -m x', dir);
  caso('repo sin HEAD, commit -am', true, 'git commit -am x', dir);
}
// no es repo → deja pasar
caso('carpeta que no es repo', false, 'git commit -m x', otro);

// ---------- crédito de Claude
caso('-m con Co-Authored-By Claude', true, 'git commit -m "x\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>"', limpio, (r) => r.motivo.includes('prohíbe el crédito de Claude') && r.motivo.includes(FIRMA));
caso('-m con noreply@anthropic.com', true, 'git commit -m "x noreply@anthropic.com"', limpio);
caso('-m con Generated with Claude Code', true, 'git commit -m "x 🤖 Generated with [Claude Code](https://claude.com)"', limpio);
caso('-m con Claude-Session:', true, 'git commit -m "x\nClaude-Session: abc"', limpio);
caso('-m minúsculas co-authored-by claude', true, "git commit -m 'co-authored-by:claude x'", limpio);
caso('heredoc con crédito', true, "git commit -F - <<'EOF'\nmensaje\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>\nEOF", limpio);
caso('heredoc $(cat) con crédito', true, "git commit -m \"$(cat <<'EOF'\nmensaje\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)\"", limpio);
caso('heredoc sin crédito (Authored By)', false, "git commit -m \"$(cat <<'EOF'\nmensaje\n\nAuthored By: ejemplo.com\nEOF\n)\"", limpio);
{
  const r = repo({ stage: { 'ok.txt': 'x\n' } });
  fs.writeFileSync(path.join(r, 'msg.txt'), 'hola\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  caso('-F archivo con crédito', true, 'git commit -F msg.txt', r);
  caso('--file= archivo con crédito', true, 'git commit --file=msg.txt', r);
  fs.writeFileSync(path.join(r, 'msg2.txt'), 'hola\n\nAuthored By: ejemplo.com\n');
  caso('-F archivo sin crédito', false, 'git commit -F msg2.txt', r);
}
caso('heredoc con "git reset --hard" en el cuerpo (texto)', false, "git commit -F - <<'EOF'\nexplicar git reset --hard y push -f\nEOF", limpio);

// ---------- resolución del repo: cd / -C / Set-Location (cwd apunta a OTRO directorio)
const rObj = repo({ stage: { 'src/x.js': 'k = "' + VALOR_SECRETO + '"\n' } });
const rutaCmd = rObj;
caso('cd "<repo>" && git commit', true, `cd "${rutaCmd}" && git commit -m ok`, otro, (r) => r.motivo.includes('src/x.js:1'));
caso('git -C "<repo>" commit', true, `git -C "${rutaCmd}" commit -m ok`, otro, (r) => r.motivo.includes('src/x.js:1'));
caso('Set-Location "<repo>"; git commit', true, `Set-Location "${rutaCmd}"; git commit -m ok`, otro, (r) => r.motivo.includes('src/x.js:1'));
caso('Push-Location "<repo>"; git commit', true, `Push-Location "${rutaCmd}"; git commit -m ok`, otro);
caso('cd relativo + git -C relativo', true, `cd "${path.dirname(rutaCmd)}" && git -C ${path.basename(rutaCmd)} commit -m ok`, otro);
caso('cd repo limpio y cwd con llave', false, `cd "${limpio}" && git commit -m ok`, rObj);
caso('cwd = repo con llave (sin cd)', true, 'git commit -m ok', rObj);
caso('cd a repo con llave con ruta Git Bash (/c/...)', process.platform === 'win32' ? true : true, process.platform === 'win32'
  ? `cd "/${rutaCmd[0].toLowerCase()}/${rutaCmd.slice(3).replace(/\\/g, '/')}" && git commit -m ok` : `cd "${rutaCmd}" && git commit -m ok`, otro);

// ---------- "git add ... && git commit" en un solo comando (el archivo NO está stageado al correr el hook)
secuencia('add && commit en un solo comando (el archivo no está stageado al correr el hook)', (caso) => {
  const ANT = 'sk-ant-' + 'api03-' + 'B'.repeat(30);
  // 1. add de archivo existente sin stagear, con AKIA
  const r1 = repo();
  fs.writeFileSync(path.join(r1, 'cfg.js'), 'const k = "' + VALOR_SECRETO + '";\n');
  caso('add cfg.js && commit (sin stagear, AKIA)', true, 'git add cfg.js && git commit -m x', r1, (r) => r.motivo.includes('cfg.js:1') && !r.motivo.includes(VALOR_SECRETO));
  caso('add -- cfg.js && commit', true, 'git add -- cfg.js && git commit -m x', r1);
  caso('git stage cfg.js && commit', true, 'git stage cfg.js && git commit -m x', r1);
  caso('add y commit en líneas separadas', true, 'git add cfg.js\ngit commit -m x', r1);
  // 2. add -A con archivo nuevo no rastreado con sk-ant
  const r2 = repo();
  fs.writeFileSync(path.join(r2, 'nuevo.txt'), 'linea\nx = "' + ANT + '"\n');
  caso('add -A && commit (nuevo con sk-ant)', true, 'git add -A && git commit -m x', r2, (r) => r.motivo.includes('nuevo.txt:2 (llave Anthropic)'));
  caso('add --all && commit', true, 'git add --all && git commit -m x', r2);
  // 3. add . con modificación rastreada con llave
  const r3 = repo({ sucios: { 'track.txt': 'uno\nclave ' + VALOR_SECRETO + '\n' } });
  caso('add . ; commit (rastreado modificado)', true, 'git add . ; git commit -m x', r3, (r) => r.motivo.includes('track.txt:2'));
  caso('add -u && commit (rastreado modificado)', true, 'git add -u && git commit -m x', r3);
  // add -u NO agrega no rastreados
  const r3b = repo();
  fs.writeFileSync(path.join(r3b, 'nuevo.txt'), 'k = "' + VALOR_SECRETO + '"\n');
  caso('add -u && commit con llave solo en no rastreado', false, 'git add -u && git commit -m x', r3b);
  // 4. add -f .env
  const r4 = repo();
  fs.writeFileSync(path.join(r4, '.env'), 'A=1\n');
  caso('add -f .env && commit', true, 'git add -f .env && git commit -m x', r4, (r) => r.motivo.includes('.env'));
  fs.writeFileSync(path.join(r4, '.gitignore'), '.env\n');
  git(r4, 'add', '.gitignore'); git(r4, 'commit', '-q', '-m', 'ign');
  caso('add -f . con .env ignorado', true, 'git add -f . && git commit -m x', r4, (r) => r.motivo.includes('.env'));
  caso('add -A con .env ignorado (no se agrega)', false, 'git add -A && git commit -m x', r4);
  // 5. archivo que no existe aún
  const r5 = repo();
  caso('add nuevo.js inexistente && commit', true, 'git add nuevo.js && git commit -m x', r5, (r) => r.motivo.includes('se crean en este mismo comando'));
  caso('crear + add + commit en un comando', true, 'echo "x" > nuevo.js && git add nuevo.js && git commit -m x', r5, (r) => r.motivo.includes('se crean en este mismo comando'));
  // add de archivo rastreado borrado: permitido
  const r5b = repo();
  fs.unlinkSync(path.join(r5b, 'track.txt'));
  caso('add de archivo rastreado borrado', false, 'git add track.txt && git commit -m x', r5b);
  // 6. limpio
  const r6 = repo();
  fs.writeFileSync(path.join(r6, 'limpio.js'), 'const a = 1;\n');
  caso('add limpio.js && commit', false, 'git add limpio.js && git commit -m x', r6);
  caso('add -A limpio && commit', false, 'git add -A && git commit -m x', r6);
  // 7. add docs/ con llave fuera de docs/
  const r7 = repo({ sucios: { 'track.txt': 'uno\nclave ' + VALOR_SECRETO + '\n' } });
  fs.mkdirSync(path.join(r7, 'docs')); fs.writeFileSync(path.join(r7, 'docs', 'a.md'), 'hola\n');
  fs.writeFileSync(path.join(r7, 'fuera.js'), 'k = "' + VALOR_SECRETO + '"\n');
  caso('add docs/ && commit (llave fuera de docs/)', false, 'git add docs/ && git commit -m x', r7);
  fs.writeFileSync(path.join(r7, 'docs', 'b.md'), 'k = "' + VALOR_SECRETO + '"\n');
  caso('add docs/ && commit (llave dentro de docs/)', true, 'git add docs/ && git commit -m x', r7, (r) => r.motivo.includes('docs/b.md:1'));
  // cd + add relativo, cwd en otro directorio
  caso('cd repo && add cfg.js && commit', true, 'cd "' + r1 + '" && git add cfg.js && git commit -m x', otro);
  caso('git -C repo add cfg.js && git -C repo commit', true, 'git -C "' + r1 + '" add cfg.js && git -C "' + r1 + '" commit -m x', otro);
  caso('Set-Location repo; git add -A; git commit', true, 'Set-Location "' + r2 + '"; git add -A; git commit -m x', otro);
  // add sin commit no se bloquea
  caso('solo git add (sin commit)', false, 'git add cfg.js', r1);
});

// ---------- Ronda 4 (R3-2): --pathspec-from-file / --pathspec-file-nul en add y commit
{
  const rP = repo();
  for (const c of [
    'git add --pathspec-from-file=lista.txt', 'git add --pathspec-from-file lista.txt', 'git add --pathspec-file-nul --pathspec-from-file=l.txt',
    'git add --pathspec-file-nul', 'git add --pathspec-from=l.txt', 'git add --pathspec-from-f=l.txt', 'git add --pathspec-file=nul', 'git add --paths=l', 'git add --path',
    'git stage --pathspec-from-file=l.txt', 'git -C . add --pathspec-from-file=l.txt', 'git add -A --pathspec-from-file=l.txt', 'git add -f --pathspec-from-file=-',
    'git commit --pathspec-from-file=l.txt -m x', 'git commit -m x --pathspec-from-file l.txt', 'git commit --pathspec-file-nul -m x', 'git commit --pathspec-from-file=- -m x',
    'git commit -m x --paths=l', 'echo hi && git add --pathspec-from-file=l.txt',
  ]) caso('pathspec-from-file negado: ' + c, true, c, rP, (r) => /pathspec-from-file/.test(r.motivo));
  for (const c of [
    'git add base.txt', 'git add -p', 'git add --patch', 'git commit -m "usa --pathspec-from-file en el texto"', "git commit -m 'no uses --pathspec-file-nul'",
    'git add -- --pathspec-from-file', 'git status',
  ]) caso('sin pathspec-from-file real: ' + c, false, c, rP);
}

// ---------- Ronda 4 (R3-3): líneas largas por ventanas y archivos nuevos de hasta 20 MiB
{
  const MiB = 1024 * 1024;
  const KEY = 'const k = "' + VALOR_SECRETO + '";';
  const relleno = (n) => 'x'.repeat(n);
  const texto = (bytes, llaveAlFinal) => { const lin = relleno(79) + '\n'; return lin.repeat(Math.floor(bytes / 80)) + (llaveAlFinal ? KEY + '\n' : ''); };
  const hallazgo = (arch, linea) => (r) => r.motivo.includes(arch + ':' + linea + ' (llave AWS)') && !r.motivo.includes(VALOR_SECRETO);

  // línea ≥ 200 000 caracteres con la llave al final (antes se saltaba la línea entera)
  const largaFin = relleno(300000) + ' ' + KEY;
  const rLargaStage = repo({ stage: { 'src/larga.js': largaFin + '\n' } });
  caso('línea de 300 000 con llave al final (stageada)', true, 'git commit -m x', rLargaStage, hallazgo('src/larga.js', 1));
  const rLargaNueva = repo({ sucios: { 'larga.js': 'a\n' + largaFin + '\n' } });
  caso('línea de 300 000 con llave al final (archivo nuevo, add -A)', true, 'git add -A && git commit -m x', rLargaNueva, hallazgo('larga.js', 2));
  // sin llave: sigue permitido
  const rLargaLimpia = repo({ stage: { 'src/larga.js': relleno(300000) + '\n' }, sucios: { 'otra.txt': relleno(300000) + '\n' } });
  caso('línea de 300 000 sin llave (stageada y nueva)', false, 'git add -A && git commit -m x', rLargaLimpia);
  // llave a caballo entre dos ventanas (fin de la primera ventana de 8192 chars)
  for (const pos of [8192 - 10, 8192 - 20, 2 * (8192 - 512) - 5, 8192 - 512 + 1]) {
    const rBorde = repo({ stage: { 'src/borde.js': relleno(pos) + VALOR_SECRETO + relleno(20000) + '\n' } });
    caso('llave cruzando el borde de ventana en pos ' + pos, true, 'git commit -m x', rBorde, hallazgo('src/borde.js', 1));
  }

  // archivo de texto NUEVO de 3 MiB con la llave (antes: > 2 MiB se saltaba)
  const rGrande = repo({ sucios: { 'grande.txt': texto(3 * MiB, true) } });
  caso('archivo de texto nuevo de 3 MiB con llave', true, 'git add -A && git commit -m x', rGrande, (r) => r.motivo.includes('grande.txt:') && r.motivo.includes('(llave AWS)') && !r.motivo.includes(VALOR_SECRETO));
  // binario de 3 MiB (NUL al inicio) sin llave: permitido
  const bin = Buffer.alloc(3 * MiB, 0x41); bin[100] = 0;
  const rBin = repo({ sucios: { 'datos.bin': bin } });
  caso('binario nuevo de 3 MiB sin llave', false, 'git add -A && git commit -m x', rBin);
  // RESIDUAL documentado: binario con llave y texto de más de 20 MiB no se escanean por contenido (gitleaks en /uae-security)
  const binLlave = Buffer.concat([Buffer.alloc(3 * MiB, 0), Buffer.from(KEY)]);
  caso('residual: binario nuevo con llave NO se escanea (lo cubre gitleaks)', false, 'git add -A && git commit -m x', repo({ sucios: { 'datos.bin': binLlave } }));

  // tiempos: archivo de 20 MiB y línea de 1 MB (el hook tiene timeout de 10 s). Cada prueba arma su propio repo.
  test('texto nuevo de ~20 MiB con llave: negado y en menos de 10 s', (t) => {
    const r20 = repo({ sucios: { 'enorme.txt': texto(20 * MiB - 200, true) } });
    const t20 = correr('Bash', 'git add -A && git commit -m x', r20);
    assert.ok(t20.deny && t20.motivo.includes('(llave AWS)'), t20.motivo);
    assert.ok(t20.ms < 10000, t20.ms.toFixed(0) + ' ms');
    t.diagnostic('hook con archivo nuevo de ~20 MiB (negado): ' + t20.ms.toFixed(0) + ' ms');
  });
  test('línea de 1 MB con llave stageada: negado y en menos de 10 s', (t) => {
    const r1m = repo({ stage: { 'src/uno.js': relleno(1000000) + KEY + '\n' } });
    const t1m = correr('Bash', 'git commit -m x', r1m);
    assert.ok(t1m.deny && t1m.motivo.includes('src/uno.js:1 (llave AWS)'), t1m.motivo);
    assert.ok(t1m.ms < 10000, t1m.ms.toFixed(0) + ' ms');
    t.diagnostic('hook con línea de 1 MB stageada (negado): ' + t1m.ms.toFixed(0) + ' ms');
  });
  test('línea de 1 MB con llave en archivo nuevo: negado y en menos de 10 s', (t) => {
    const r1mn = repo({ sucios: { 'uno.js': relleno(1000000) + KEY + '\n' } });
    const t1mn = correr('Bash', 'git add -A && git commit -m x', r1mn);
    assert.ok(t1mn.deny && t1mn.ms < 10000, t1mn.ms.toFixed(0) + ' ms ' + t1mn.motivo);
    t.diagnostic('hook con línea de 1 MB en archivo nuevo (negado): ' + t1mn.ms.toFixed(0) + ' ms');
  });
}

// ---------- Ronda 6: dos señales a más de 8 KiB, presupuesto de escaneo, alias por -c
{
  const MiB = 1024 * 1024;
  const SR = 'service' + '_role';
  const JWT = 'eyJ' + 'abcdefghijk.abc.def';
  const tipoJwt = (arch, linea) => (r) => r.motivo.includes(arch + ':' + linea + ' (JWT service_role)');
  const rCorta = repo({ stage: { 'src/sr.js': SR + ' ' + 'x'.repeat(9000) + ' ' + JWT + '\n' } });
  caso('service_role + 9 000 de relleno + JWT en línea corta', true, 'git commit -m x', rCorta, tipoJwt('src/sr.js', 1));
  const rLarga = repo({ stage: { 'src/srl.js': 'x'.repeat(100000) + SR + ' ' + 'x'.repeat(100000) + ' ' + JWT + ' ' + 'x'.repeat(100000) + '\n' } });
  caso('service_role + JWT dentro de una línea de 300 000', true, 'git commit -m x', rLarga, tipoJwt('src/srl.js', 1));
  const rSolo = repo({ stage: { 'src/solo.js': SR + ' ' + 'x'.repeat(300000) + '\n' } });
  caso('service_role sin JWT en línea de 300 000', false, 'git commit -m x', rSolo);

  // presupuesto: 4 archivos nuevos de texto de 18 MiB (72 MiB > 64 MiB) → negado, sin arriesgar el timeout
  test('4 archivos nuevos de 18 MiB: negado por presupuesto y en menos de 10 s', (t) => {
    const bloque = ('y'.repeat(79) + '\n').repeat(Math.floor(18 * MiB / 80));
    const rPres = repo({ sucios: { 'a1.txt': bloque, 'a2.txt': bloque, 'a3.txt': bloque, 'a4.txt': bloque } });
    const tp = correr('Bash', 'git add -A && git commit -m x', rPres);
    assert.ok(tp.deny && /demasiado grande para revisar secretos a tiempo/.test(tp.motivo), tp.motivo);
    assert.ok(tp.ms < 10000, tp.ms.toFixed(0) + ' ms');
    t.diagnostic('hook con 4 archivos nuevos de 18 MiB (negado por presupuesto): ' + tp.ms.toFixed(0) + ' ms');
  });

  caso('-c alias.zz=commit', true, 'git -c alias.zz=commit zz -m x', limpio, (r) => /alias/i.test(r.motivo));
  caso('-c ALIAS.zz=commit', true, 'git -c ALIAS.zz=commit zz -m x', limpio);
  caso('--config-env=alias.zz=VAR', true, 'git --config-env=alias.zz=VAR zz -m x', limpio, (r) => /alias/i.test(r.motivo));
  caso('--config-env alias.zz=VAR (separado)', true, 'git --config-env alias.zz=VAR zz -m x', limpio);
  caso('-calias.zz=commit (pegado)', true, 'git -calias.zz=commit zz -m x', limpio);
  caso('-c color.ui=always status (permitido)', false, 'git -c color.ui=always status', limpio);
}

// ---------- entradas raras
// FALLA CERRADO (UAEH F2 ciclo 2, punto 14): sin comando de texto se NIEGA; el texto vacío ("") sigue pasando
for (const [nom, crudo] of [['vacía', ''], ['no JSON', 'zzz'], ['JSON roto', '{"tool_input":{"command":'], ['sin command', '{}'], ['command no string', '{"tool_input":{"command":1}}'], ['command 123', '{"tool_input":{"command":123}}']]) {
  test('falla cerrado: entrada ' + nom, () => {
    const r = spawnSync(process.execPath, [HOOK], { input: crudo, encoding: 'utf8', env: envHook(), cwd: E.proyecto });
    let motivo = '';
    try { motivo = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason; } catch { /* sin salida */ }
    assert.ok(r.status === 0 && /falla cerrado/.test(motivo), r.stdout);
  });
}
test('entrada command vacío ("") pasa', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: '{"tool_input":{"command":""}}', encoding: 'utf8', env: envHook(), cwd: E.proyecto });
  assert.ok(r.status === 0 && r.stdout === '', r.stdout);
});

// ---------- presupuesto de tiempo (punto 15): el timeout de cada llamada a git nunca supera lo que queda
test('presupuesto: el hook exporta tiempoRestante y descuenta lo gastado', () => {
  const cargar = spawnSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(HOOK)});
    const T = m.PRESUPUESTO_TOTAL_MS;
    const r = [m.tiempoRestante(1000, 1000), m.tiempoRestante(1000, 4000), m.tiempoRestante(1000, 1000 + T + 500)];
    console.log(JSON.stringify({ T, r }));
  `], { input: '', encoding: 'utf8', env: envHook(), cwd: E.proyecto });
  let d = null;
  try { d = JSON.parse(cargar.stdout); } catch { /* el hook no exporta */ }
  assert.ok(d, 'el hook exporta tiempoRestante: ' + cargar.stdout + cargar.stderr);
  assert.ok(d.T < 10000 && d.T >= 8000, 'total < timeout duro de 10 s: ' + d.T);
  assert.equal(d.r[0], d.T, 'al inicio queda el total');
  assert.equal(d.r[1], d.T - 3000, 'descuenta lo gastado');
  assert.ok(d.r[2] < 0, 'agotado → no positivo (nunca más que el restante)');
});
test('presupuesto: ejecutarGit usa timeout = restante y el mensaje de tiempo es útil', () => {
  // el código de ejecutarGit usa lo que resta como timeout (no un 8000 fijo)
  const fuenteG = fs.readFileSync(HOOK, 'utf8');
  assert.ok(/timeout:\s*restante/.test(fuenteG) && !/timeout:\s*8000/.test(fuenteG));
  assert.ok(/git tardó más de \d+ s revisando el commit/.test(fuenteG.replace(/' \+ PRESUPUESTO_TOTAL_MS \/ 1000 \+ '/, '9')));
});

// ---------- falla cerrado (UAEH F2): copia del hook con una falla inyectada en analizar(), sin puertas traseras
test('falla cerrado: comando con git y hook roto → negado; sin git no lo toca', () => {
  const fuente = fs.readFileSync(HOOK, 'utf8');
  const marca = 'function analizar(cmd, ps, estado, completo, profundidad) {';
  assert.ok(fuente.includes(marca), 'el hook trae analizar()');
  const roto = path.join(RAIZ, 'guardia-rota.js');
  fs.writeFileSync(roto, fuente.replace(marca, "function analizar() { throw new Error('falla inyectada'); }\nfunction analizarOriginal(cmd, ps, estado, completo, profundidad) {"));
  const correrRoto = (command) => {
    const r = spawnSync(process.execPath, [roto], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: limpio, session_id: 't' }), encoding: 'utf8', env: envHook(), cwd: E.proyecto });
    let motivo = '';
    try { motivo = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason; } catch { /* sin salida */ }
    return { status: r.status, stdout: r.stdout, motivo };
  };
  const g = correrRoto('git status');
  assert.ok(g.status === 0 && /falla cerrado/.test(g.motivo), 'comando con git y hook roto → negado: ' + JSON.stringify(g));
  const sg = correrRoto('npm test');
  assert.ok(sg.status === 0 && sg.stdout === '', 'comando sin git → no lo toca: ' + JSON.stringify(sg));
});

// ---------- ciclo 3 (B1): archivo nuevo ilegible (permisos) → NEGAR con motivo concreto, sin contenido
// Windows: icacls /deny. POSIX: chmod 000 (como root el archivo seguiría legible: ahí la prueba no tiene sentido).
if (WIN || !(typeof process.getuid === 'function' && process.getuid() === 0)) {
  test('B1: archivo nuevo ilegible: negado con motivo concreto y sin el valor; legible sigue negado por la llave', () => {
    const rIl = repo({ sucios: { 'secreto-ilegible.txt': 'k = "' + VALOR_SECRETO + '"\n', 'otro.txt': 'nada\n' } });
    const ruta = path.join(rIl, 'secreto-ilegible.txt');
    const usuario = process.env.USERNAME;
    const poner = WIN ? () => spawnSync('icacls', [ruta, '/deny', usuario + ':(R)'], { encoding: 'utf8' }).status === 0 : () => { fs.chmodSync(ruta, 0); return true; };
    const quitar = WIN ? () => spawnSync('icacls', [ruta, '/remove:d', usuario], { encoding: 'utf8' }) : () => fs.chmodSync(ruta, 0o644);
    const fallos = [];
    const puesto = poner();
    try {
      let leible = true;
      try { fs.readFileSync(ruta); } catch { leible = false; }
      assert.ok(puesto && !leible, 'preparación: el archivo quedó realmente ilegible; puesto=' + puesto + ' leible=' + leible);
      const f = evaluar('B1: add -A && commit con archivo nuevo ilegible: negado con motivo concreto', true, 'git add -A && git commit -m x', rIl,
        (r) => r.motivo.includes('no se pudo leer secreto-ilegible.txt para revisar secretos (') && r.motivo.includes('repite el comando') && !r.motivo.includes(VALOR_SECRETO));
      if (f) fallos.push(f);
    } finally { quitar(); }
    const f2 = evaluar('B1: el mismo repo con el archivo ya legible (llave dentro) sigue negado por la llave', true, 'git add -A && git commit -m x', rIl, (r) => r.motivo.includes('secreto-ilegible.txt:1 (llave AWS)'));
    if (f2) fallos.push(f2);
    const rBorrado = repo({ sucios: { 'x.txt': 'nada\n' } });
    const f3 = evaluar('B1: archivo nuevo legible y limpio sigue permitido', false, 'git add -A && git commit -m x', rBorrado);
    if (f3) fallos.push(f3);
    assert.equal(fallos.length, 0, '\n' + fallos.join('\n'));
  });
}

// ---------- ciclo 3 (B4): UAEH_GUARDIA_PRESUPUESTO_MS solo BAJA el presupuesto; con presupuesto mínimo, mensaje de tiempo
{
  const rT = repo({ stage: { 'ok2.txt': 'nada raro\n' } });
  const conEnv = (valor, command) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: rT, session_id: 't' }), encoding: 'utf8', env: { ...envHook(), UAEH_GUARDIA_PRESUPUESTO_MS: valor }, cwd: E.proyecto });
    let motivo = '';
    try { motivo = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason; } catch { /* sin salida */ }
    return { status: r.status, motivo, stdout: r.stdout };
  };
  test('B4: presupuesto mínimo: commit real negado con el mensaje de TIEMPO (no el genérico)', () => {
    const t = conEnv('100', 'git commit -m x');
    assert.ok(t.status === 0 && /git tardó más de [\d.]+ s revisando el commit/.test(t.motivo), JSON.stringify(t));
    assert.ok(!/no se pudo revisar el commit/.test(t.motivo), t.motivo);
  });
  for (const v of ['abc', '-5', '0', '', 'NaN', 'Infinity']) {
    test('B4: valor inválido «' + v + '» se ignora (commit limpio pasa)', () => {
      const r = conEnv(v, 'git commit -m x');
      assert.ok(r.status === 0 && r.stdout === '', JSON.stringify(r));
    });
  }
  const total = (valor) => JSON.parse(spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(HOOK)}).PRESUPUESTO_TOTAL_MS))`], { encoding: 'utf8', env: { ...envHook(), UAEH_GUARDIA_PRESUPUESTO_MS: valor }, cwd: E.proyecto }).stdout);
  test('B4: 100 baja el total a 100; 99999 NO lo sube (queda 9000); una inválida deja 9000', () => {
    assert.equal(total('100'), 100);
    assert.equal(total('99999'), 9000);
    assert.equal(total('xyz'), 9000);
  });
}

// ---------- ciclo 3 (B5): carpeta del commit con variable (o inexistente) → NEGAR; ruta literal se revisa como siempre
{
  const rEnv = repo({ stage: { '.env': 'A=1\n' } });
  const rLit = repo({ stage: { '.env': 'A=1\n' } });
  const esCarpeta = (r) => /usa la ruta literal en cd \/ git -C/.test(r.motivo);
  caso('B5: cd $env:USERPROFILE\\... ; git commit -am → negado', true, 'cd $env:USERPROFILE\\Proyectos\\X; git commit -am x', rEnv, esCarpeta);
  caso('B5: git -C "$R" commit → negado', true, 'git -C "$R" commit -m x', rEnv, esCarpeta);
  caso('B5: cd $HOME/x && git commit → negado', true, 'cd $HOME/x && git commit -m x', rEnv, esCarpeta);
  caso('B5: cd "$(pwd)/sub" && git commit → negado', true, 'cd "$(pwd)/sub" && git commit -m x', rEnv, esCarpeta);
  caso('B5: cd %USERPROFILE%\\x && git commit → negado', true, 'cd %USERPROFILE%\\x && git commit -m x', rEnv, esCarpeta);
  caso('B5: cd con backtick → negado', true, 'cd `pwd` && git commit -m x', rEnv, esCarpeta);
  caso('B5: cd $R luego cd relativo y commit → sigue negado', true, 'cd $R && cd sub && git commit -m x', rEnv, esCarpeta);
  caso('B5: git -C carpeta inexistente commit → negado', true, 'git -C "' + path.join(RAIZ, 'no-existe-zz') + '" commit -m x', rEnv, esCarpeta);
  caso('B5: cd inexistente && commit → negado', true, 'cd "' + path.join(RAIZ, 'no-existe-zz') + '" && git commit -m x', rEnv, esCarpeta);
  caso('B5: con ruta literal y .env staged → se revisa y se niega por el .env', true, 'git -C "' + rLit + '" commit -m x', otro, (r) => r.motivo.includes('.env') && !esCarpeta(r));
  caso('B5: cd literal y .env staged → se revisa y se niega por el .env', true, 'cd "' + rLit + '" && git commit -m x', otro, (r) => r.motivo.includes('.env') && !esCarpeta(r));
  caso('B5: ruta literal de repo limpio se permite', false, 'git -C "' + limpio + '" commit -m x', otro);
  caso('B5: cd con variable pero git status (sin commit) se permite', false, 'cd $HOME/x && git status', rEnv);
  caso('B5: cd $R y luego cd absoluto literal limpio: ya no es dudoso', false, 'cd $R; cd "' + limpio + '"; git commit -m x', otro);
}

// ---------- ciclo 4 (B8): el commit debe usar el MISMO contexto git que el guardia revisa
{
  const sucio = repo({ stage: { '.env': 'A=1\n' } });   // destino REAL del commit (con .env en staging)
  const sucioG = sucio.split('\\').join('/');
  const rEnvC = repo({ stage: { '.env': 'A=1\n' } });   // cwd con .env (el guardia ve este si no sigue bien el comando)
  const limpioG = limpio.split('\\').join('/');
  const esRedir = (r) => /no se admite redirigir el repo\/índice\/árbol/.test(r.motivo) && /haz el commit desde la carpeta del repo/.test(r.motivo);
  const esCarpetaC4 = (r) => /no se puede saber en qué carpeta/.test(r.motivo);

  // opciones globales de git que redirigen
  caso('B8: --git-dir=… commit', true, `git --git-dir="${sucioG}/.git" commit -m x`, limpio, esRedir);
  caso('B8: --git-dir … (valor aparte) commit', true, `git --git-dir "${sucioG}/.git" commit -m x`, limpio, esRedir);
  caso('B8: --work-tree=… commit', true, `git --work-tree="${sucioG}" commit -m x`, limpio, esRedir);
  caso('B8: --bare commit', true, 'git --bare commit -m x', limpio, esRedir);
  caso('B8: --namespace=x commit', true, 'git --namespace=x commit -m x', limpio, esRedir);
  caso('B8: --exec-path=x commit', true, 'git --exec-path=/x commit -m x', limpio, esRedir);
  caso('B8: -c core.worktree=… commit', true, `git -c core.worktree="${sucioG}" commit -m x`, limpio, esRedir);
  caso('B8: -c core.bare=true commit', true, 'git -c core.bare=true commit -m x', limpio, esRedir);
  caso('B8: -c core.excludesFile=… commit', true, 'git -c core.excludesFile=/x commit -m x', limpio, esRedir);
  caso('B8: -c core.hooksPath=… commit (ya se negaba)', true, 'git -c core.hooksPath=/x commit -m x', limpio);
  // CAMBIADAS (ciclo 6, B20): siguen negadas, pero ahora las niega ANTES la búsqueda de saltos en el texto crudo
  // (--config-env / -c include.* / GIT_CONFIG_* junto a un commit) con el motivo de «saltarse la guarda».
  const esRedirOSalto = (r) => esRedir(r) || /está prohibido para el agente/.test(r.motivo);
  caso('B8: --config-env=core.worktree=V commit', true, 'git --config-env=core.worktree=V commit -m x', limpio, esRedirOSalto);
  caso('B8: -c include.path=… commit', true, 'git -c include.path=/x commit -m x', limpio, esRedirOSalto);
  caso('B8: -c core.fsmonitor=… commit', true, 'git -c core.fsmonitor=/x commit -m x', limpio, esRedir);
  caso('B8: -c core.WorkTree (mayúsculas) commit', true, 'git -c core.WorkTree=/x commit -m x', limpio, esRedir);
  caso('B8: --git-dir con status (sin commit) se permite', false, `git --git-dir="${sucioG}/.git" status`, limpio);
  caso('B8: -c core.worktree con log (sin commit) se permite', false, 'git -c core.worktree=/x log -1', limpio);
  caso('B8: --attr-source no esconde el subcomando commit', true, 'git --attr-source HEAD commit -m x', rEnvC, (r) => r.motivo.includes('.env'));

  // variables de entorno GIT_*
  for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT', 'GIT_NAMESPACE']) {
    caso(`B8: ${v}=… git commit (Bash)`, true, `${v}=${sucioG}/.git git commit -m x`, limpio, v === 'GIT_CONFIG_COUNT' ? esRedirOSalto : esRedir);
    caso(`B8: export ${v}=…; git commit`, true, `export ${v}='${sucioG}/.git'; git commit -m x`, limpio, v === 'GIT_CONFIG_COUNT' ? esRedirOSalto : esRedir);
  }
  caso('B8: env GIT_DIR=… git commit', true, `env GIT_DIR=${sucioG}/.git git commit -m x`, limpio, esRedir);
  caso('B8: PowerShell $env:GIT_DIR=…; git commit', true, `$env:GIT_DIR='${sucioG}/.git'; git commit -m x`, limpio, esRedir);
  caso('B8: PowerShell $env:GIT_INDEX_FILE =… (con espacios)', true, `$env:GIT_INDEX_FILE = "${sucioG}/idx"; git commit -m x`, limpio, esRedir);
  caso('B8: PowerShell Set-Item Env:GIT_WORK_TREE', true, `Set-Item Env:GIT_WORK_TREE '${sucioG}'; git commit -m x`, limpio, esRedir);
  caso('B8: [Environment]::SetEnvironmentVariable GIT_DIR', true, `[Environment]::SetEnvironmentVariable('GIT_DIR','${sucioG}/.git'); git commit -m x`, limpio, esRedir);
  caso('B8: cmd set GIT_DIR=…&& git commit', true, `cmd /c "set GIT_DIR=${sucioG}/.git&& git commit -m x"`, limpio, esRedir);
  caso('B8: GIT_DIR con git status (sin commit) se permite', false, `GIT_DIR=${sucioG}/.git git status`, limpio);
  caso('B8: GIT_AUTHOR_NAME=… git commit (inofensiva) se permite', false, 'GIT_AUTHOR_NAME=Ana GIT_COMMITTER_EMAIL=a@b.c git commit -m ok', limpio);

  // opciones de git commit que cambian el contenido sin que el guardia lo vea
  caso('B8: commit -i <ruta> (suma a lo ya stageado: .env) → negado', true, 'git commit -i base.txt -m x', rEnvC, (r) => r.motivo.includes('git commit -i'));
  caso('B8: commit --include <ruta> → negado', true, 'git commit --include base.txt -m x', rEnvC, (r) => r.motivo.includes('--include'));
  caso('B8: commit --incl <ruta> (prefijo) → negado', true, 'git commit --incl base.txt -m x', rEnvC);
  caso('B8: commit -ai → negado', true, 'git commit -ai -m x', limpio);
  const rTrozo = repo({ sucios: { 'track.txt': 'const k = "' + VALOR_SECRETO + '";\n' } });
  caso('B8: commit -p (trozos elegidos aparte) → negado', true, 'echo y | git commit -p -m x', rTrozo, (r) => r.motivo.includes('git commit -p'));
  caso('B8: commit --patch → negado', true, 'git commit --patch -m x', rTrozo, (r) => r.motivo.includes('--patch'));
  caso('B8: commit --interactive → negado', true, 'git commit --interactive -m x', rTrozo, (r) => r.motivo.includes('--interactive'));
  // -o/--only y -a SÍ se modelan (el guardia revisa `diff HEAD -- <rutas>`): no se niegan por ser opciones
  caso('B8: commit -o <ruta limpia> con .env stageado: solo va esa ruta → se permite', false, 'git commit -o base.txt -m x', rEnvC);
  caso('B8: commit --only <ruta limpia> con .env stageado → se permite', false, 'git commit --only base.txt -m x', rEnvC);
  caso('B8: commit -o .env → se revisa y se niega por el .env', true, 'git commit -o .env -m x', rEnvC, (r) => r.motivo.includes('.env') && !r.motivo.includes('git commit -o'));
  caso('B8: commit --only .env → se niega por el .env', true, 'git commit --only .env -m x', rEnvC, (r) => r.motivo.includes('.env'));
  caso('B8: commit -a con secreto sin stagear (se modela) → negado por el secreto', true, 'git commit -a -m x', rTrozo, (r) => r.motivo.includes('track.txt:1 (llave AWS)'));
  caso('B8: commit -m "texto con -i y --patch" se permite', false, 'git commit -m "usa -i o --patch si quieres"', limpio);

  // envoltorios con opciones: el valor de la opción NO es el programa
  caso('B8: env -u V git commit (con .env) → negado', true, 'env -u V git commit -m x', rEnvC, (r) => r.motivo.includes('.env'));
  caso('B8: env --unset=V git commit', true, 'env --unset=V git commit -m x', rEnvC, (r) => r.motivo.includes('.env'));
  caso('B8: env -i git commit', true, 'env -i git commit -m x', rEnvC, (r) => r.motivo.includes('.env'));
  caso('B8: env -u V A=1 git commit', true, 'env -u V A=1 git commit -m x', rEnvC, (r) => r.motivo.includes('.env'));
  caso('B8: env -C <dir> git commit → negado (carpeta que no se sigue)', true, `env -C "${sucioG}" git commit -m x`, limpio, esRedir);
  caso('B8: env --chdir=<dir> git commit', true, `env --chdir="${sucioG}" git commit -m x`, limpio, esRedir);
  caso('B8: env -S "git commit" se analiza', true, 'env -S "git commit -m x"', rEnvC, (r) => r.motivo.includes('.env'));
  caso('B8: sudo -u root git commit', true, 'sudo -u root git commit -m x', rEnvC, (r) => r.motivo.includes('.env'));
  caso('B8: timeout 5 git commit', true, 'timeout 5 git commit -m x', rEnvC, (r) => r.motivo.includes('.env'));
  caso('B8: nice -n 5 git commit', true, 'nice -n 5 git commit -m x', rEnvC, (r) => r.motivo.includes('.env'));
  caso('B8: find -exec git commit', true, "find . -maxdepth 0 -exec git commit -m x ';'", rEnvC, (r) => r.motivo.includes('.env'));
  caso('B8: env -u V git commit en repo limpio se permite', false, 'env -u V git commit -m ok', limpio);
  caso('B8: env -i git status se permite', false, 'env -i git status', limpio);
  caso('B8: timeout 5 git status se permite', false, 'timeout 5 git status', limpio);

  // cambios de carpeta que el guardia no puede seguir (misma regla que B5)
  caso('B8: pushd <lit>; popd; git commit (cwd con .env) → negado', true, `pushd "${limpioG}"; popd; git commit -m x`, rEnvC, esCarpetaC4);
  caso('B8: cd <lit>; cd -; git commit → negado', true, `cd "${limpioG}"; cd -; git commit -m x`, rEnvC, esCarpetaC4);
  caso('B8: cd <lit>; cd (sin argumento = HOME); git commit → negado', true, `cd "${limpioG}"; cd; git commit -m x`, rEnvC, esCarpetaC4);
  caso('B8: Push-Location; Pop-Location; git commit → negado', true, `Push-Location "${limpioG}"; Pop-Location; git commit -m x`, rEnvC, esCarpetaC4);
  caso('B8: Set-Location -; git commit → negado', true, `Set-Location "${limpioG}"; Set-Location -; git commit -m x`, rEnvC, esCarpetaC4);
  caso('B8: sl -; git commit → negado', true, `sl "${limpioG}"; sl -; git commit -m x`, rEnvC, esCarpetaC4);
  caso('B8: popd suelto antes del commit → negado', true, 'popd; git commit -m x', rEnvC, esCarpetaC4);
  caso('B8: popd y luego cd absoluto literal: ya se sabe dónde', false, `popd; cd "${limpioG}"; git commit -m x`, rEnvC);
  caso('B8: pushd <lit> y commit (limpio) se permite', false, `pushd "${limpioG}"; git commit -m x`, rEnvC);
  caso('B8: pushd <lit> con .env → se revisa y se niega por el .env', true, `pushd "${sucioG}"; git commit -m x`, limpio, (r) => r.motivo.includes('.env') && !esCarpetaC4(r));
  caso('B8: cd <lit> y commit (limpio) se permite', false, `cd "${limpioG}"; git commit -m x`, rEnvC);
  caso('B8: cd - sin commit se permite', false, 'cd -; git status', rEnvC);
  caso('B8: popd sin commit se permite', false, 'popd; git status', rEnvC);
}

// ---------- ciclo 4 (B9): lo que el guardia no puede analizar → falla cerrado
{
  const rEnvC = repo({ stage: { '.env': 'A=1\n' } });
  const esNoAnaliz = (r) => /no puede analizar/.test(r.motivo);
  // anidar `n` veces sh -c "…" (con el escape de comillas de una shell)
  const envolver = (s) => 'sh -c "' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const anidar = (cmd, n) => { let s = cmd; for (let i = 0; i < n; i++) s = envolver(s); return s; };
  // CAMBIADA (ciclo 7, C4a; uae-security c6 SEC-003): en PowerShell `sh`/`bash` es el lanzador de WSL → se niega por WSL.
  caso('B9: git commit anidado 2 niveles (se analiza) → negado por .env', true, anidar('git commit -m x', 2), rEnvC, (r, tool) => (tool === 'PowerShell' ? esWsl(r) : r.motivo.includes('.env')));
  caso('B9: git commit anidado 3 niveles → negado por .env', true, anidar('git commit -m x', 3), rEnvC, (r, tool) => (tool === 'PowerShell' ? esWsl(r) : r.motivo.includes('.env')));
  caso('B9: git commit anidado 5 niveles (supera el límite) → negado', true, anidar('git commit -m x', 5), rEnvC, (r, tool) => (tool === 'PowerShell' ? esWsl(r) : esNoAnaliz(r)));
  caso('B9: git commit anidado 8 niveles → negado', true, anidar('git commit -m x', 8), rEnvC, (r, tool) => (tool === 'PowerShell' ? esWsl(r) : esNoAnaliz(r)));
  caso('B9: git status anidado 6 niveles: menciona git y no se puede analizar → negado', true, anidar('git status', 6), limpio, esNoAnaliz);
  caso('B9: eval "git commit"', true, 'eval "git commit -m x"', rEnvC, (r) => r.motivo.includes('.env'));
  caso('B9: eval \'git commit\' en comillas simples', true, "eval 'git commit -m x'", rEnvC, (r) => r.motivo.includes('.env'));
  caso('B9: eval con variable ($c) y git commit en el texto', true, 'c="git commit -m x"; eval "$c"', rEnvC, esNoAnaliz);
  caso('B9: eval $(…) con git commit en el texto', true, 'eval "$(echo git) commit -m x"', rEnvC);
  caso('B9: iex "git commit"', true, 'iex "git commit -m x"', rEnvC, (r) => r.motivo.includes('.env'));
  caso('B9: Invoke-Expression \'git commit\'', true, "Invoke-Expression 'git commit -m x'", rEnvC, (r) => r.motivo.includes('.env'));
  caso('B9: iex $c con git commit en el texto', true, '$c = "git commit -m x"; iex $c', rEnvC, esNoAnaliz);
  caso('B9: eval "git status" se permite', false, 'eval "git status"', limpio);
  caso('B9: iex "git status" se permite', false, 'iex "git status"', limpio);
  caso('B9: source de un script con git commit en el texto', true, 'printf "git commit -m x" > run.sh; source ./run.sh', rEnvC, esNoAnaliz);
  caso('B9: ". ./script" con git commit en el texto', true, 'printf "git commit -m x" > run.sh; . ./run.sh', rEnvC, esNoAnaliz);
  caso('B9: sh <archivo> con git commit en el texto', true, 'printf "git commit -m x" > run.sh; sh run.sh', rEnvC, esNoAnaliz);
  caso('B9: bash <archivo> escrito por heredoc en el mismo comando', true, 'cat > run.sh <<EOF\ngit commit -m x\nEOF\nbash run.sh', rEnvC, esNoAnaliz);
  caso('B9: bash <<heredoc (el cuerpo no se ve)', true, "bash <<'EOF'\ngit commit -m x\nEOF", rEnvC, esNoAnaliz);
  caso('B9: echo "git commit" | sh (entrada estándar)', true, 'echo "git commit -m x" | sh', rEnvC, esNoAnaliz);
  caso('B9: powershell -File con git commit en el texto', true, "'git commit -m x' | Out-File run.ps1; powershell -File run.ps1", rEnvC, esNoAnaliz);
  const b64 = (s) => Buffer.from(s, 'utf16le').toString('base64');
  caso('B9: powershell -EncodedCommand se decodifica y se analiza', true, 'powershell -NoProfile -EncodedCommand ' + b64('git commit -m x'), rEnvC, (r) => r.motivo.includes('.env'));
  caso('B9: powershell -enc (abreviado)', true, 'pwsh -enc ' + b64('git commit -m x'), rEnvC, (r) => r.motivo.includes('.env'));
  caso('B9: powershell -ec (abreviado)', true, 'pwsh -ec ' + b64('git commit -m x'), rEnvC, (r) => r.motivo.includes('.env'));
  caso('B9: -EncodedCommand de un git status se permite', false, 'powershell -EncodedCommand ' + b64('git status'), limpio);
  caso('B9: programa dado por variable ($g commit)', true, '$g = "git"; $g commit -m x', rEnvC, esNoAnaliz);
  caso('B9: & $g commit (PowerShell)', true, "$g = 'git'; & $g commit -m x", rEnvC, esNoAnaliz);
  caso('B9: asignación $x = 5 junto a un commit limpio se permite', false, '$x = 5; git commit -m ok', limpio);
  caso('B9: bash scripts/build.sh sin commit se permite', false, 'bash scripts/build.sh && git status', limpio);
  caso('B9: powershell -File verify.ps1 sin commit se permite', false, 'powershell -File scripts/verify.ps1; git status', limpio);
  caso('B9: bash -c "git status" se permite', false, 'bash -c "git status"', limpio);
}

// ---------- ciclo 5 (B15): DOS CAPAS. Con la capa de git ACTIVA lo que el texto no puede analizar se permite (git lo revisa);
// INACTIVA = conducta estricta de siempre. Saltarse la guarda se niega en AMBOS modos.
{
  const rEnvB = repo({ stage: { '.env': 'A=1\n' } });
  const rLimpio = repo({ stage: { 'ok.txt': 'nada raro\n' } });
  const A = (nombre, esp, cmd, cwd, extra, opc) => caso('[ACTIVA] ' + nombre, esp, cmd, cwd, extra, { ...opc, capa: true });
  const I = (nombre, esp, cmd, cwd, extra, opc) => caso('[INACTIVA] ' + nombre, esp, cmd, cwd, extra, { ...opc, capa: false });
  const AI = (nombre, esp, cmd, cwd, extra) => { A(nombre, esp, cmd, cwd, extra); I(nombre, esp, cmd, cwd, extra); };
  const esNoAn = (r) => /no puede analizar/.test(r.motivo);
  const esSalto = (r) => /está prohibido para el agente/.test(r.motivo);

  // ---- capaGitActiva(): el hooksPath GLOBAL efectivo debe ser la carpeta de la guarda esperada: UAEH_GIT_HOOKS o, si no
  // está fijada, el espejo <UAEH_HOME>/estable/uaeh-harness/git-hooks (lib/config.cjs rutaGitHooks). Rutas normalizadas.
  // Formas aceptadas: Windows C:/…, C:\… y ~/… · POSIX /… y ~/….
  const SCRIPT_CAPA = E.escribir('capa.cjs', "const g = require(process.argv[2]);\nconsole.log(String(g.capaGitActiva(process.argv[3] || undefined)));\n");
  const aBarras = (p) => p.split(path.sep).join('/');
  const CUATRO = ['prepare-commit-msg', 'pre-applypatch', 'commit-msg', 'applypatch-msg'];
  const carpetaConHooks = (dir, hooks = CUATRO) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const h of hooks) fs.writeFileSync(path.join(dir, h), '#!/bin/sh\nexit 0\n');
    return dir;
  };
  // 'true' | 'false': lo que dice capaGitActiva(dir) con ese gitconfig global y esa guarda esperada (null = sin UAEH_GIT_HOOKS).
  const capaGit = (gc, { guarda = GUARDA, dir = E.proyecto } = {}) => {
    const entorno = { ...E.env, GIT_CONFIG_GLOBAL: gc };
    delete entorno.UAEH_GIT_HOOKS;
    if (guarda) entorno.UAEH_GIT_HOOKS = guarda;
    return spawnSync(process.execPath, [SCRIPT_CAPA, HOOK, dir], { encoding: 'utf8', env: entorno, cwd: E.proyecto }).stdout.trim();
  };
  const activa = (valor, opciones) => {
    const gc = path.join(RAIZ, 'gc-' + (n++));
    fs.writeFileSync(gc, valor === null ? '[user]\n\tname = t\n' : '[core]\n\thooksPath = ' + valor.split('\\').join('\\\\') + '\n');
    return capaGit(gc, opciones) === 'true';
  };
  const real = GUARDA;
  test('capaGitActiva: ruta de la guarda con /', () => assert.ok(activa(aBarras(real))));
  test('capaGitActiva: ruta de la guarda con barra final', () => assert.ok(activa(aBarras(real) + '/')));
  if (WIN) {
    test('capaGitActiva (Windows): con \\ y mayúsculas distintas', () => assert.ok(activa(real.toUpperCase().split('/').join('\\'))));
    test('capaGitActiva (Windows): forma C:\\… con barras invertidas', () => assert.ok(activa(real.split('/').join('\\'))));
    // CAMBIADA (ciclo 6, B21; uae-security c5 SEC-003): la forma Git Bash /c/… el git nativo NO la entiende → INACTIVA
    test('capaGitActiva (Windows): forma Git Bash /c/… → INACTIVA (el git nativo no la entiende)', () =>
      assert.ok(!activa(real.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).split(path.sep).join('/'))));
  } else {
    test('capaGitActiva (POSIX): ruta absoluta /… → ACTIVA', () => assert.ok(path.isAbsolute(real) && activa(real)));
    if (process.platform === 'linux') {
      test('capaGitActiva (Linux): mayúsculas distintas → INACTIVA (el sistema de archivos las distingue)', () => assert.ok(!activa(real.toUpperCase())));
    }
  }
  test('capaGitActiva: forma ~/… (la guarda esperada vive bajo la casa)', () => {
    const guarda = carpetaConHooks(path.join(E.home, 'mi-guarda'));
    assert.ok(activa('~/mi-guarda', { guarda }));
    if (WIN) assert.ok(activa('~\\mi-guarda', { guarda }), 'forma ~\\…');
  });
  test('capaGitActiva: un include.path del archivo global que cambia core.hooksPath → INACTIVA', () => { // B21 (Codex c5 SEC-004)
    const incluido = path.join(RAIZ, 'gc-incluido-' + (n++));
    fs.writeFileSync(incluido, '[core]\n\thooksPath = ' + aBarras(path.join(RAIZ, 'otros-hooks')) + '\n');
    const gc = path.join(RAIZ, 'gc-' + (n++));
    fs.writeFileSync(gc, '[core]\n\thooksPath = ' + aBarras(real) + '\n[include]\n\tpath = ' + aBarras(incluido) + '\n');
    assert.equal(capaGit(gc), 'false');
  });
  test('capaGitActiva: exige prepare-commit-msg, pre-applypatch, commit-msg y applypatch-msg', () => { // B21
    const gh = carpetaConHooks(path.join(RAIZ, 'guarda-incompleta'), ['pre-commit', 'commit-msg']);
    assert.ok(!activa(aBarras(gh), { guarda: gh }), 'faltan prepare-commit-msg/pre-applypatch/applypatch-msg → INACTIVA');
    carpetaConHooks(gh, ['prepare-commit-msg', 'pre-applypatch', 'applypatch-msg']);
    assert.ok(activa(aBarras(gh), { guarda: gh }), 'con los cuatro que revisan → ACTIVA');
  });
  test('capaGitActiva: sin hooksPath → inactiva', () => assert.ok(!activa(null)));
  test('capaGitActiva: otra carpeta → inactiva', () => assert.ok(!activa(aBarras(path.join(RAIZ, 'otros-hooks')))));
  test('capaGitActiva: ruta relativa → inactiva', () => assert.ok(!activa('git-hooks')));
  test('capaGitActiva: carpeta hermana con el mismo prefijo → inactiva', () => assert.ok(!activa(aBarras(real) + '-x')));
  test('capaGitActiva: sin UAEH_GIT_HOOKS la guarda esperada es el espejo <UAEH_HOME>/estable/uaeh-harness/git-hooks', () => {
    const espejo = carpetaConHooks(path.join(E.uaehHome, 'estable', 'uaeh-harness', 'git-hooks'));
    assert.ok(activa(aBarras(espejo), { guarda: null }), 'el espejo con los cuatro hooks → ACTIVA');
    assert.ok(!activa(aBarras(real), { guarda: null }), 'la guarda del plugin no es la esperada si UAEH_GIT_HOOKS no la fija → INACTIVA');
    assert.ok(!activa(aBarras(espejo), { guarda: GUARDA }), 'con UAEH_GIT_HOOKS apuntando a otra carpeta, el espejo ya no cuenta → INACTIVA');
  });
  // la capa «activa» de OTRA carpeta no relaja nada: lo que el texto no puede analizar sigue negándose (estricto)
  A('[la guarda esperada es otra] bash scripts/verify.sh && git commit sigue estricto', true, 'bash scripts/verify.sh && git commit -m x', rLimpio, esNoAn, { sinGuardaEsperada: true });

  // ---- fricción a quitar con la capa ACTIVA (y qué pasa sin ella)
  // CAMBIADA (ciclo 7, C4a; uae-security c6 SEC-003): en PowerShell `sh`/`bash` es el lanzador de WSL → sin -c nunca se relaja.
  A('bash scripts/verify.sh && git commit', { Bash: false, PowerShell: true }, 'bash scripts/verify.sh && git commit -m x', rLimpio, (r, tool) => tool === 'Bash' || esNoAn(r));
  I('bash scripts/verify.sh && git commit', true, 'bash scripts/verify.sh && git commit -m x', rLimpio, esNoAn);
  A('pwsh -File scripts/verify.ps1 && git commit', false, 'pwsh -File scripts/verify.ps1 && git commit -m x', rLimpio);
  A('powershell -NoProfile -File scripts/verify.ps1; git commit', false, 'powershell -NoProfile -File scripts/verify.ps1; git commit -m x', rLimpio);
  I('powershell -NoProfile -File scripts/verify.ps1; git commit', true, 'powershell -NoProfile -File scripts/verify.ps1; git commit -m x', rLimpio, esNoAn);
  A('mensaje con el literal GIT_INDEX_FILE=', false, 'git commit -m "documenta GIT_INDEX_FILE=x"', rLimpio);
  I('mensaje con el literal GIT_INDEX_FILE= (estricto)', true, 'git commit -m "documenta GIT_INDEX_FILE=x"', rLimpio);
  AI('$env:GIT_REDIRECT_STDERR = \'2>&1\'; git commit (benigna en ambos modos)', false, "$env:GIT_REDIRECT_STDERR = '2>&1'; git commit -m x", rLimpio);
  AI('GIT_REDIRECT_STDERR=2>&1 git commit (Bash)', false, 'GIT_REDIRECT_STDERR=2>&1 git commit -m x', rLimpio);
  A('git commit -m x; $LASTEXITCODE', false, 'git commit -m x; $LASTEXITCODE', rLimpio);
  A('git commit -m x; $?', false, 'git commit -m x; $?', rLimpio);
  A('$msg | git commit -F -', false, '$msg | git commit -F -', rLimpio);
  A('$files | ForEach-Object { git add $_ }; git commit', false, '$files | ForEach-Object { git add $_ }; git commit -m x', rLimpio);
  // CAMBIADA (ciclo 7, C4a; uae-security c6 SEC-003): en PowerShell `sh`/`bash` es el lanzador de WSL → sin -c nunca se relaja.
  A('git commit -m x && bash scripts/publicar.sh', { Bash: false, PowerShell: true }, 'git commit -m x && bash scripts/publicar.sh', rLimpio, (r, tool) => tool === 'Bash' || esNoAn(r));
  A('source venv/bin/activate && git commit', false, 'source venv/bin/activate && git commit -m x', rLimpio);
  A('mensaje "docs: usar GIT_DIR=x en CI"', false, 'git commit -m "docs: usar GIT_DIR=x en CI"', rLimpio);
  A('GIT_SHA=abc; git commit -m "$GIT_SHA"', false, 'GIT_SHA=abc; git commit -m "$GIT_SHA"', rLimpio);
  A('GIT_LFS_SKIP_SMUDGE=1 git commit', false, 'GIT_LFS_SKIP_SMUDGE=1 git commit -m x', rLimpio);
  A('opciones -i / -p / --interactive / --include (las revisa git)', false, 'git commit -i base.txt -m x', rLimpio);
  A('carpeta con variable (cd $X; git commit)', false, 'cd $X; git commit -m x', rLimpio);
  A('eval "$c" con git commit', false, 'c="git commit -m x"; eval "$c"', rLimpio);
  A('$g = git; $g commit', false, '$g = "git"; $g commit -m x', rLimpio);
  A('GIT_DIR=… git commit (lo ve git)', false, 'GIT_DIR=/x/.git git commit -m x', rLimpio);
  A('env -C <dir> git commit', false, 'env -C /x git commit -m x', rLimpio);
  A('git --git-dir=… commit', false, 'git --git-dir=/x/.git --work-tree=/x commit -m x', rLimpio);
  A('--pathspec-from-file en commit y add', false, 'git add --pathspec-from-file=lista.txt && git commit --pathspec-from-file=lista.txt -m x', rLimpio);
  I('--pathspec-from-file (estricto)', true, 'git commit --pathspec-from-file=lista.txt -m x', rLimpio);
  { const env = (s) => 'sh -c "' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; let q = 'git commit -m x'; for (let i = 0; i < 5; i++) q = env(q); /* CAMBIADA (ciclo 7, C4a): en PowerShell sh = WSL */ A('anidado 5 niveles con git commit', { Bash: false, PowerShell: true }, q, rLimpio, (r, tool) => tool === 'Bash' || esWsl(r)); I('anidado 5 niveles con git commit (estricto)', true, q, rLimpio, (r, tool) => (tool === 'PowerShell' ? esWsl(r) : esNoAn(r))); }

  // ---- lo que el texto SÍ ve sigue negando con la capa activa
  A('.env stageado + commit sigue negado (mensaje temprano)', true, 'git commit -m x', rEnvB, (r) => r.motivo.includes('.env'));
  // CAMBIADA (ciclo 7, C4a; uae-security c6 SEC-003): en PowerShell `sh`/`bash` es el lanzador de WSL → sin -c nunca se relaja (motivo «no analizable»).
  A('bash verify.sh && git commit con .env stageado (segmento analizable) sigue negado', true, 'bash scripts/verify.sh && git commit -m x', rEnvB, (r, tool) => (tool === 'PowerShell' ? esNoAn(r) : r.motivo.includes('.env')));
  A('crédito de Claude en el comando', true, 'git commit -m "x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"', rLimpio, (r) => r.motivo === MOTIVO_CREDITO_ESPERADO);
  A('reset --hard sigue negado', true, 'git reset --hard', rLimpio);
  A('push --force sigue negado', true, 'git push --force', rLimpio);
  A('clean -fd sigue negado', true, 'git clean -fd', rLimpio);
  A('reset --hard dentro de texto no analizable junto a un commit', true, '$g reset --hard; git commit -m x', rLimpio, esSalto);
  A('push -f dentro de texto no analizable junto a un commit', true, 'source x.sh; git push -f origin main; git commit -m x', rLimpio, esSalto);

  // ---- saltarse la guarda: SIEMPRE negado (ambos modos)
  AI('--no-verify', true, 'git commit --no-verify -m x', rLimpio, esSalto);
  AI('commit -n', true, 'git commit -n -m x', rLimpio, esSalto);
  AI('commit -nm (racimo)', true, 'git commit -nm x', rLimpio, esSalto);
  AI('commit -anm (racimo)', true, 'git commit -anm x', rLimpio, esSalto);
  AI('-c core.hooksPath=…', true, 'git -c core.hooksPath=/dev/null commit -m x', rLimpio, esSalto);
  AI('--config-env=core.hooksPath=V', true, 'git --config-env=core.hooksPath=V commit -m x', rLimpio, esSalto);
  AI('git config core.hooksPath <valor> (escritura)', true, 'git config core.hooksPath /dev/null', rLimpio, esSalto);
  AI('git config --global core.hooksPath <valor>', true, 'git config --global core.hooksPath /dev/null', rLimpio, esSalto);
  AI('git config --global --unset core.hooksPath', true, 'git config --global --unset core.hooksPath', rLimpio, esSalto);
  AI('git config --global --unset-all core.hooksPath', true, 'git config --global --unset-all core.hooksPath', rLimpio, esSalto);
  AI('git config --global --replace-all core.hooksPath x', true, 'git config --global --replace-all core.hooksPath x', rLimpio, esSalto);
  AI('git config --global --remove-section core', true, 'git config --global --remove-section core', rLimpio, esSalto);
  AI('git config set core.hooksPath x', true, 'git config set --global core.hooksPath x', rLimpio, esSalto);
  AI('git config --global include.path x', true, 'git config --global include.path /x/otro.cfg', rLimpio, esSalto);
  AI('GIT_CONFIG_GLOBAL=/dev/null git commit', true, 'GIT_CONFIG_GLOBAL=/dev/null git commit -m x', rLimpio);
  AI('export GIT_CONFIG_GLOBAL=…; git commit', true, "export GIT_CONFIG_GLOBAL='/dev/null'; git commit -m x", rLimpio);
  AI('$env:GIT_CONFIG_GLOBAL=…; git commit', true, "$env:GIT_CONFIG_GLOBAL = 'NUL'; git commit -m x", rLimpio);
  for (const v of ['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS']) {
    AI(v + '=… git commit', true, `${v}=1 git commit -m x`, rLimpio);
  }
  A('GIT_CONFIG_GLOBAL en texto no analizable con commit (motivo de salto)', true, 'bash run.sh; GIT_CONFIG_GLOBAL=/dev/null git commit -m x', rLimpio, esSalto);
  A('-c core.hooksPath en texto no analizable con commit', true, 'source x.sh; git -c core.hooksPath=/dev/null commit -m x', rLimpio, esSalto);
  A('--no-verify dentro de eval con variable', true, 'c="git commit --no-verify -m x"; eval "$c"', rLimpio, esSalto);
  A('commit -n por programa en variable', true, '$g = "git"; $g commit -n -m x', rLimpio, esSalto);
  A('git config core.hooksPath dentro de un script no analizable junto a commit', true, 'source x.sh; git config --global core.hooksPath /dev/null; git commit -m x', rLimpio, esSalto);
  // lecturas de core.hooksPath pasan
  AI('git config --get core.hooksPath (lectura)', false, 'git config --get core.hooksPath', rLimpio);
  AI('git config --global --get core.hooksPath (lectura)', false, 'git config --global --get core.hooksPath', rLimpio);
  AI('git config --local --get core.hooksPath (lectura)', false, 'git config --local --get core.hooksPath', rLimpio);
  AI('git config core.hooksPath (clave sola = lectura)', false, 'git config core.hooksPath', rLimpio);
  AI('git config --global --list', false, 'git config --global --list', rLimpio);
  AI('git config --get-regexp hooks', false, 'git config --get-regexp hooks', rLimpio);
  AI('git config get core.hooksPath', false, 'git config get core.hooksPath', rLimpio);
  AI('git config user.name x (otra clave) se permite', false, 'git config user.name x', rLimpio);

  // ---- el inventario de solo lectura que el guardia negó (el texto traía `.pre-commit-config.yaml` → «commit»): pasa en AMBOS modos
  AI('inventario con .pre-commit-config.yaml (sin commit)', false,
    'find /c/proyectos/x -maxdepth 3 -name ".pre-commit-config.yaml" -o -name .git | while read g; do r=$(dirname "$g"); git -C "$r" config --local --get core.hooksPath; ls "$g/hooks"; done', rLimpio);
  AI('palabra commit solo dentro de un nombre de archivo (sin commit)', false, 'bash -c "echo pre-commit-config" && source venv/bin/activate && git status', rLimpio);
  AI('bash scripts/lint-commit.sh sin git commit', false, 'bash scripts/commit-lint.sh && git status', rLimpio);

  // ---- corrección barata (ambos modos): opciones con valor, redirecciones, comentarios y llaves NO son rutas
  AI('--trailer "X: y" no es una ruta (limpio)', false, 'git commit -m x --trailer "Reviewed-by: A"', rLimpio);
  AI('--trailer con .env stageado: se niega por el .env, no por la ruta', true, 'git commit -m x --trailer "Reviewed-by: A"', rEnvB, (r) => r.motivo.includes('.env'));
  AI('--unified=1', false, 'git commit -m x --unified=1', rLimpio);
  AI('-U3 / -U 3', false, 'git commit -m x -U 3', rLimpio);
  AI('--inter-hunk-context 2', false, 'git commit -m x --inter-hunk-context 2', rLimpio);
  AI('2>&1 (limpio)', false, 'git commit -m x 2>&1', rLimpio);
  AI('2>&1 con .env stageado se niega (no se toma como ruta)', true, 'git commit -m x 2>&1', rEnvB, (r) => r.motivo.includes('.env'));
  AI('>/dev/null 2>&1 con .env stageado se niega', true, 'git commit -m x >/dev/null 2>&1', rEnvB, (r) => r.motivo.includes('.env'));
  AI('> archivo con .env stageado se niega', true, 'git commit -m x > salida.txt', rEnvB, (r) => r.motivo.includes('.env'));
  AI('*> $null con .env stageado se niega', true, 'git commit -m x *> $null', rEnvB, (r) => r.motivo.includes('.env'));
  AI('2>$null con .env stageado se niega', true, 'git commit -m x 2>$null', rEnvB, (r) => r.motivo.includes('.env'));
  AI('# nota con .env stageado se niega', true, 'git commit -m x # nota', rEnvB, (r) => r.motivo.includes('.env'));
  AI('# nota (limpio)', false, 'git commit -m x # nota', rLimpio);
  AI('{ git commit -m x; } con .env stageado se niega', true, '{ git commit -m x; }', rEnvB, (r) => r.motivo.includes('.env'));
  AI('(git commit -m x) con .env stageado se niega', true, '(git commit -m x)', rEnvB, (r) => r.motivo.includes('.env'));
  AI('$(git commit) con .env stageado se niega', true, 'out=$(git commit)', rEnvB, (r) => r.motivo.includes('.env'));
  AI('f() { git commit -m x; }; f con .env', true, 'f() { git commit -m x; }; f', rEnvB, (r) => r.motivo.includes('.env'));
  AI('& { git commit -m x } con .env', true, '& { git commit -m x }', rEnvB, (r) => r.motivo.includes('.env'));
  AI('el # dentro de comillas NO es comentario (ruta con #)', false, 'git add "#x.txt" && git status', rLimpio);
  AI('git status 2>&1 # comentario', false, 'git status 2>&1 # comentario', rLimpio);

  // ---- ciclo 6 (B20/B20b): saltarse la guarda en el texto CRUDO, en ambos modos, dentro de cualquier construcción
  AI('python -c subprocess.run([git,commit,-n])', true, `python -c "import subprocess; subprocess.run(['git','commit','-n','-m','x'])"`, rLimpio, esSalto);
  AI('python -c con --no-verify', true, `python -c "import subprocess; subprocess.run(['git','commit','--no-verify','-m','x'])"`, rLimpio, esSalto);
  AI('node -e con --no-verify', true, `node -e "require('child_process').execSync('git commit --no-verify -m x')"`, rLimpio, esSalto);
  AI('Write-Host (git commit -n)', true, 'Write-Host (git commit -n -m x)', rLimpio, esSalto);
  AI('ForEach-Object { git commit --no-verify }', true, '1 | ForEach-Object { git commit --no-verify -m x }', rLimpio, esSalto);
  AI("commit '-n' entre comillas", true, "git commit '-n' -m x", rLimpio, esSalto);
  AI('commit "-nm" entre comillas', true, 'git commit "-nm" x', rLimpio, esSalto);
  AI('commit -m x,-n tras coma', true, 'git commit -m x,-n', rLimpio, esSalto);
  AI('git config alias.ci "commit --no-verify"', true, 'git config alias.ci "commit --no-verify"', rLimpio, esSalto);
  AI('git config --global alias.ci commit', true, 'git config --global alias.ci commit', rLimpio, esSalto);
  AI('python con -c core.hooksPath', true, `python -c "import subprocess; subprocess.run(['git','-c','core.hooksPath=/x','commit','-m','x'])"`, rLimpio, esSalto);
  AI('GIT_CONFIG_ (cualquier variable)', true, 'GIT_CONFIG_LO_QUE_SEA=1 git status', rLimpio, esSalto);
  AI('HOME= junto a un commit', true, 'HOME=/tmp/x git commit -m x', rLimpio, esSalto);
  AI('export HOME junto a un commit', true, 'export HOME=/tmp/x; git commit -m x', rLimpio, esSalto);
  AI('$env:HOME = junto a un commit', true, '$env:HOME = "C:\\x"; git commit -m x', rLimpio, esSalto);
  AI('$env:USERPROFILE = junto a un commit', true, '$env:USERPROFILE = "C:\\x"; git commit -m x', rLimpio, esSalto);
  AI('XDG_CONFIG_HOME= junto a un commit (B20b)', true, 'XDG_CONFIG_HOME=/tmp/x git commit -m x', rLimpio, esSalto);
  AI('-c include.path junto a un commit', true, 'git -c include.path=/x/otro.cfg commit -m x', rLimpio, esSalto);
  AI('-c includeIf. junto a un commit', true, 'git -c includeIf.gitdir:/x/.path=/y commit -m x', rLimpio, esSalto);
  AI('--config-env junto a un commit', true, 'git --config-env=user.name=V commit -m x', rLimpio, esSalto);
  AI('-c alias.x=commit (texto crudo)', true, `python -c "import subprocess; subprocess.run(['git','-c','alias.zz=commit','zz','-m','x'])"`, rLimpio, esSalto);
  AI('setx GIT_CONFIG_GLOBAL (persistente, sin git)', true, 'setx GIT_CONFIG_GLOBAL C:\\x', rLimpio, esSalto);
  AI('[Environment]::SetEnvironmentVariable(GIT_CONFIG_…) (persistente)', true, "[Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', 'x', 'User')", rLimpio, esSalto);
  AI('escribir CHERRY_PICK_HEAD a mano', true, 'git stash && git rev-parse stash > .git/CHERRY_PICK_HEAD', rLimpio, esSalto);
  A('wsl git commit nunca se relaja', true, 'wsl git commit -m x', rLimpio);
  A('wsl -e git commit nunca se relaja', true, 'wsl -e git commit -m x', rLimpio);
  {
    const enc = Buffer.from('git commit --no-verify -m x', 'utf16le').toString('base64');
    AI('-EncodedCommand con --no-verify', true, 'powershell -NoProfile -EncodedCommand ' + enc, rLimpio, esSalto);
  }
  // lo que NO es saltarse la guarda sigue pasando
  AI('git commit && git log -n 3 (otro segmento)', false, 'git commit -m x && git log -n 3', rLimpio);
  AI('git log -n 3', false, 'git log -n 3', rLimpio);
  AI('git commit --amend --no-edit', false, 'git commit --amend --no-edit', rLimpio);
  AI('git -C <carpeta> status (la C mayúscula no es -c)', false, 'git -C alias.d status', rLimpio);
  AI('git rev-parse MERGE_HEAD (lectura)', false, 'git rev-parse MERGE_HEAD', rLimpio);
  AI('$env:HOME leído (no asignado) sin commit', false, 'cd $env:HOME; git status', rLimpio);
  AI('setx de otra variable', false, 'setx MI_VAR 1', rLimpio);
  test('B20: saltoGuarda con 6 textos hostiles de 48 KB tarda < ' + LIMITE_LINEAL_MS + ' ms cada uno (búsqueda cruda lineal)', () => { // lineal: sin costo cuadrático
    const codigo = `const g=require(${JSON.stringify(HOOK)});const c=${JSON.stringify({
      a: 'git config --get core.hooksPath '.repeat(1500), b: 'git ' + 'cp '.repeat(16000), c: 'setx '.repeat(9600),
      d: 'git ' + 'commit '.repeat(6800), e: 'git ' + 'config '.repeat(6800), f: 'git commit ' + 'export '.repeat(6800) })};
      const out={};for(const k in c){const t0=process.hrtime.bigint();g.saltoGuarda(c[k]);out[k]=Number(process.hrtime.bigint()-t0)/1e6;}console.log(JSON.stringify(out));`;
    const guion = path.join(RAIZ, 'tiempo-crudo.cjs'); // archivo: la línea de comandos de Windows no admite 250 KB
    fs.writeFileSync(guion, codigo);
    const r = spawnSync(process.execPath, [guion], { encoding: 'utf8', env: envHook() });
    let t = {};
    try { t = JSON.parse(r.stdout); } catch { /* sin salida */ }
    const lentos = Object.entries(t).filter(([, ms]) => ms >= LIMITE_LINEAL_MS);
    assert.ok(Object.keys(t).length === 6 && !lentos.length, String(r.stdout) + String(r.stderr).slice(0, 200));
  });
  // ---- ciclo 7 (C1): `git am -n` / prefijos de --no-verify desde --no-v, en el texto CRUDO, ambos modos
  for (const cmd of ['git am -n x.patch', 'git am -qn x.patch', 'git am -3n x.patch', "git am '-n' x.patch", 'git am "-n" x.patch',
    'git am -3 -n x.patch', 'git am -n --continue', 'git -C r am -n x.patch',
    `python -c "import subprocess; subprocess.run(['git','am','-n','x.patch'])"`,
    `node -e "require('child_process').execFileSync('git',['am','-3','-n','x.patch'])"`,
    'Write-Host (git am -n x.patch)', '1 | ForEach-Object { git am -n x.patch }']) {
    AI('C1 am -n: ' + cmd, true, cmd, rLimpio, esSalto);
  }
  for (const pre of ['--no-v', '--no-ve', '--no-ver', '--no-veri', '--no-verif']) {
    AI('C1 prefijo ' + pre + ' en commit', true, 'git commit ' + pre + ' -m x', rLimpio, esSalto);
    AI('C1 prefijo ' + pre + ' en am', true, 'git am ' + pre + ' x.patch', rLimpio, esSalto);
    AI('C1 prefijo ' + pre + ' dentro de python -c', true, `python -c "import subprocess; subprocess.run(['git','commit','${pre}','-F','msg.txt'])"`, rLimpio, esSalto);
    AI('C1 prefijo ' + pre + ' dentro de Write-Host (…)', true, 'Write-Host (git commit ' + pre + ' -F msg.txt)', rLimpio, esSalto);
  }
  AI("C1 prefijo '--no-ver' entre comillas (python am)", true, `python -c "import subprocess; subprocess.run(['git','am','--no-ver','cambio.patch'])"`, rLimpio, esSalto);
  // en merge / rebase / pull / cherry-pick `-n` NO es no-verify (--no-stat / --no-commit): pasan
  AI('C1 control: git merge -n otra', false, 'git merge -n otra', rLimpio);
  AI('C1 control: git rebase -n main', false, 'git rebase -n main', rLimpio);
  AI('C1 control: git pull -n', false, 'git pull -n', rLimpio);
  AI('C1 control: git cherry-pick -n abc123', false, 'git cherry-pick -n abc123', rLimpio);
  AI('C1 control: git am x.patch (sin -n)', false, 'git am x.patch', rLimpio);
  AI('C1 control: git am --abort', false, 'git am --abort', rLimpio);
  AI('C1 control: git log --no-walk (no es --no-v…)', false, 'git log --no-walk -1', rLimpio);
  AI('C1 control: --no-verbose completo no se confunde', false, 'git commit --no-verbose -m x', rLimpio);

  // ---- ciclo 7 (C3): lecturas puras fuera de B20; `commit`/`am` pegados a `=` no son el subcomando
  for (const [nom, cmd] of [
    ["rg -n 'no-verify' hooks/guardia-git.js", "rg -n 'no-verify' hooks/guardia-git.js"],
    ["rg -n 'hooksPath' hooks/guardia-git.js", "rg -n 'hooksPath' hooks/guardia-git.js"],
    ["rg -n 'GIT_CONFIG_' hooks/guardia-git.js", "rg -n 'GIT_CONFIG_' hooks/guardia-git.js"],
    ['grep -il hookspath …/.git/config', 'grep -il hookspath /c/proyectos/x/r/.git/config'],
    ['grep -n no-verify hooks/guardia-git.js 2>/dev/null | head -5', 'grep -n no-verify hooks/guardia-git.js 2>/dev/null | head -5'],
    ['cat hooks/guardia-git.js | grep -c no-verify', 'cat hooks/guardia-git.js | grep -c no-verify'],
    ["Select-String -Pattern 'no-verify' -Path hooks\\guardia-git.js", "Select-String -Pattern 'no-verify' -Path hooks\\guardia-git.js"],
    ['findstr /n no-verify hooks\\guardia-git.js 2>$null', 'findstr /n no-verify hooks\\guardia-git.js 2>$null'],
    ['git log --grep=commit -n 5', 'git log --grep=commit -n 5'],
    ['git log --format="commit %H" -n 3', 'git log --format="commit %H" -n 3'],
    ['git log --grep=am -n 2', 'git log --grep=am -n 2'],
    ['git config --global --get core.hooksPath; echo "hooksPath revisado"', 'git config --global --get core.hooksPath; echo "hooksPath revisado"'],
    ['git config --global --get core.hooksPath || echo "sin hooksPath"', 'git config --global --get core.hooksPath || echo "sin hooksPath"'],
    ['git config --global --get core.hooksPath; Write-Host "hooksPath revisado"', 'git config --global --get core.hooksPath; Write-Host "hooksPath revisado"'],
  ]) AI('C3 pasa: ' + nom, false, cmd, rLimpio);
  for (const [nom, cmd] of [
    ["rg --pre 'x' 'no-verify' hooks/guardia-git.js", "rg --pre 'x' 'no-verify' hooks/guardia-git.js"],
    ['rg --pre=sh no-verify hooks/guardia-git.js', 'rg --pre=sh no-verify hooks/guardia-git.js'],
    ["rg --pre-glob '*.js' no-verify hooks/guardia-git.js", "rg --pre-glob '*.js' no-verify hooks/guardia-git.js"],
    ['rg --hostname-bin x no-verify hooks/guardia-git.js', 'rg --hostname-bin x no-verify hooks/guardia-git.js'],
    ['rg no-verify * (comodín: un archivo --pre=… se expandiría) con guardia-git', 'rg no-verify * hooks/guardia-git.js'],
    ['grep no-verify hooks/guardia-git.js | sh', 'grep no-verify hooks/guardia-git.js | sh'],
    ["grep 'a;git commit --no-verify' f", "grep 'a;git commit --no-verify' f"],
    ['grep no-verify f; git commit --no-verify -m x', 'grep no-verify f; git commit --no-verify -m x'],
    ['grep no-verify $(git commit --no-verify -m x)', 'grep no-verify $(git commit --no-verify -m x)'],
    ['grep con comilla invertida', 'grep no-verify `git commit --no-verify -m x`'],
    ['grep no-verify <(git commit --no-verify -m x)', 'grep no-verify <(git commit --no-verify -m x)'],
    ['Select-String no-verify (git commit --no-verify -m x)', 'Select-String no-verify (git commit --no-verify -m x)'],
    ['Get-Content -Path { git commit --no-verify -m x } (enlace diferido)', 'ls | Get-Content -Path { git commit --no-verify -m x }'],
    ['cat x | xargs git commit --no-verify', 'cat x | xargs git commit --no-verify'],
    ['grep no-verify f > salida (escritura) con guardia-git', 'grep no-verify hooks/guardia-git.js > salida.txt'],
    ['Get-Content f | Set-Content g con no-verify y git', 'Get-Content hooks/guardia-git.js | Set-Content no-verify.txt'],
    ['grep -r $X no-verify (variable que puede meter opciones)', 'rg $X no-verify hooks/guardia-git.js'],
    ['ls; git commit -n -m x', 'ls; git commit -n -m x'],
    ['cat f && git config --global core.hooksPath /x', 'cat f && git config --global core.hooksPath /x'],
    ['echo hooksPath | sh (impresor con tubería)', 'echo "git config --global core.hooksPath /x" | sh'],
    ['echo "hooksPath" > .git/x junto a git', 'echo "hooksPath" > notas.txt; git status'],
    ['eval grep … ; git commit -n', 'eval "grep x f"; git commit -n -m x'],
    ['heredoc de documentación con --no-verify (cat <<EOF)', 'cat <<EOF\ngit commit --no-verify\nEOF'],
  ]) AI('C3 NIEGA: ' + nom, true, cmd, rLimpio, esSalto);
  // escribir el archivo de configuración de git desde el shell (prueba del encargo `cat x > .git/config`)
  for (const cmd of ['cat x > .git/config', 'cat x >> ~/.gitconfig', 'echo "[core]" >> ~/.config/git/config', 'Get-Content x | Set-Content .git\\config',
    'Get-Content x | Out-File -FilePath $HOME\\.gitconfig', 'cp evil.cfg .git/config', 'Copy-Item evil.cfg -Destination ~/.gitconfig',
    'cp evil/config .git/', 'tee -a .git/config < x', 'printf "x" > .git/config.worktree']) {
    AI('C3 NIEGA escribir la configuración de git: ' + cmd, true, cmd, rLimpio, esSalto);
  }
  AI('C3 control: cat .git/config (lectura)', false, 'cat .git/config', rLimpio);
  AI('C3 lado seguro: cp .git/config <respaldo> también se niega (fricción aceptada: el corte no distingue origen y destino)', true, 'cp .git/config /tmp/respaldo', rLimpio);
  AI('C3 control: git config user.name x', false, 'git config user.name x', rLimpio);

  // ---- ciclo 7b (V-001 = SEC-008/009): un CR suelto separa sentencias en PowerShell 5.1 (medido). Se niega en ambos
  // modos y en ambas herramientas (en Bash el CR no separa: negar de más es el lado seguro).
  const CR = '\r';
  for (const cmd of [
    'Get-Content f' + CR + 'git commit --no-verify -m x',
    'cat f' + CR + 'git commit -n -m x',
    'Select-String x f' + CR + 'git config --global core.hooksPath C:/x',
    'ls' + CR + 'git -c core.hooksPath=NUL commit -m x',
    'ls' + CR + 'git config --global core.hooksPath NUL',
    'cat f' + CR + 'git config --global --unset core.hooksPath',
    'type f' + CR + 'git -c alias.x=commit x -m y',
    'gc f' + CR + 'git am -n p.patch',
    'git status' + CR + 'git reset --hard',
    'cat f' + CR + 'git push --force origin main',
    'ls' + CR + 'git clean -fdx',
    // el comentario `#` de PowerShell termina en el CR (medido: `# nota<CR>Write-Output dos` imprime «dos»)
    '# nota' + CR + 'git reset --hard',
    '# nota' + CR + 'git push --force origin main',
  ]) AI('7b CR suelto NIEGA: ' + JSON.stringify(cmd), true, cmd, rLimpio, esSalto);
  AI('7b CR suelto dentro de -EncodedCommand NIEGA', true,
    'powershell -NoProfile -EncodedCommand ' + Buffer.from('cat f' + CR + 'git reset --hard', 'utf16le').toString('base64'), rLimpio, esSalto);
  // controles que ya negaban en el respaldo 7b (no discriminan; se conservan para que el arreglo no los afloje)
  AI('7b control: # nota<CR>git commit --no-verify (ya negaba por B20)', true, '# nota' + CR + 'git commit --no-verify -m x', rLimpio, esSalto);
  AI('7b control: CR dentro de comillas antes de -n sigue negando', true, 'git commit -m "x' + CR + '" -n', rLimpio, esSalto);
  for (const cmd of [
    'git status',
    "rg -n 'no-verify' hooks/guardia-git.js",
    'git log --grep=commit -n 5',
    "rg -n 'no-verify' hooks/guardia-git.js\r\nrg -n 'hooksPath' hooks/guardia-git.js",
    "rg -n 'no-verify' hooks/guardia-git.js" + CR + "rg -n 'hooksPath' hooks/guardia-git.js",
    'git status\r\ngit log -n 1',
    'git commit -m "uno' + CR + 'dos"',
  ]) AI('7b control pasa: ' + JSON.stringify(cmd), false, cmd, rLimpio);

  // ---- ciclo 7c (V7B-001): saltos de línea DENTRO de comillas no deben partir las reglas de B20 (segunda lectura con
  // esos saltos → espacio, que solo suma negaciones). Cada caso con CR y con LF.
  for (const X of [CR, '\n']) {
    const et = X === CR ? '<CR>' : '<LF>';
    for (const [nom, cmd] of [
      ['Set-Content -Value multilínea -Path .git/config', 'Set-Content -Value "a' + X + 'b" -Path .git/config'],
      ['Out-File -InputObject multilínea -FilePath .git/config', 'Out-File -InputObject "a' + X + 'b" -FilePath .git/config'],
      ['git config alias.ci "<salto>commit"', 'git config alias.ci "' + X + 'commit"'],
      ['Add-Content -Value multilínea -Path .git/config', 'Add-Content -Value "a' + X + 'b" -Path .git/config'],
      ['Tee-Object -InputObject multilínea -FilePath .git/config', 'Tee-Object -InputObject "a' + X + 'b" -FilePath .git/config'],
      ['printf multilínea | tee -a .git/config', 'printf "a' + X + 'b" | tee -a .git/config'],
      ['echo multilínea > .git/config', 'echo "a' + X + 'b" > .git/config'],
      ['Set-Content -Value multilínea -Path .git/MERGE_HEAD', 'Set-Content -Value "abc' + X + 'def" -Path .git/MERGE_HEAD'],
      ['git -c "alias.x=<salto>commit" x', 'git -c "alias.x=' + X + 'commit" x'],
      ['B20b: Set-ItemProperty HKCU:\\Environment -Value multilínea -Name GIT_CONFIG_GLOBAL',
        'Set-ItemProperty -Path HKCU:\\Environment -Value "x' + X + 'y" -Name GIT_CONFIG_GLOBAL'],
      ['eval "git commit -m \'x<salto>\' -n" (racimo con n tras commit)', 'eval "git commit -m \'x' + X + '\' -n"'],
    ]) AI('7c NIEGA (' + et + '): ' + nom, true, cmd, rLimpio, esSalto);
    for (const [nom, cmd] of [
      ['git commit -m "uno<salto>dos"', 'git commit -m "uno' + X + 'dos"'],
      ['Set-Content -Value multilínea -Path notas.txt', 'Set-Content -Value "a' + X + 'b" -Path notas.txt'],
    ]) AI('7c control pasa (' + et + '): ' + nom, false, cmd, rLimpio);
  }
  AI('7c fricción: git commit -m "x"<LF>git log -n 5 (salto FUERA de comillas) pasa', false, 'git commit -m "x"\ngit log -n 5', rLimpio);
  // con CR c7 ya negaba, y en Git Bash el CR se borra: `"x"git log -n 5` queda como `commit … -n 5` (real) → se niega
  AI('7c: git commit -m "x"<CR>git log -n 5 se niega (como c7; en Git Bash sería commit -n)', true, 'git commit -m "x"' + CR + 'git log -n 5', rLimpio, esSalto);
  // en Git Bash el CR NO separa (se borra; medido): lo que c7 negaba con el CR suelto debe seguir negándose
  for (const cmd of ['cp evil' + CR + ' .git/config', 'tee -a x' + CR + ' .git/config', 'cp x' + CR + ' .git/MERGE_HEAD',
    'git -c x.y=z' + CR + ' reset --hard', 'git -c x.y=z' + CR + ' push --force origin main', 'git -c x.y=z' + CR + ' clean -fdx',
    'git commit -m x' + CR + ' -n', 'git reset' + CR + ' --hard']) {
    AI('7c NIEGA (CR fuera de comillas, como c7): ' + JSON.stringify(cmd), true, cmd, rLimpio, esSalto);
  }
  // Git Bash BORRA el CR (también entre comillas y en $'…', medido): un CR dentro de una palabra la une → lectura «borrado»
  for (const cmd of ['git re' + CR + 'set --hard', 'git commit --no-' + CR + 'verify -m x', 'git com' + CR + 'mit -n -m x',
    'git push --for' + CR + 'ce origin main', 'git cl' + CR + 'ean -fdx', 'git config --global core.hooks' + CR + 'Path C:/x',
    'gi' + CR + 't reset --hard']) {
    AI('7c NIEGA (CR que une palabras en Git Bash): ' + JSON.stringify(cmd), true, cmd, rLimpio, esSalto);
  }
  AI('7c control pasa: here-string de PowerShell como mensaje de commit', false, 'git commit -m @"\nlinea\n"@', rLimpio);
  AI('7c control pasa: git status', false, 'git status', rLimpio);
  AI("7c control pasa: rg -n 'no-verify' hooks/guardia-git.js", false, "rg -n 'no-verify' hooks/guardia-git.js", rLimpio);
  AI('7c control pasa: git log --grep=commit -n 5', false, 'git log --grep=commit -n 5', rLimpio);
  AI('7c control pasa: dos lecturas separadas por \\r\\n', false, "rg -n 'no-verify' hooks/guardia-git.js\r\nrg -n 'hooksPath' hooks/guardia-git.js", rLimpio);

  // ---- ciclo 7 (C4a): en PowerShell `bash`/`sh` sin la ruta de Git Bash = WSL → nunca se relaja; en Bash es Git Bash
  for (const cmd of ['bash -c "git rebase --continue"', 'bash -c "git am --continue"', 'sh -c "git commit -m x"', 'bash -lc "git pull"',
    'bash -c "git merge otra"', 'bash -c "git cherry-pick abc"', 'bash -c "git revert HEAD"']) {
    A('C4a ' + cmd, { Bash: false, PowerShell: true }, cmd, rLimpio, (r, tool) => tool === 'Bash' || esWsl(r));
  }
  A('C4a bash -c "git status" (sin commit) pasa en ambos', false, 'bash -c "git status"', rLimpio);
  A('C4a Git Bash por su ruta en PowerShell se analiza como siempre', false, '& "C:\\Program Files\\Git\\bin\\bash.exe" -c "git commit -m x"', rLimpio);

  // ---- ciclo 7 (C4d): la capa se acredita con el core.hooksPath EFECTIVO de la carpeta del comando
  {
    const rHusky = repo({ stage: { 'ok.txt': 'nada raro\n' } });
    git(rHusky, 'config', 'core.hooksPath', '.husky/_'); // hooksPath LOCAL (husky): gana a la guarda global
    A('C4d repo con hooksPath LOCAL (husky): lo no analizable vuelve a ser estricto', true, 'bash scripts/verify.sh && git commit -m x', rHusky, (r, tool) => esNoAn(r));
    A('C4d cd <repo husky> && no analizable', { Bash: true, PowerShell: true }, `cd "${rHusky}" && bash scripts/verify.sh && git commit -m x`, rLimpio, (r) => esNoAn(r));
    A('C4d git -C <repo husky> commit -i (se relajaba)', true, `git -C "${rHusky}" commit -i base.txt -m x`, rLimpio, (r) => /-i/.test(r.motivo));
    A('C4d control: el mismo -i en un repo sin hooksPath local pasa', false, `git -C "${rLimpio}" commit -i base.txt -m x`, rLimpio);
    const verCapa = (dir, gc) => capaGit(gc || CONFIG_CON_CAPA, { dir });
    test('C4d capaGitActiva(<repo husky>) → INACTIVA', () => assert.equal(verCapa(rHusky), 'false'));
    test('C4d capaGitActiva(<repo normal>) → ACTIVA', () => assert.equal(verCapa(rLimpio), 'true'));
    // includeIf gitdir: en el global que cambia hooksPath SOLO para un repo (Codex c6 SEC-005)
    const rIf = repo({ stage: { 'ok.txt': 'x\n' } });
    const otroCfg = path.join(RAIZ, 'gc-incluido-if-' + (n++));
    fs.writeFileSync(otroCfg, '[core]\n\thooksPath = ' + path.join(RAIZ, 'otros-hooks').split(path.sep).join('/') + '\n');
    const gcIf = path.join(RAIZ, 'gc-if-' + (n++));
    fs.writeFileSync(gcIf, fs.readFileSync(CONFIG_CON_CAPA, 'utf8') + '[includeIf "gitdir/i:' + rIf.split(path.sep).join('/') + '/"]\n\tpath = ' + otroCfg.split(path.sep).join('/') + '\n');
    test('C4d includeIf gitdir: → INACTIVA en ESE repo', () => assert.equal(verCapa(rIf, gcIf), 'false'));
    test('C4d includeIf gitdir: → ACTIVA en otro repo', () => assert.equal(verCapa(rLimpio, gcIf), 'true'));
  }

  test('C7: saltoGuarda con 6 textos hostiles de 48 KB (am, lectores, cp, --no-ve, hooksPath, =commit) tarda < ' + LIMITE_LINEAL_MS + ' ms cada uno', () => { // ciclo 7: también lineal
    const codigo = `const g=require(${JSON.stringify(HOOK)});const c=${JSON.stringify({
      a: 'git am ' + 'am '.repeat(15000), b: 'grep git '.repeat(5000), c: 'cp .git/config '.repeat(3000), d: 'git ' + '--no-ve'.repeat(6800),
      e: 'echo hooksPath; '.repeat(20) + 'git ' + 'x'.repeat(48000), f: 'git log --grep=commit '.repeat(2200) })};
      const out={};for(const k in c){const t0=process.hrtime.bigint();g.saltoGuarda(c[k]);out[k]=Number(process.hrtime.bigint()-t0)/1e6;}console.log(JSON.stringify(out));`;
    const guion = path.join(RAIZ, 'tiempo-crudo-c7.cjs');
    fs.writeFileSync(guion, codigo);
    const r = spawnSync(process.execPath, [guion], { encoding: 'utf8', env: envHook() });
    let t = {};
    try { t = JSON.parse(r.stdout); } catch { /* sin salida */ }
    const lentos = Object.entries(t).filter(([, ms]) => ms >= LIMITE_LINEAL_MS);
    assert.ok(Object.keys(t).length === 6 && !lentos.length, String(r.stdout) + String(r.stderr).slice(0, 200));
  });

}

// ---------- política de commits POR DEFECTO (permitir): el crédito de Claude PASA; secretos, .env, evidencias, -n,
// --no-verify y lo destructivo siguen negados. (Todo lo de arriba corre con commits.credito = prohibir.)
{
  const CRED = 'Co-Authored-By: Claude Opus <noreply@anthropic.com>';
  const P = (nombre, esp, cmd, cwd, extra, opc) => caso('[política permitir] ' + nombre, esp, cmd, cwd, extra, { ...opc, politica: 'permitir' });
  const esSaltoP = (r) => /está prohibido para el agente/.test(r.motivo);
  const rMsg = repo({ stage: { 'ok.txt': 'x\n' } });
  fs.writeFileSync(path.join(rMsg, 'msg.txt'), 'hola\n\n' + CRED + '\n');

  P('-m con Co-Authored-By de Claude pasa', false, 'git commit -m "x\n\n' + CRED + '"', limpio);
  P('-m con noreply@anthropic.com pasa', false, 'git commit -m "x noreply@anthropic.com"', limpio);
  P('-m con Generated with Claude Code pasa', false, 'git commit -m "x 🤖 Generated with [Claude Code](https://claude.com)"', limpio);
  P('-m con Claude-Session: pasa', false, 'git commit -m "x\nClaude-Session: abc"', limpio);
  P('heredoc con crédito pasa', false, "git commit -F - <<'EOF'\nmensaje\n\n" + CRED + '\nEOF', limpio);
  P('heredoc $(cat) con crédito pasa', false, "git commit -m \"$(cat <<'EOF'\nmensaje\n\n" + CRED + '\nEOF\n)"', limpio);
  P('-F archivo con crédito pasa', false, 'git commit -F msg.txt', rMsg);
  P('--file= archivo con crédito pasa', false, 'git commit --file=msg.txt', rMsg);
  P('crédito con la capa de git activa pasa', false, 'git commit -m "x" -m "' + CRED + '"', limpio, undefined, { capa: true });
  // lo demás sigue negado con la política por defecto
  P('.env stageado sigue negado (y no se imprime su valor)', true, 'git commit -m x', rEnv, (r) => r.motivo.includes('.env') && !r.motivo.includes('A=1'));
  P('llave en una línea añadida sigue negada (sin imprimir el valor)', true, 'git commit -m x', rKey, (r) => r.motivo.includes('src/cfg.js:2 (llave AWS)') && !r.motivo.includes(VALOR_SECRETO));
  P('evidencia del navegador sigue negada', true, 'git commit -m x', rCap, esEvidencia('reports/visual-audit/20261015-1200/inicio-360.png'));
  P('crédito + .env: se niega por el .env, no por el crédito', true, 'git commit -m "x\n\n' + CRED + '"', rEnv, (r) => r.motivo.includes('.env') && !/crédito de Claude/.test(r.motivo));
  P('commit -n sigue negado', true, 'git commit -n -m x', limpio, esSaltoP);
  P('commit --no-verify sigue negado', true, 'git commit --no-verify -m x', limpio, esSaltoP);
  P('reset --hard sigue negado', true, 'git reset --hard', limpio);
  P('push --force sigue negado', true, 'git push --force', limpio);
  P('clean -fd sigue negado', true, 'git clean -fd', limpio);
  P('-c core.hooksPath sigue negado', true, 'git -c core.hooksPath=/dev/null commit -m x', limpio, esSaltoP);
  P('git config core.hooksPath (escritura) sigue negado', true, 'git config --global core.hooksPath /dev/null', limpio, esSaltoP);
  P('con la capa de git activa: reset --hard sigue negado', true, 'git reset --hard', limpio, undefined, { capa: true });

  test('política prohibir con firma: el motivo pide quitar la línea y firmar con la firma configurada', () => {
    const r = correr('Bash', 'git commit -m "x" -m "' + CRED + '"', limpio);
    assert.ok(r.deny);
    assert.equal(r.motivo, MOTIVO_CREDITO_ESPERADO);
  });
  test('política prohibir sin firma: el motivo solo pide quitar la línea', () => {
    const r = correr('Bash', 'git commit -m "x" -m "' + CRED + '"', limpio, { sinFirma: true });
    assert.ok(r.deny);
    assert.equal(r.motivo, 'Guardia UAEH: la política de commits de este usuario prohíbe el crédito de Claude. Quita esa línea.');
  });
  test('la política sale de uaeh.config.json cuando no hay variables UAEH_COMMIT_*; la variable manda; un archivo roto cae a permitir', () => {
    const c = entornoTemporal('uaeh-guardia-git-cfg-');
    try {
      const ejecutar = (cmd, extra = {}) => {
        const env = { ...c.env, GIT_CONFIG_GLOBAL: CONFIG_SIN_CAPA, UAEH_GIT_HOOKS: GUARDA, ...extra };
        const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: limpio, session_id: 't' }), encoding: 'utf8', env, cwd: c.proyecto });
        const o = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
        return { status: r.status, deny: !!o && o.permissionDecision === 'deny', motivo: o ? o.permissionDecisionReason : '' };
      };
      const cmd = 'git commit -m "x" -m "' + CRED + '"';
      assert.equal(ejecutar(cmd).deny, false, 'sin archivo ni variables: permitir');
      c.escribir(path.join(c.uaehHome, 'uaeh.config.json'), JSON.stringify({ version: 1, commits: { credito: 'prohibir', firma: 'Firmado: el equipo' } }));
      const r = ejecutar(cmd);
      assert.ok(r.deny && r.motivo.includes('«Firmado: el equipo»'), r.motivo);
      assert.equal(ejecutar(cmd, { UAEH_COMMIT_CREDITO: 'permitir' }).deny, false, 'la variable manda sobre el archivo');
      c.escribir(path.join(c.uaehHome, 'uaeh.config.json'), '{ esto no es JSON');
      assert.equal(ejecutar(cmd).deny, false, 'un archivo roto cae a permitir');
    } finally { c.limpiar(); }
  });
  test('sin scripts/lib/config.cjs: la política es permitir y la guarda de git se da por inactiva (estricto)', () => {
    const carpeta = path.join(RAIZ, 'sin-lib', 'hooks'); // sin ../scripts/lib/config.cjs al lado
    fs.mkdirSync(carpeta, { recursive: true });
    const copia = path.join(carpeta, 'guardia-git.js');
    fs.copyFileSync(HOOK, copia);
    const ejecutar = (cmd, opc) => {
      const r = spawnSync(process.execPath, [copia], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: limpio, session_id: 't' }), encoding: 'utf8', env: envHook(opc), cwd: E.proyecto });
      const o = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
      return { status: r.status, deny: !!o && o.permissionDecision === 'deny', motivo: o ? o.permissionDecisionReason : '' };
    };
    // el entorno trae UAEH_COMMIT_CREDITO=prohibir, pero sin la biblioteca no se lee la política: el crédito se permite
    assert.equal(ejecutar('git commit -m "x" -m "' + CRED + '"').deny, false);
    // con la capa «activa» en el gitconfig, sin la biblioteca no hay guarda esperada con la que comparar: estricto
    const r = ejecutar('bash scripts/verify.sh && git commit -m x', { capa: true });
    assert.ok(r.deny && /no puede analizar/.test(r.motivo), r.motivo);
    // y lo que siempre se niega, se niega
    assert.ok(ejecutar('git reset --hard').deny);
  });
}

// ---------- el texto de lo prohibido es el del contrato: neutral, nombra al usuario y no cita personas ni rutas de una máquina
test('el motivo de lo prohibido: texto exacto, sin nombres propios ni rutas', () => {
  const r = correr('Bash', 'git reset --hard', limpio);
  assert.equal(r.motivo, 'Guardia UAEH: «git reset --hard» está prohibido para el agente (destruye trabajo o salta controles). ' +
    'Si el usuario lo autoriza, lo ejecuta en su propia terminal, fuera de Claude Code.');
});

// ---------- tiempos (informativo): lo que cuesta el hook; solo se comprueba que responde bien
test('tiempos del hook (mediana de 5, ms)', (t) => {
  const medir = (cmd, veces) => {
    const ts = [];
    for (let i = 0; i < veces; i++) { const r = correr('Bash', cmd, limpio); assert.ok(r.status === 0 && !r.deny, cmd + ': ' + r.motivo); ts.push(r.ms); }
    ts.sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)];
  };
  const base = (() => { const ts = []; for (let i = 0; i < 5; i++) { const t0 = process.hrtime.bigint(); spawnSync(process.execPath, ['-e', '0']); ts.push(Number(process.hrtime.bigint() - t0) / 1e6); } ts.sort((a, b) => a - b); return ts[2]; })();
  t.diagnostic(`node -e 0 = ${base.toFixed(0)} | hook sin git ("npm test") = ${medir('npm test', 5).toFixed(0)} | "git status" = ${medir('git status', 5).toFixed(0)} | "git commit" limpio = ${medir('git commit -m ok', 5).toFixed(0)}`);
});
