#!/usr/bin/env node
// hooks/linea-inicio.cjs — SessionStart del arnés UAEH (plugin uaeh-harness). Informativo: nunca bloquea.
//
// Una línea al modelo (hookSpecificOutput.additionalContext) SOLO cuando hay algo que hacer:
//   · la guarda de git no está instalada (no existe el espejo <UAEH_HOME>/estable/uaeh-harness) → cómo instalarla;
//   · el espejo trae otra VERSION que el plugin → cómo actualizarlo (los hooks de git corren desde el espejo);
//   · uaeh.config.json tiene avisos (clave desconocida, valor inválido) → se listan (máximo 3);
//   · el repo de la sesión tiene sello de preflight → su estado en una línea (vigente: no repetir; cambió o venció:
//     incremental de lo cambiado). Informativa: el preflight solo corre antes de lanzar o a pedido. Sin sello, calla.
// Si todo está en orden no imprime nada: cero costo de contexto. Cualquier error → silencio, código 0.
// Habla al arrancar y tras /clear (el modelo empieza sin contexto); al compactar o reanudar, no.
'use strict';

const fs = require('fs');
const path = require('path');

function principal() {
  const comun = require(path.join(__dirname, '..', 'scripts', 'lib', 'comun.cjs'));
  const configLib = require(path.join(__dirname, '..', 'scripts', 'lib', 'config.cjs'));
  const entrada = comun.leerStdinJson();
  // Al compactar o reanudar la sesión el aviso ya se dio: solo en el arranque real y tras /clear.
  if (entrada && entrada.source && entrada.source !== 'startup' && entrada.source !== 'clear') return null;

  const version = comun.versionPlugin();
  const espejo = configLib.espejoHarness();
  const lineas = [];
  const instalador = `node "${path.join(path.resolve(__dirname, '..'), 'scripts', 'instalar.cjs').replace(/\\/g, '/')}" git-guard --aplicar`;

  let versionEspejo = null;
  try { versionEspejo = fs.readFileSync(path.join(espejo, 'VERSION'), 'utf8').trim(); } catch { versionEspejo = null; }
  if (versionEspejo === null) {
    lineas.push(`UAEH arnés v${version}: la guarda de git no está instalada (falta el espejo ${espejo.replace(/\\/g, '/')}). ` +
      `Instálala con la skill setup del plugin o con: ${instalador}`);
  } else if (versionEspejo !== version) {
    lineas.push(`UAEH arnés: el espejo de la guarda de git está en v${versionEspejo} y el plugin en v${version}. Actualízalo: ${instalador}`);
  }

  const { avisos } = configLib.cargarConfig();
  if (avisos.length) {
    const vistos = avisos.slice(0, 3).join(' · ') + (avisos.length > 3 ? ` · y ${avisos.length - 3} más` : '');
    lineas.push(`UAEH arnés: uaeh.config.json tiene avisos: ${vistos}`);
  }

  let preflight = '';
  try {
    const huella = require(path.join(__dirname, '..', 'scripts', 'uaeh-huella.cjs'));
    preflight = huella.lineaVigia((entrada && entrada.cwd) || process.cwd(), { sinSello: false }) || '';
  } catch { preflight = ''; }
  if (preflight) lineas.push(preflight);
  if (!lineas.length) return null;
  return comun.salidaHook('SessionStart', lineas.join('\n'));
}

try {
  const salida = principal();
  if (salida) process.stdout.write(JSON.stringify(salida));
} catch { /* informativo: nunca rompe la sesión */ }
process.exitCode = 0;
