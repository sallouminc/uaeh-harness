#!/usr/bin/env node
// scripts/doctor.cjs — diagnóstico de la instalación de la capa 2 del método UAEH (plugin uaeh-harness: arnés de verificación).
//
// Uso: node doctor.cjs [--cwd <dir>] [--json] [--rapido]
//   --cwd     carpeta del proyecto que se revisa (por defecto, la actual).
//   --json    salida de máquina: { capa, version, comprobaciones:[{id, estado, detalle}], resumen:{…}, codigo }.
//   --rapido  salta las tres autopruebas (humo de la guarda de git, candado de solo lectura, sello de integridad):
//             quedan OMITIDA («se prueba sin --rapido»). Sin esta opción el doctor tarda unos segundos más.
//   --raiz    (avanzado/pruebas) raíz del plugin que se revisa; por defecto, la de este script.
//
// Reglas de este script:
//   · Solo lee. Las autopruebas trabajan en carpetas temporales propias que se borran al terminar; nunca escriben
//     fuera de ellas ni tocan la configuración real (las que lanzan procesos hijos les dan una casa temporal).
//   · Cada comprobación va aislada (lib/diagnostico.cjs): si lanza, queda como FALLÓ con el mensaje y el resto sigue.
//   · Estados: OK | AVISO | FALLÓ | OMITIDA | NO_INSTALADA | NO_APLICA. Código de salida: 0 sin FALLÓ · 1 con FALLÓ ·
//     2 uso incorrecto. Una OMITIDA nunca cuenta como OK.
//   · Nunca edita settings, agentes ni skills del usuario: solo señala duplicados y copias.
//   · Las rutas de estado salen de lib/comun.cjs; los archivos del plugin, de __dirname (o de --raiz).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const comun = require(path.join(__dirname, 'lib', 'comun.cjs'));
const configLib = require(path.join(__dirname, 'lib', 'config.cjs'));
const diag = require(path.join(__dirname, 'lib', 'diagnostico.cjs'));
const instalar = require(path.join(__dirname, 'instalar.cjs'));

