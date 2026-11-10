#!/usr/bin/env node
// tools/probar-perfil-limpio.cjs — prueba de extremo a extremo del kit en un perfil limpio de Claude Code.
//
// Qué demuestra: que el plugin, cargado con `--plugin-dir` en un perfil SIN la configuración personal del
// autor (CLAUDE_CONFIG_DIR temporal), inyecta de verdad su contexto al modelo. Un hook puede «funcionar»
// (salir 0) sin inyectar nada: por eso se comprueba en dos sitios independientes:
//   1. la respuesta del modelo, al que se le pide repetir la marca y una palabra centinela del mapa;
//   2. el transcript de esa sesión (en el perfil temporal) contiene la marca [uaeh-kit ctx v1];
// y además se corre el doctor del kit contra ese perfil para ver `inyeccion` en OK.
//
// Cuesta una llamada al modelo (modelo económico por defecto) y necesita sesión iniciada: copia SOLO el
// archivo de credenciales al perfil temporal y lo borra al terminar (si el proceso se mata de golpe, la copia queda en
// la carpeta temporal uaeh-perfil-limpio-*: borrarla a mano). No es una prueba
// unitaria: se corre a mano o en el cierre de un bloque. Uso:
//   node tools/probar-perfil-limpio.cjs [--modelo haiku] [--conservar] [--json] [--desde-github [<origen>]] [--base <carpeta>]
//
// --desde-github: en vez de cargar la copia de trabajo con `--plugin-dir`, hace en el perfil temporal lo mismo que un
// usuario nuevo: `claude plugin marketplace add <origen>` (por defecto el repositorio público del proyecto) y
// `claude plugin install` de los dos plugins; después comprueba que quedaron instalados y habilitados y repite la
// prueba de inyección SIN `--plugin-dir`. Prueba lo publicado en el remoto, no los cambios locales sin subir. Mientras
// el repositorio sea privado necesita que git tenga acceso a él en esta máquina.
// --base <carpeta>: dónde crear el perfil temporal (por defecto, la carpeta temporal del sistema). Hace falta cuando un
// antivirus bloquea copias dentro de la carpeta temporal: algunos marcan las guías de seguridad de `vendor/` (traen
// ejemplos de código vulnerable) y la instalación del harness falla ahí con EPERM.
// Códigos: 0 PASS · 1 FAIL · 2 no se pudo correr (sin claude, sin credenciales, etc.)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const KIT = path.join(RAIZ, 'plugins', 'uaeh-kit');
const MARCA = '[uaeh-kit ctx v1]';
const CENTINELA = 'CENTINELA-7731';
const ORIGEN_GITHUB = 'sallouminc/uaeh-harness';
const MARKETPLACE = 'uaeh';
const PLUGINS = ['uaeh-kit', 'uaeh-harness'];

function claudeHomeReal() {
  const d = process.env.CLAUDE_CONFIG_DIR;
  return d && d.trim() ? path.resolve(d.trim()) : path.join(os.homedir(), '.claude');
}

function buscarEnTranscripts(dir, aguja) {
  const vistos = [];
  const recorrer = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.jsonl')) { vistos.push(p); }
    }
  };
  recorrer(dir);
  // La prueba de inyección es la línea `attachment` de tipo hook_additional_context que contiene la marca:
  // es lo que Claude Code adjuntó al contexto del modelo. La marca suelta en otra línea (p. ej. la respuesta
  // del modelo o la salida de una herramienta) no cuenta.
  for (const p of vistos) {
    try {
      const hay = fs.readFileSync(p, 'utf8').split('\n').some((l) => l.includes('"hook_additional_context"') && l.includes(aguja));
      if (hay) return { encontrado: true, archivo: p, revisados: vistos.length };
    } catch { /* sigue */ }
  }
  return { encontrado: false, archivo: null, revisados: vistos.length };
}

