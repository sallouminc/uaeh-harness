#!/usr/bin/env node
// scripts/instalar-puertas.cjs — subcomando «puertas» de instalar.cjs: instala o repara las puertas de la capa 3.
//
//   node instalar.cjs puertas [seguridad|visual|codex|preflight|todas] [--aplicar] [--actualizar] [--reparar]
//                             [--consiento | --retirar] [--json]
//
// Parte del diagnóstico de doctor-puertas.cjs (modo rápido) y propone SOLO lo que falta:
//   seguridad  instalar.sh (escáneres, reglas, Docker, imágenes) y/o instalar-bin.sh (programas de la caja de arena,
//              validadores y /opt/uaeh/uaeh.conf con la carpeta de corridas y el usuario de la puerta). --actualizar
//              fuerza instalar-bin.sh (tras actualizar el plugin); --reparar fuerza los dos. En Windows, con --aplicar,
//              corre como root dentro de WSL y antes copia /opt/uaeh entero a /opt/uaeh-respaldo/<fecha>. En Linux
//              imprime los comandos con sudo para que los corra el usuario (pide su contraseña).
//   visual     playwright-cli global con el pin de wsl/herramientas.json y las dependencias de la autoprueba en la caché
//              (probar-visual.cjs --instalar, que además corre la autoprueba).
//   codex      consentimiento explícito: --consiento --aplicar pone codex.habilitado=true y la fecha en
//              codex.consentimiento de uaeh.config.json (con respaldo); --retirar --aplicar lo apaga. Codex manda la
//              copia limpia de cada repo auditado a OpenAI: sin consentimiento el auditor no corre.
//   preflight  viene completo en el plugin; solo se diagnostica.
// Nunca hace por su cuenta lo que pide administrador, contraseña o cierra sesiones ajenas: instalar WSL, sudo,
// wsl --terminate, instalar Chrome, codex login. Lo imprime como NOTA con el comando exacto.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const comun = require(path.join(__dirname, 'lib', 'comun.cjs'));
const configLib = require(path.join(__dirname, 'lib', 'config.cjs'));
const runner = require(path.join(__dirname, 'lib', 'runner.cjs'));

const RAIZ = path.resolve(__dirname, '..');
const PUERTAS = ['seguridad', 'visual', 'codex', 'preflight'];
const SEGUNDOS_INSTALAR = 1800;
const SEGUNDOS_BIN = 300;
const SEGUNDOS_NPM = 600;
const SEGUNDOS_VISUAL = 1200;
const RE_VERSION = /^\d+\.\d+\.\d+$/;

function cola(texto, n = 4) {
  return String(texto || '').replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-n).join(' | ');
}