const RAIZ_PLUGIN = path.resolve(__dirname, '..');
const NODE_MINIMO = 20;
const GIT_MINIMO = '2.31.0';
const SKILLS_GENERICAS = new Set(['setup', 'doctor']); // nombres genéricos: no cuentan como copia personal
const RE_RAIZ_PLUGIN = /\$\{CLAUDE_PLUGIN_ROOT\}[\\/]+([^\s"'\x60<>|&;)]+)/g;

// ── Utilidades ────────────────────────────────────────────────────────────────────────────

function claveRuta(ruta) {
  const r = path.resolve(ruta);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function escaparRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Recorre hooks.<Evento>[i].hooks[j] y llama cb(evento, i, j, hook).
function recorrerHooks(datos, cb) {
  const hooks = datos && datos.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return;
  for (const [evento, grupos] of Object.entries(hooks)) {
    if (!Array.isArray(grupos)) continue;
    grupos.forEach((grupo, i) => {
      const lista = grupo && Array.isArray(grupo.hooks) ? grupo.hooks : [];
      lista.forEach((hook, j) => cb(evento, i, j, hook));
    });
  }
}

function textosDeHook(hook) {
  if (!hook) return [];
  return [hook.command, ...(Array.isArray(hook.args) ? hook.args : [])].filter((t) => typeof t === 'string');
}

function lista(items, max = 4) {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} y ${items.length - max} más`;
}

function ms(inicio) { return `${((Date.now() - inicio) / 1000).toFixed(1)} s`; }

// Casa temporal para procesos hijos de las autopruebas: nada de lo que midan toca la configuración real.
function entornoHermetico(tmp) {
  const casa = path.join(tmp, 'casa');
  const claude = path.join(casa, '.claude');
  const uaeh = path.join(claude, 'uaeh');
  for (const d of [casa, claude, uaeh, path.join(tmp, 'codex')]) fs.mkdirSync(d, { recursive: true });
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = Doctor UAEH\n\temail = doctor@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n', 'utf8');
  const env = { ...process.env };
  for (const k of ['CLAUDE_PLUGIN_ROOT', 'UAEH_GIT_HOOKS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  return {
    ...env, HOME: casa, USERPROFILE: casa, CLAUDE_CONFIG_DIR: claude, UAEH_HOME: uaeh,
    CODEX_HOME: path.join(tmp, 'codex'), GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1',
  };
}

// Entorno del sello: uaeh-integridad.cjs se niega (DESCONOCIDO) si HOME o GIT_CONFIG_* están alterados, porque un git con
// otra configuración no mediría lo real. Así que HOME vuelve a ser el real; lo que se aísla son las carpetas que el sello
// mediría (CLAUDE_CONFIG_DIR, UAEH_HOME, CODEX_HOME), que van a la casa temporal.
function entornoSello(tmp) {
  const env = entornoHermetico(tmp);
  const real = os.userInfo().homedir;
  env.HOME = real;
  env.USERPROFILE = real;
  for (const k of Object.keys(env)) if (/^(GIT_CONFIG_|XDG_CONFIG_HOME)/i.test(k)) delete env[k];
  return env;
}

// ── Contexto compartido (todo se lee una sola vez) ────────────────────────────────────────

function crearContexto(opciones) {
  const cwd = path.resolve(opciones.cwd || process.cwd());
  const raiz = path.resolve(opciones.raiz || RAIZ_PLUGIN);
  const cache = new Map();
  const memo = (clave, fn) => {
    if (!cache.has(clave)) cache.set(clave, fn());
    return cache.get(clave);
  };
  const ctx = {
    cwd, raiz, rapido: !!opciones.rapido,
    version: () => memo('version', () => {
      const m = comun.leerJson(path.join(raiz, '.claude-plugin', 'plugin.json'));
      return m && typeof m.version === 'string' ? m.version : '0.0.0';
    }),
    config: () => memo('config', () => configLib.cargarConfig()),
    git: () => memo('git', () => {
      const r = diag.ejecutarComando('git', ['--version'], { segundos: 15 });
      return { encontrado: r.encontrado && r.codigo === 0, version: diag.versionDe(r.stdout), texto: r.stdout.trim() };
    }),
    hooksJson: () => memo('hooksJson', () => comun.leerJson(path.join(raiz, 'hooks', 'hooks.json'))),
    // Nombres de archivo de los scripts que usa hooks.json del plugin.
    scriptsHooks: () => memo('scriptsHooks', () => {
      const rutas = new Set();
      recorrerHooks(ctx.hooksJson(), (e, i, j, hook) => {
        for (const t of textosDeHook(hook)) for (const m of t.matchAll(RE_RAIZ_PLUGIN)) rutas.add(m[1]);
      });
      return [...rutas];
    }),
    settings: () => memo('settings', () => {
      const casa = comun.claudeHome();
      const candidatos = [
        path.join(casa, 'settings.json'), path.join(casa, 'settings.local.json'),
        path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'),
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
    // Estado del espejo frente al plugin: { existe, espejo, version, difs:[…] }.
    espejo: () => memo('espejo', () => compararEspejo(ctx)),
  };
  return ctx;
}

// Lista de [ruta relativa, contenido esperado (Buffer), exigeEjecutable] que copiarEspejo() dejaría en el espejo.
function archivosEsperados(ctx) {
  const salida = [];
  const dirHooks = path.join(ctx.raiz, 'git-hooks');
  let nombres = [];
  try { nombres = fs.readdirSync(dirHooks).filter((n) => fs.statSync(path.join(dirHooks, n)).isFile()).sort(); } catch { /* sin git-hooks */ }
  for (const n of nombres) {
    const crudo = fs.readFileSync(path.join(dirHooks, n));
    salida.push([`git-hooks/${n}`, Buffer.from(crudo.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'), true]);
  }
  for (const rel of instalar.COPIAS_ESPEJO) {
    let contenido = null;
    try { contenido = fs.readFileSync(path.join(ctx.raiz, ...rel.split('/'))); } catch { /* falta en el plugin */ }
    salida.push([rel, contenido, false]);
  }
  salida.push(['VERSION', Buffer.from(`${ctx.version()}\n`, 'utf8'), false]);
  salida.push(['package.json', Buffer.from('{"type":"commonjs"}\n', 'utf8'), false]);
  return salida;
}

function compararEspejo(ctx) {
  const espejo = configLib.espejoHarness();
  if (!fs.existsSync(espejo)) return { existe: false, espejo, version: null, difs: [] };
  let version = null;
  try { version = fs.readFileSync(path.join(espejo, 'VERSION'), 'utf8').trim(); } catch { /* sin VERSION */ }
  const difs = [];
  for (const [rel, esperado, ejecutable] of archivosEsperados(ctx)) {
    if (!esperado) { difs.push(`${rel} (falta en el plugin)`); continue; }
    const ruta = path.join(espejo, ...rel.split('/'));
    let actual = null;
    try { actual = fs.readFileSync(ruta); } catch { /* ausente */ }
    if (!actual) { difs.push(`${rel} (falta)`); continue; }
    // Los git-hooks se comparan tras normalizar CRLF → LF (sh no tolera CR); el resto, byte a byte.
    const a = rel.startsWith('git-hooks/') ? Buffer.from(actual.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : actual;
    if (!a.equals(esperado)) { difs.push(rel); continue; }
    if (ejecutable && process.platform !== 'win32') {
      try { if (!(fs.statSync(ruta).mode & 0o111)) difs.push(`${rel} (sin permiso de ejecución)`); } catch { difs.push(rel); }
    }
  }
  return { existe: true, espejo, version, difs };
}

// ── Comprobaciones ────────────────────────────────────────────────────────────────────────

function comprobarNode() {
  const mayor = parseInt(process.versions.node.split('.')[0], 10);
  return mayor >= NODE_MINIMO
    ? { estado: 'OK', detalle: `Node ${process.versions.node}` }
    : { estado: 'FALLÓ', detalle: `Node ${process.versions.node}: el arnés necesita Node ${NODE_MINIMO} o superior` };
}

function comprobarGit(ctx) {
  const g = ctx.git();
  if (!g.encontrado) return { estado: 'NO_INSTALADA', detalle: 'git no está en el PATH: la guarda de git no puede correr' };
  if (!g.version) return { estado: 'AVISO', detalle: `no se pudo leer la versión de git («${g.texto}»)` };
  if (diag.compararVersion(g.version, GIT_MINIMO) < 0) return { estado: 'FALLÓ', detalle: `git ${g.version}: se necesita ${GIT_MINIMO} o superior` };
  return { estado: 'OK', detalle: `git ${g.version}` };
}

function comprobarRutas() {
  const home = comun.uaehHome();
  const notas = [];
  if (/\s/.test(home)) notas.push('la ruta tiene espacios');
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(home)) notas.push('la ruta tiene caracteres no ASCII');
  if (!fs.existsSync(home)) return { estado: 'AVISO', detalle: `${home} no existe todavía (se crea con /uaeh-harness:setup)${notas.length ? `; ${notas.join('; ')}` : ''}` };
  try { fs.accessSync(home, fs.constants.W_OK); } catch { return { estado: 'FALLÓ', detalle: `${home} existe pero no es escribible` }; }
  if (notas.length) return { estado: 'AVISO', detalle: `${home}: ${notas.join('; ')} (algunos scripts de shell pueden fallar)` };
  return { estado: 'OK', detalle: `${home} existe y es escribible` };
}

function comprobarConfig(ctx) {
  const c = ctx.config();
  if (!c.existe) {
    const extra = c.avisos.length ? `; además: ${c.avisos.join('; ')}` : '';
    return { estado: 'AVISO', detalle: `sin archivo de configuración (${c.ruta}): valores por defecto${extra}` };
  }
  if (c.avisos.length) return { estado: 'AVISO', detalle: `${c.ruta}: ${c.avisos.join('; ')}` };
  return { estado: 'OK', detalle: `${c.ruta} válida` };
}

function comprobarHooksJson(ctx) {
  const ruta = path.join(ctx.raiz, 'hooks', 'hooks.json');
  const datos = ctx.hooksJson();
  if (!datos) return { estado: 'FALLÓ', detalle: `${ruta} no existe o no es JSON válido` };
  let nHooks = 0;
  recorrerHooks(datos, () => { nHooks++; });
  const scripts = ctx.scriptsHooks();
  const faltan = scripts.filter((s) => !fs.existsSync(path.join(ctx.raiz, ...s.split(/[\\/]+/))));
  if (!nHooks) return { estado: 'FALLÓ', detalle: 'hooks.json no declara ningún hook' };
  if (faltan.length) return { estado: 'FALLÓ', detalle: `${nHooks} hooks; apuntan a scripts que no existen en el plugin: ${faltan.join(', ')}` };
  return { estado: 'OK', detalle: `${nHooks} hooks, ${scripts.length} scripts` };
}

function comprobarDuplicados(ctx) {
  const nombres = [...new Set(ctx.scriptsHooks().map((s) => path.basename(s)))];
  if (!nombres.length) return { estado: 'NO_APLICA', detalle: 'hooks.json no declara scripts que comparar' };
  const re = new RegExp(`(?:^|[\\s"'\\/\\\\])(${nombres.map(escaparRegex).join('|')})(?=$|[\\s"'])`);
  const hallazgos = [];
  const revisados = ctx.settings().filter((s) => s.datos);
  for (const s of revisados) {
    recorrerHooks(s.datos, (evento, i, j, hook) => {
      for (const t of textosDeHook(hook)) {
        const m = re.exec(t);
        if (m) { hallazgos.push(`${s.ruta} → /hooks/${evento}/${i}/hooks/${j} (${m[1]})`); break; }
      }
    });
  }
  const ilegibles = ctx.settings().filter((s) => s.error).map((s) => s.ruta);
  if (!hallazgos.length) {
    const nota = ilegibles.length ? `; no se pudieron leer: ${ilegibles.join(', ')}` : '';
    return { estado: 'OK', detalle: `sin hooks duplicados (${revisados.length} archivo(s) de settings revisado(s)${nota})` };
  }
  return { estado: 'AVISO', detalle: `${hallazgos.length} hook(s) de settings llaman a scripts que el plugin ya registra y correrían dos veces: ${hallazgos.join(' · ')}. Quita el de settings a mano; el doctor no edita` };
}

function nombresEn(dir, filtro) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(filtro).map((e) => e.name); } catch { return []; }
}

function comprobarCopiasPersonales(ctx) {
  const casa = comun.claudeHome();
  const agentesPlugin = nombresEn(path.join(ctx.raiz, 'agents'), (e) => e.isFile() && e.name.endsWith('.md')).map((n) => n.slice(0, -3));
  const skillsPlugin = nombresEn(path.join(ctx.raiz, 'skills'), (e) => e.isDirectory() && fs.existsSync(path.join(ctx.raiz, 'skills', e.name, 'SKILL.md')))
    .filter((n) => !SKILLS_GENERICAS.has(n));
  const copias = [];
  for (const n of agentesPlugin) {
    if (fs.existsSync(path.join(casa, 'agents', `${n}.md`))) copias.push(`agente ${n}`);
  }
  for (const n of skillsPlugin) {
    if (fs.existsSync(path.join(casa, 'skills', n, 'SKILL.md'))) copias.push(`skill ${n}`);
  }
  if (!copias.length) return { estado: 'OK', detalle: `sin copias personales de ${agentesPlugin.length} agentes ni ${skillsPlugin.length} skills del plugin` };
  return { estado: 'AVISO', detalle: `quedan dos copias: la personal y la del plugin (uaeh-harness:<nombre>): ${copias.join(', ')}; mueve la personal a un respaldo` };
}

function comprobarGuardaGit(ctx) {
  if (!ctx.git().encontrado) return { estado: 'NO_INSTALADA', detalle: 'git no está en el PATH' };
  const r = diag.ejecutarComando('git', ['config', '--global', '--get', instalar.CLAVE_HOOKS], { segundos: 20 });
  if (r.codigo === 1) return { estado: 'AVISO', detalle: 'sin guarda de git: /uaeh-harness:setup git-guard' };
  if (r.codigo !== 0) return { estado: 'FALLÓ', detalle: `git config falló (código ${r.codigo}): ${(r.stderr || '').trim().split(/\r?\n/)[0]}` };
  const valor = r.stdout.split(/\r?\n/)[0].trim();
  if (!valor) return { estado: 'AVISO', detalle: 'sin guarda de git: /uaeh-harness:setup git-guard' };
  const esperado = configLib.rutaGitHooks();
  const actual = instalar.normalizarRuta(valor.replace(/^~(?=[\\/])/, os.homedir()));
  if (actual === instalar.normalizarRuta(esperado)) return { estado: 'OK', detalle: `apunta a ${instalar.rutaParaGit(esperado)}` };
  return { estado: 'AVISO', detalle: `otra guarda: ${valor} (la del arnés es ${instalar.rutaParaGit(esperado)})` };
}

function comprobarEspejo(ctx) {
  const e = ctx.espejo();
  if (!e.existe) return { estado: 'NO_INSTALADA', detalle: `no existe ${e.espejo}: /uaeh-harness:setup git-guard` };
  const notas = [];
  if (e.version !== ctx.version()) notas.push(`VERSION ${e.version || 'ausente'}, el plugin es ${ctx.version()}`);
  if (e.difs.length) notas.push(`${e.difs.length} archivo(s) distinto(s): ${lista(e.difs)}`);
  if (notas.length) return { estado: 'AVISO', detalle: `desactualizado: ${notas.join('; ')}; instalar.cjs git-guard --aplicar` };
  return { estado: 'OK', detalle: `espejo v${e.version} al día` };
}

function conTemporal(prefijo, fn) {
  let tmp;
  try { tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefijo))); } catch (e) {
    return { estado: 'FALLÓ', detalle: `no se pudo crear una carpeta temporal: ${e.message}` };
  }
  try { return fn(tmp); } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporal */ } }
}