function main(argv) {
  const o = { modelo: 'haiku', conservar: false, json: false, github: null, base: os.tmpdir() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--modelo') { o.modelo = String(argv[++i] || ''); if (!/^[A-Za-z0-9._-]+$/.test(o.modelo)) { console.error(`modelo no válido: ${o.modelo}`); return 2; } }
    else if (argv[i] === '--conservar') o.conservar = true;
    else if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--base') { o.base = path.resolve(String(argv[++i] || '')); if (!fs.existsSync(o.base)) { console.error(`--base: no existe ${o.base}`); return 2; } }
    else if (argv[i] === '--desde-github') {
      const sig = argv[i + 1];
      if (sig && !sig.startsWith('--')) { o.github = sig; i++; } else o.github = ORIGEN_GITHUB;
      // El origen llega a una línea de comandos (en Windows, con shell): solo «dueño/repo» o una URL https sin caracteres raros.
      if (!/^(https:\/\/[A-Za-z0-9./_-]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.test(o.github)) { console.error(`origen no válido: ${o.github}`); return 2; }
    }
    else { console.error(`argumento desconocido: ${argv[i]}`); return 2; }
  }
  const informe = { pasos: [], veredicto: 'FAIL' };
  const paso = (nombre, ok, detalle) => { informe.pasos.push({ nombre, ok, detalle }); if (!o.json) console.log(`${ok ? 'OK   ' : 'FALLÓ'}  ${nombre}${detalle ? ' — ' + detalle : ''}`); };

  const cred = path.join(claudeHomeReal(), '.credentials.json');
  if (!fs.existsSync(cred)) { console.error('No hay .credentials.json en el perfil real: inicia sesión en Claude Code antes de correr esta prueba.'); return 2; }

  const base = fs.mkdtempSync(path.join(o.base, 'uaeh-perfil-limpio-'));
  const perfil = path.join(base, 'claude');
  const proyecto = path.join(base, 'proyecto-demo');
  const credTemp = path.join(perfil, '.credentials.json');
  try {
    fs.mkdirSync(perfil, { recursive: true });
    fs.mkdirSync(path.join(proyecto, 'tasks'), { recursive: true });
    fs.copyFileSync(cred, credTemp);
    fs.writeFileSync(path.join(perfil, 'settings.json'), JSON.stringify({ autoCompactWindow: 700000 }, null, 2));
    // Perfil nuevo = Claude Code pediría el recorrido inicial; en modo -p se marca como hecho.
    fs.writeFileSync(path.join(perfil, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }, null, 2));
    fs.writeFileSync(path.join(proyecto, 'tasks', 'context-map.md'), `# Mapa de contexto — proyecto-demo\n\nPalabra centinela para la prueba: ${CENTINELA}.\n\n## Qué es\nProyecto de demostración vacío.\n`);
    fs.writeFileSync(path.join(proyecto, 'README.md'), '# proyecto-demo\n');

    const env = { ...process.env, CLAUDE_CONFIG_DIR: perfil };
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    // El prompt va por stdin (claude -p lo lee cuando no hay argumento posicional): con shell en Windows,
    // un argumento con espacios y comillas llegaba troceado al modelo.
    const prompt = 'Responde EXACTAMENTE con dos lineas y nada mas. Linea 1: si en tu contexto de sistema aparece una marca entre corchetes que empieza por uaeh-kit, copiala textual; si no, escribe SIN MARCA. Linea 2: la palabra que empieza por CENTINELA- que aparece en el mapa de contexto del proyecto; si no la ves, escribe SIN MAPA.';
    let kitInstalado = null;
    if (o.github) {
      const cli = (a, ms) => spawnSync('claude', a, { cwd: proyecto, env, encoding: 'utf8', shell: process.platform === 'win32', timeout: ms, maxBuffer: 16 * 1024 * 1024 });
      const cola = (r) => (r.stderr || r.stdout || String(r.error || '')).trim().split('\n').slice(-3).join(' | ').slice(0, 400);
      const m = cli(['plugin', 'marketplace', 'add', o.github], 180000);
      paso(`marketplace add ${o.github}`, m.status === 0, m.status === 0 ? '' : cola(m));
      for (const p of PLUGINS) {
        const r = m.status === 0 ? cli(['plugin', 'install', `${p}@${MARKETPLACE}`], 180000) : { status: 1, stderr: 'no se intentó: el marketplace no se añadió' };
        paso(`plugin install ${p}@${MARKETPLACE}`, r.status === 0, r.status === 0 ? '' : cola(r));
      }
      const l = cli(['plugin', 'list', '--json'], 60000);
      let lista = [];
      try { const j = JSON.parse(l.stdout); lista = Array.isArray(j) ? j : (j.plugins || j.installed || []); } catch { /* sin lista */ }
      informe.instalados = {};
      for (const p of PLUGINS) {
        const e = lista.find((x) => x && (x.id === `${p}@${MARKETPLACE}` || x.name === p));
        informe.instalados[p] = e ? (e.version || '?') : null;
        const ok = !!e && e.enabled !== false;
        if (ok && p === 'uaeh-kit' && typeof e.installPath === 'string') kitInstalado = e.installPath;
        paso(`${p} instalado y habilitado en el perfil temporal`, ok, e ? `versión ${e.version || '?'}` : 'no aparece en `claude plugin list --json`');
      }
    }
    const args = o.github ? ['-p', '--model', o.modelo, '--output-format', 'json'] : ['-p', '--plugin-dir', KIT, '--model', o.modelo, '--output-format', 'json'];
    const inicio = Date.now();
    const r = spawnSync('claude', args, { cwd: proyecto, env, encoding: 'utf8', input: prompt, shell: process.platform === 'win32', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    const seg = ((Date.now() - inicio) / 1000).toFixed(1);
    if (r.error || r.status !== 0) {
      paso('claude -p en perfil limpio', false, `estado ${r.status} (${seg} s): ${(r.stderr || r.stdout || String(r.error)).trim().slice(0, 600)}`);
    } else {
      let texto = r.stdout;
      try { const j = JSON.parse(r.stdout); texto = typeof j.result === 'string' ? j.result : JSON.stringify(j); informe.costo_usd = j.total_cost_usd; informe.session_id = j.session_id; } catch { /* texto plano */ }
      informe.respuesta = texto.trim();
      paso('claude -p en perfil limpio', true, `${seg} s, modelo ${o.modelo}${informe.costo_usd != null ? `, ${informe.costo_usd.toFixed(4)} USD` : ''}`);
      paso('el modelo vio la marca', texto.includes(MARCA), `respuesta: ${texto.trim().replace(/\n/g, ' | ').slice(0, 200)}`);
      paso('el modelo vio el mapa (centinela)', texto.includes(CENTINELA));
    }
    const t = buscarEnTranscripts(path.join(perfil, 'projects'), MARCA);
    paso('la marca está en el transcript del perfil temporal', t.encontrado, t.encontrado ? path.relative(perfil, t.archivo) : `${t.revisados} transcript(s) revisados`);

    // Con --desde-github el doctor que corre es el INSTALADO (el de la caché del perfil temporal), no el de la copia de trabajo.
    let kitDoctor = KIT;
    if (o.github) {
      // La ruta la da `claude plugin list --json` (installPath); debe quedar DENTRO del perfil temporal.
      const dentro = kitInstalado && path.resolve(kitInstalado).toLowerCase().startsWith(path.resolve(perfil).toLowerCase() + path.sep);
      kitDoctor = dentro && fs.existsSync(path.join(kitInstalado, 'scripts', 'doctor.cjs')) ? kitInstalado : null;
      paso('el kit instalado está en la caché del perfil temporal', !!kitDoctor, kitDoctor ? path.relative(perfil, kitDoctor) : String(kitInstalado));
    }
    const d = !kitDoctor ? { stdout: '', stderr: 'sin kit instalado', status: null } : spawnSync(process.execPath, [path.join(kitDoctor, 'scripts', 'doctor.cjs'), '--capa', 'kit', '--json', '--cwd', proyecto], { env, encoding: 'utf8', timeout: 60000 });
    let inyeccion = null;
    try { inyeccion = JSON.parse(d.stdout).comprobaciones.find((c) => c.id === 'inyeccion'); } catch { /* sin doctor */ }
    paso('doctor: inyeccion en OK contra el perfil temporal', !!(inyeccion && inyeccion.estado === 'OK'), inyeccion ? `${inyeccion.estado} — ${inyeccion.detalle}` : `doctor no devolvió JSON (estado ${d.status}): ${(d.stderr || '').trim().slice(0, 300)}`);

    informe.veredicto = informe.pasos.every((p) => p.ok) ? 'PASS' : 'FAIL';
    informe.perfil = o.conservar ? perfil : null;
  } finally {
    try { fs.rmSync(credTemp, { force: true }); } catch { /* nada */ }
    if (!o.conservar) { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* nada */ } }
  }
  if (o.json) console.log(JSON.stringify(informe, null, 2));
  else console.log(`\nprobar-perfil-limpio: ${informe.veredicto}${informe.perfil ? ` (perfil conservado sin credenciales en ${informe.perfil})` : ''}`);
  return informe.veredicto === 'PASS' ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { buscarEnTranscripts, MARCA, CENTINELA, ORIGEN_GITHUB };