function marca() {
  return comun.isoZona(comun.ahora()).replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

// Argv como una línea legible para el usuario (comillas solo donde hacen falta).
function linea(argv) {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(' ');
}

function porId(puerta) {
  return Object.fromEntries((puerta ? puerta.comprobaciones : []).map((c) => [c.id, c]));
}

// ── seguridad ─────────────────────────────────────────────────────────────────────────────

function seguridad(o, h, d) {
  const { accion, acciones } = h;
  const c = porId(d);
  const { config } = configLib.cargarConfig();
  const so = h.so || process.platform;
  if (c.plataforma && c.plataforma.estado === 'NO_INSTALADA') {
    acciones.push(accion('NOTA', null, `${c.plataforma.detalle}. La puerta de seguridad no se instala aquí.`));
    return;
  }
  if (c.motor && c.motor.estado === 'NO_INSTALADA') {
    if (so === 'win32') {
      const distro = config.wsl.distro;
      acciones.push(accion('NOTA', null, `Falta el motor de Linux (WSL2 con la distro ${distro}). Pasos que haces tú (piden administrador y a veces reiniciar):`, {
        snippet: [
          `1. PowerShell como administrador:  wsl --install -d Ubuntu-24.04`,
          '2. Abre Ubuntu, crea tu usuario y activa systemd:  printf "[boot]\\nsystemd=true\\n" | sudo tee -a /etc/wsl.conf',
          '3. En PowerShell:  wsl --shutdown',
          `4. En ${comun.rutaConfig()}: wsl.distro = "Ubuntu-24.04" y wsl.usuario = "<tu usuario de Ubuntu>"`,
          '5. Repite: node instalar.cjs puertas seguridad',
        ].join('\n'),
      }));
    } else {
      acciones.push(accion('NOTA', null, `${c.motor.detalle}: instala coreutils y repite.`));
    }
    return;
  }

  const estado = (id) => (c[id] ? c[id].estado : 'OMITIDA');
  const hayQue = (ids, estados) => ids.some((id) => estados.includes(estado(id)));
  const instalar = o.reparar || hayQue(['escaneres', 'reglas-semgrep', 'imagenes', 'docker'], ['NO_INSTALADA']);
  const bin = o.reparar || o.actualizar || instalar || hayQue(['programas', 'validadores', 'uaeh-conf'], ['NO_INSTALADA', 'AVISO', 'FALLÓ']);
  const dockerCaido = estado('docker') === 'FALLÓ';

  if (!instalar && !bin) {
    acciones.push(accion('SIN CAMBIOS', null, `la puerta de seguridad está instalada y al día (${d.estado})`));
    if (dockerCaido) acciones.push(accion('NOTA', null, `${c.docker.detalle}. Si acabas de instalar Docker: wsl --terminate ${config.wsl.distro} (cierra las terminales de Ubuntu) y repite.`));
    return;
  }

  // Usuario de la puerta: el configurado o, si no hay, el usuario por defecto de la distro (el que corre el doctor).
  const usuarioMotor = (c.sistema && /usuario (\S+)/.exec(c.sistema.detalle) || [])[1] || '';
  const usuario = config.wsl.usuario || usuarioMotor;
  const uaehConfig = require(path.join(__dirname, 'uaeh-config.cjs'));
  const baseMotor = runner.aRutaMotor(uaehConfig.runsDir({ config }), so);
  const wslDir = path.join(RAIZ, 'wsl');
  const envUsuario = usuario ? [`UAEH_USER=${usuario}`] : [];
  const pasos = [];
  if (instalar) pasos.push({ nombre: 'instalar.sh (escáneres, reglas, Docker, imágenes)', env: envUsuario, script: 'instalar.sh', segundos: SEGUNDOS_INSTALAR, fin: 'INSTALAR_OK' });
  if (bin) pasos.push({ nombre: `instalar-bin.sh (caja de arena, validadores, uaeh.conf con corridas en ${baseMotor})`, env: [...envUsuario, `UAEH_BASE=${baseMotor}`], script: 'instalar-bin.sh', segundos: SEGUNDOS_BIN, fin: 'INSTALAR_BIN_OK' });

  if (so !== 'win32') {
    const cmds = pasos.map((p) => linea(['sudo', 'env', ...p.env, 'bash', path.join(wslDir, p.script)]));
    acciones.push(accion('NOTA', null, 'En Linux estos pasos piden tu contraseña (sudo): córrelos tú, en este orden, y luego repite el diagnóstico:', { snippet: cmds.join('\n') }));
    return;
  }

  const distro = config.wsl.distro;
  const comoRoot = (resto) => ['wsl.exe', '-d', distro, '-u', 'root', '-e', ...resto];
  const respaldo = `/opt/uaeh-respaldo/${marca()}`;
  const argvRespaldo = comoRoot(['bash', '-c', `set -e; if [ -d /opt/uaeh ]; then mkdir -p ${respaldo}; cp -a /opt/uaeh/. ${respaldo}/; echo ${respaldo}; else echo sin-instalacion-previa; fi`]);
  const argvs = pasos.map((p) => ({ ...p, argv: comoRoot(['env', ...p.env, 'bash', runner.aRutaMotor(path.join(wslDir, p.script), so)]) }));

  if (!o.aplicar) {
    acciones.push(accion('HARÍA', null, `respaldo de /opt/uaeh en ${respaldo} (como root)`, { snippet: linea(argvRespaldo) }));
    for (const p of argvs) acciones.push(accion('HARÍA', null, p.nombre, { snippet: linea(p.argv) }));
    return;
  }
  const ejecutar = h.ejecutarMotor || ((argv, segundos) => runner.ejecutar(argv[0], argv.slice(1), { segundos }));
  const r0 = ejecutar(argvRespaldo, 300);
  if (r0.codigo !== 0) { acciones.push(accion('ERROR', null, `no se pudo respaldar /opt/uaeh: ${cola(r0.stderr || r0.stdout)}; no se instala nada`)); return; }
  acciones.push(accion('RESPALDO', null, `/opt/uaeh → ${cola(r0.stdout, 1)}`));
  for (const p of argvs) {
    const r = ejecutar(p.argv, p.segundos);
    if (r.codigo !== 0 || !String(r.stdout).includes(p.fin)) {
      acciones.push(accion('ERROR', null, `${p.nombre} falló (código ${r.codigo}${r.agotado ? ', tiempo agotado' : ''}): ${cola(r.stderr || r.stdout)}. Reversa: el respaldo de /opt/uaeh está en ${respaldo}`));
      return;
    }
    acciones.push(accion('HECHO', null, `${p.nombre}: ${p.fin}`));
  }
  if (instalar && (dockerCaido || estado('docker') === 'NO_INSTALADA')) {
    acciones.push(accion('NOTA', null, `Docker recién instalado: para que tu usuario entre al grupo docker corre tú «wsl --terminate ${distro}» (cierra las terminales de Ubuntu abiertas) y repite el diagnóstico.`));
  }
  acciones.push(accion('NOTA', null, `Prueba completa de la caja de arena (opcional, ~1 min): ${linea([...runner.prefijoMotor(config, so), 'bash', '/opt/uaeh/pruebas/probar-sandbox.sh'])}`));
}

// ── visual ────────────────────────────────────────────────────────────────────────────────

function visual(o, h, d) {
  const { accion, acciones } = h;
  const c = porId(d);
  const pines = comun.leerJson(path.join(RAIZ, 'wsl', 'herramientas.json')) || {};
  const pin = (pines.visual || {})['@playwright/cli'];
  const correr = h.ejecutarComando || ((comando, segundos) => {
    const r = spawnSync(comando, { shell: true, encoding: 'utf8', timeout: segundos * 1000, windowsHide: true });
    return { codigo: r.status == null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  });
  let algo = false;
  if (c['playwright-cli'] && ['NO_INSTALADA', 'AVISO'].includes(c['playwright-cli'].estado)) {
    algo = true;
    if (!RE_VERSION.test(String(pin))) acciones.push(accion('ERROR', null, 'wsl/herramientas.json no trae un pin válido de @playwright/cli'));
    else {
      const comando = `npm i -g @playwright/cli@${pin} --ignore-scripts`;
      if (!o.aplicar) acciones.push(accion('HARÍA', null, `instalar playwright-cli ${pin} (global)`, { snippet: comando }));
      else {
        const r = correr(comando, SEGUNDOS_NPM);
        acciones.push(r.codigo === 0 ? accion('HECHO', null, `playwright-cli ${pin} instalado`) : accion('ERROR', null, `${comando} falló: ${cola(r.stderr || r.stdout)}`));
      }
    }
  }
  if (c.chrome && c.chrome.estado === 'NO_INSTALADA') { algo = true; acciones.push(accion('NOTA', null, `${c.chrome.detalle} (lo instalas tú)`)); }
  if (c['config-global'] && c['config-global'].estado === 'FALLÓ') { algo = true; acciones.push(accion('NOTA', null, `${c['config-global'].detalle}. No se borra nada por ti.`)); }
  if (c.autoprueba && (c.autoprueba.estado === 'AVISO' || o.reparar)) {
    algo = true;
    const script = path.join(RAIZ, 'skills', 'uae-visual', 'pruebas', 'probar-visual.cjs');
    if (!o.aplicar) acciones.push(accion('HARÍA', null, 'instalar en la caché las dependencias de la autoprueba (pines de wsl/herramientas.json y el Chromium de Playwright, ~200 MB) y correrla', { snippet: linea(['node', script, '--instalar', '--sin-lighthouse']) }));
    else {
      const r = (h.nodeScript || ((s, args, seg) => {
        const x = spawnSync(process.execPath, [s, ...args], { encoding: 'utf8', timeout: seg * 1000, windowsHide: true });
        return { codigo: x.status == null ? -1 : x.status, stdout: x.stdout || '', stderr: x.stderr || '' };
      }))(script, ['--instalar', '--sin-lighthouse'], SEGUNDOS_VISUAL);
      if (r.codigo === 0) acciones.push(accion('HECHO', null, 'dependencias de la autoprueba instaladas y autoprueba visual en verde'));
      else acciones.push(accion('ERROR', null, `autoprueba visual: código ${r.codigo} (${r.codigo === 3 ? 'sin dependencias o sin navegador' : 'algún control falló'}): ${cola(r.stdout)}`));
    }
  }
  if (!algo) acciones.push(accion('SIN CAMBIOS', null, `la puerta visual está instalada (${d.estado})`));
  acciones.push(accion('NOTA', null, 'En cada proyecto que se audite: node instalar.cjs visual --proyecto <carpeta> (plantillas de Playwright + axe; nunca pisa archivos del proyecto)'));
}

// ── codex ─────────────────────────────────────────────────────────────────────────────────

function escribirConsentimiento(o, h, cambio) {
  const { accion, acciones } = h;
  const ruta = comun.rutaConfig();
  let datos = {};
  if (fs.existsSync(ruta)) {
    const texto = comun.leerTexto(ruta);
    try { datos = JSON.parse(texto); } catch (e) {
      acciones.push(accion('ERROR', ruta, `uaeh.config.json no parsea (${e.message}): corrígelo a mano; no se toca`));
      return false;
    }
    if (!datos || typeof datos !== 'object' || Array.isArray(datos)) { acciones.push(accion('ERROR', ruta, 'uaeh.config.json no es un objeto JSON; no se toca')); return false; }
  } else {
    datos = comun.leerJson(path.join(RAIZ, 'templates', 'uaeh.config.example.json')) || { version: 1 };
  }
  datos.codex = { ...(datos.codex && typeof datos.codex === 'object' ? datos.codex : {}), ...cambio };
  if (!o.aplicar) { acciones.push(accion('HARÍA', ruta, `codex.habilitado = ${cambio.habilitado}${cambio.consentimiento ? ` y codex.consentimiento = ${cambio.consentimiento}` : ''} (con respaldo)`)); return true; }
  if (h.escribirConRespaldo(acciones, ruta, Buffer.from(`${JSON.stringify(datos, null, 2)}\n`, 'utf8'))) {
    acciones.push(accion('HECHO', ruta, cambio.habilitado ? `Codex habilitado con consentimiento del ${cambio.consentimiento}` : 'Codex apagado: el auditor ya no envía código a OpenAI'));
    return true;
  }
  return false;
}

function codex(o, h, d) {
  const { accion, acciones } = h;
  const c = porId(d);
  const { config } = configLib.cargarConfig();
  const habilitado = config.codex.habilitado === true;
  acciones.push(accion('NOTA', null, 'Privacidad: el auditor Codex manda a OpenAI la copia limpia de cada repo auditado (sin .env ni archivos ignorados). Úsalo solo con repos que puedas compartir con ese proveedor.'));
  let vaHabilitado = habilitado;
  if (o.retirar) {
    if (!habilitado) acciones.push(accion('SIN CAMBIOS', comun.rutaConfig(), 'Codex ya está apagado'));
    else if (escribirConsentimiento(o, h, { habilitado: false, consentimiento: '' }) && o.aplicar) vaHabilitado = false;
    return;
  }
  if (o.consiento) {
    if (habilitado) acciones.push(accion('SIN CAMBIOS', comun.rutaConfig(), `Codex ya está habilitado${config.codex.consentimiento ? ` (consentimiento del ${config.codex.consentimiento})` : ''}`));
    else if (escribirConsentimiento(o, h, { habilitado: true, consentimiento: comun.isoZona(comun.ahora()).slice(0, 10) })) vaHabilitado = true;
  } else if (!habilitado) {
    acciones.push(accion('NOTA', comun.rutaConfig(), 'Codex está apagado (codex.habilitado=false) y la puerta de seguridad funciona sin él. Para habilitarlo con tu consentimiento: node instalar.cjs puertas codex --consiento --aplicar'));
    return;
  }
  if (!vaHabilitado) return;
  if (c.cli && c.cli.estado === 'NO_INSTALADA') acciones.push(accion('NOTA', null, 'Instala Codex CLI y entra con tu cuenta (lo haces tú): npm i -g @openai/codex  y luego  codex login'));
  else if (c.cli && c.cli.estado === 'AVISO') acciones.push(accion('NOTA', null, `${c.cli.detalle}`));
  if (c.sesion && c.sesion.estado === 'FALLÓ') acciones.push(accion('NOTA', null, 'Inicia sesión en Codex en tu terminal: codex login'));
  if (!c.aislamiento || c.aislamiento.estado !== 'OK') acciones.push(accion('NOTA', null, 'Antes de confiar en el auditor, prueba su aislamiento (consume cuota de Codex, ~2 min): node doctor-puertas.cjs --puerta codex --vivo'));
  acciones.push(accion('NOTA', null, 'Si además Codex construye en la modalidad UAEH (agentes uae_*.toml y AGENTS.md): node instalar.cjs codex'));
}

// ── preflight ─────────────────────────────────────────────────────────────────────────────

function preflight(o, h, d) {
  const { accion, acciones } = h;
  const fallos = d.comprobaciones.filter((c) => c.estado === 'FALLÓ');
  if (fallos.length) acciones.push(accion('ERROR', null, `el plugin está incompleto (${fallos.map((c) => `${c.id}: ${c.detalle}`).join(' · ')}): reinstálalo`));
  else acciones.push(accion('SIN CAMBIOS', null, `el preflight viene completo en el plugin; no hay nada que instalar (${d.estado})`));
}

// ── Entrada ───────────────────────────────────────────────────────────────────────────────

const INSTALADORES = { seguridad, visual, codex, preflight };

// h: { accion, escribirConRespaldo, diagnostico?, ejecutarMotor?, ejecutarComando?, nodeScript?, so? }
function puertas(o, h) {
  const acciones = [];
  const ayuda = { ...h, acciones };
  const lista = !o.puerta || o.puerta === 'todas' ? PUERTAS : [o.puerta];
  const diagnosticar = h.diagnostico || ((ps) => require(path.join(__dirname, 'doctor-puertas.cjs')).ejecutar({ puertas: ps, rapido: true }));
  const antes = diagnosticar(lista);
  for (const p of antes.puertas) {
    acciones.push(h.accion('NOTA', null, `== ${p.puerta}: ${p.estado}`));
    INSTALADORES[p.puerta](o, ayuda, p);
  }
  let despues = null;
  if (o.aplicar && acciones.some((a) => a.tipo === 'HECHO')) {
    despues = diagnosticar(lista);
    acciones.push(h.accion('NOTA', null, `Diagnóstico tras instalar: ${despues.puertas.map((p) => `${p.puerta} ${p.estado}`).join(' · ')} (detalle: node doctor-puertas.cjs)`));
  }
  const resumen = (inf) => (inf ? inf.puertas.map((p) => ({ puerta: p.puerta, estado: p.estado })) : null);
  return { acciones, codigo: acciones.some((a) => a.tipo === 'ERROR') ? 1 : 0, diagnostico: { antes: resumen(antes), despues: resumen(despues) } };
}

module.exports = { PUERTAS, puertas, linea };