function comprobarHumo(ctx) {
  if (ctx.rapido) return { estado: 'OMITIDA', detalle: 'se prueba sin --rapido' };
  if (!ctx.git().encontrado) return { estado: 'OMITIDA', detalle: 'sin git no se puede probar la guarda' };
  const e = ctx.espejo();
  const alDia = e.existe && e.version === ctx.version() && !e.difs.length;
  const dir = alDia ? path.join(e.espejo, 'git-hooks') : path.join(ctx.raiz, 'git-hooks');
  const origen = alDia ? 'del espejo' : 'del plugin (el espejo no está al día o no existe)';
  const inicio = Date.now();
  const r = instalar.humo(dir);
  const total = r.pasos.length;
  const bien = r.pasos.filter((p) => p.ok).length;
  if (r.ok) return { estado: 'OK', detalle: `${bien}/${total} pasos con la guarda ${origen} (${ms(inicio)})` };
  const malo = r.pasos.find((p) => !p.ok);
  return { estado: 'FALLÓ', detalle: `${bien}/${total} pasos con la guarda ${origen}; falló «${malo ? malo.nombre : 'prueba'}»${malo && malo.detalle ? `: ${malo.detalle}` : ''}` };
}

function comprobarCandado(ctx) {
  if (ctx.rapido) return { estado: 'OMITIDA', detalle: 'se prueba sin --rapido' };
  const script = path.join(ctx.raiz, 'hooks', 'solo-lectura.js');
  if (!fs.existsSync(script)) return { estado: 'FALLÓ', detalle: `no existe ${script}` };
  return conTemporal('uaeh-doctor-candado-', (tmp) => {
    const env = entornoHermetico(tmp);
    const comando = `rm -rf "${tmp.replace(/\\/g, '/')}/canario-inexistente"`;
    const evento = (agente) => {
      const e = { tool_name: 'Bash', tool_input: { command: comando }, cwd: tmp, session_id: 'doctor-0123456789', hook_event_name: 'PreToolUse' };
      if (agente) { e.agent_type = agente; e.agent_id = 'doctor-agente-1'; }
      return JSON.stringify(e);
    };
    const correr = (agente) => {
      const r = diag.ejecutarComando(process.execPath, [script], { segundos: 20, env, cwd: tmp, input: evento(agente) });
      let niega = false;
      try { const j = JSON.parse(r.stdout); niega = !!(j && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision === 'deny'); } catch { /* sin JSON: no negó */ }
      return { niega, codigo: r.codigo, agotado: r.agotado };
    };
    const inicio = Date.now();
    const revisor = correr('uaeh-harness:uae-verifier');
    const principal = correr(null);
    const problemas = [];
    if (revisor.agotado || principal.agotado) problemas.push('el hook no respondió a tiempo');
    if (!revisor.niega) problemas.push('el revisor pudo borrar (debía negarse)');
    if (principal.niega) problemas.push('la sesión principal quedó bloqueada (no debía)');
    if (revisor.codigo !== 0 || principal.codigo !== 0) problemas.push(`el hook salió con código ${revisor.codigo}/${principal.codigo} (debía ser 0)`);
    if (problemas.length) return { estado: 'FALLÓ', detalle: `${problemas.join('; ')}` };
    return { estado: 'OK', detalle: `el revisor se niega a borrar y la sesión principal pasa (${ms(inicio)})` };
  });
}

function comprobarSello(ctx) {
  if (ctx.rapido) return { estado: 'OMITIDA', detalle: 'se prueba sin --rapido' };
  if (!ctx.git().encontrado) return { estado: 'OMITIDA', detalle: 'sin git no se puede probar el sello' };
  const script = path.join(ctx.raiz, 'scripts', 'uaeh-integridad.cjs');
  if (!fs.existsSync(script)) return { estado: 'FALLÓ', detalle: `no existe ${script}` };
  return conTemporal('uaeh-doctor-sello-', (tmp) => {
    const env = entornoHermetico(tmp);
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const g = (args) => diag.ejecutarComando('git', args, { segundos: 30, env, cwd: repo });
    if (g(['init', '-q']).codigo !== 0) return { estado: 'FALLÓ', detalle: 'no se pudo crear el repo temporal' };
    fs.writeFileSync(path.join(repo, 'base.txt'), 'hola\n', 'utf8');
    g(['add', 'base.txt']);
    const c = g(['commit', '-q', '-m', 'doctor: base']);
    if (c.codigo !== 0) return { estado: 'FALLÓ', detalle: `no se pudo hacer el commit temporal: ${(c.stderr || c.stdout).trim().split(/\r?\n/)[0]}` };
    const envSello = entornoSello(tmp);
    const sello = (args) => diag.ejecutarComando(process.execPath, [script, ...args], { segundos: 60, env: envSello, cwd: repo });
    const inicio = Date.now();
    const foto = sello(['foto', repo]);
    const id = foto.stdout.trim().split(/\r?\n/)[0];
    if (foto.codigo !== 0 || !id) return { estado: 'FALLÓ', detalle: `«foto» salió con código ${foto.codigo}: ${(foto.stdout || foto.stderr).trim().split(/\r?\n/)[0]}` };
    const intacto = sello(['comparar', id, repo]);
    if (intacto.codigo !== 0 || !/^INTACTO/.test(intacto.stdout)) {
      return { estado: 'FALLÓ', detalle: `sin cambios debía dar INTACTO (0) y dio código ${intacto.codigo}: ${intacto.stdout.trim().split(/\r?\n/)[0]}` };
    }
    fs.writeFileSync(path.join(repo, 'base.txt'), 'cambiado\n', 'utf8');
    const rota = sello(['comparar', id, repo]);
    if (rota.codigo !== 3 || !/^ROTA/.test(rota.stdout)) {
      return { estado: 'FALLÓ', detalle: `tras cambiar un archivo debía dar ROTA (3) y dio código ${rota.codigo}: ${rota.stdout.trim().split(/\r?\n/)[0]}` };
    }
    return { estado: 'OK', detalle: `INTACTO sin cambios y ROTA tras editar un archivo (${ms(inicio)})` };
  });
}

function comprobarGuardiaCierre() {
  const marca = path.join(comun.uaehHome(), 'guardia-cierre.apagada');
  return fs.existsSync(marca)
    ? { estado: 'AVISO', detalle: `apagada (borra ${marca} para encenderla)` }
    : { estado: 'OK', detalle: 'encendida' };
}

function comprobarPoliticaCommits(ctx) {
  const p = configLib.politicaCommits(ctx.config().config);
  return { estado: 'OK', detalle: `crédito de Claude ${p.prohibir ? 'prohibido' : 'permitido'} · ${p.firma ? `firma «${p.firma}»` : 'sin firma'}` };
}

// Revisiones de OTRA sesión con sello abierto: instalar o cambiar la configuración ahora las dejaría con sello ROTA.
function comprobarSellosAbiertos() {
  const abiertos = require(path.join(__dirname, 'uaeh-integridad.cjs')).sellosAbiertos();
  if (!abiertos.length) return { estado: 'OK', detalle: 'sin revisiones abiertas' };
  const lista = abiertos.map((s) => `${s.id}${s.etiqueta ? ` «${s.etiqueta}»` : ''}, hace ${s.minutos} min`);
  return { estado: 'AVISO', detalle: `${abiertos.length} revisión(es) abierta(s) (${lista.join(' · ')}): no instalar ni cambiar la configuración hasta que terminen` };
}

const COMPROBACIONES = [
  ['node', comprobarNode],
  ['git', comprobarGit],
  ['rutas', comprobarRutas],
  ['config', comprobarConfig],
  ['hooks-json', comprobarHooksJson],
  ['duplicados', comprobarDuplicados],
  ['copias-personales', comprobarCopiasPersonales],
  ['guarda-git', comprobarGuardaGit],
  ['espejo', comprobarEspejo],
  ['humo', comprobarHumo],
  ['candado', comprobarCandado],
  ['sello', comprobarSello],
  ['sellos-abiertos', comprobarSellosAbiertos],
  ['guardia-cierre', comprobarGuardiaCierre],
  ['politica-commits', comprobarPoliticaCommits],
];

// ── Ejecución y salida ────────────────────────────────────────────────────────────────────

function ejecutar(opciones = {}) {
  const ctx = crearContexto(opciones);
  const comprobaciones = diag.correrComprobaciones(COMPROBACIONES, ctx);
  const resumen = diag.resumir(comprobaciones);
  return { capa: 'arnes', version: ctx.version(), comprobaciones, resumen, codigo: resumen['FALLÓ'] > 0 ? 1 : 0 };
}

function formatearHumano(informe) {
  return [
    `Doctor del arnés UAEH (capa 2) · plugin v${informe.version}`,
    '',
    ...diag.formatearComprobaciones(informe.comprobaciones),
    '',
    diag.lineaResumen(informe.resumen),
  ].join('\n');
}

function uso() {
  return [
    'Uso: node doctor.cjs [--cwd <dir>] [--json] [--rapido]',
    '  --cwd     carpeta del proyecto (por defecto, la actual)',
    '  --json    salida de máquina',
    '  --rapido  salta las autopruebas (humo, candado, sello)',
  ].join('\n');
}

// → { error } | { ayuda:true } | { opciones }
function parsearArgumentos(argv) {
  const opciones = { cwd: null, raiz: null, json: false, rapido: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--ayuda', '--help', '-h'].includes(a)) return { ayuda: true };
    if (a === '--json') opciones.json = true;
    else if (a === '--rapido') opciones.rapido = true;
    else if (a === '--cwd' || a === '--raiz') {
      const valor = argv[++i];
      if (valor === undefined || valor.startsWith('--')) return { error: `falta el valor de ${a}` };
      opciones[a.slice(2)] = valor;
    } else return { error: `argumento desconocido: ${a}` };
  }
  for (const clave of ['cwd', 'raiz']) {
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

module.exports = { main, ejecutar, parsearArgumentos, formatearHumano, uso, crearContexto, COMPROBACIONES };
