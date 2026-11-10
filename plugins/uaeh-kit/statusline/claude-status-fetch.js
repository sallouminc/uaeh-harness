#!/usr/bin/env node
// claude-status-fetch.js — vigilante silencioso del estado oficial de Claude.
//
// Consulta https://status.claude.com (Statuspage, API pública y sin credenciales) y deja un resumen
// mínimo en <cache>/claude-status.json, que lee la barra de estado cuando `statusline.estadoClaude`
// está activo en uaeh.config.json. La barra lo lanza en segundo plano (detached) solo si el dato
// está viejo: este proceso no imprime nada, nunca bloquea la barra y tolera que no haya red.
//
// Caché (JSON): { indicator, level, message, description, fetched_at, attempted_at, source }
//   · attempted_at se escribe ANTES de abrir la conexión: así varias terminales no lanzan consultas
//     a la vez mientras una sigue en vuelo.
//   · Sin red, con respuesta inválida o con error HTTP se conserva el dato anterior; envejece y la
//     barra lo pinta en gris («sin datos»), nunca afirma «todo bien» a ciegas.
//
// Sin dependencias. Se copia al espejo <uaehHome>/estable/statusline/ junto con statusline.js y
// localiza ../scripts/lib/comun.cjs por __dirname.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

let comun = null;
try { comun = require(path.join(__dirname, '..', 'scripts', 'lib', 'comun.cjs')); } catch { comun = null; }

const URL_RESUMEN = 'https://status.claude.com/api/v2/summary.json';
const TIMEOUT_HTTP_MS = 5000;          // inactividad del socket
const LIMITE_TOTAL_MS = 15000;         // tope absoluto de la consulta, aunque el servidor gotee bytes
const MAX_CUERPO = 2 * 1024 * 1024;
const HUERFANO_MS = 60 * 60 * 1000;    // un .tmp más viejo que esto es residuo de una corrida anterior

// Las rutas se resuelven al llamar, no al cargar: así importar este módulo no toca nada.
function ahoraMs() {
  try { return comun.ahora().getTime(); } catch { return Date.now(); }
}

function rutaCache() {
  try { return path.join(comun.cacheDir(), 'claude-status.json'); } catch { return null; }
}

function leerCache() {
  try {
    const datos = comun.leerJson(rutaCache());
    return datos && typeof datos === 'object' && !Array.isArray(datos) ? datos : {};
  } catch { return {}; }
}

function pausa(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* sin pausa */ }
}

// Escritura atómica: .tmp + rename. Un lector nunca ve un JSON a medias.
function escribirCache(objeto) {
  const destino = rutaCache();
  if (!destino) return;
  const tmp = `${destino}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(objeto), 'utf8');
    // En Windows el rename falla con EPERM si la barra tiene el archivo abierto justo en ese
    // instante; lo suelta en milisegundos, así que se reintenta con pausas cortas.
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, destino); return; } catch (e) {
        if (i >= 3) throw e;
        pausa(40 * (i + 1));
      }
    }
  } catch { /* silencioso: sin dato fresco la barra degrada a gris */ } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* nunca romper por limpiar */ }
  }
}

// Barre los .tmp huérfanos de corridas anteriores para que el residuo no se acumule aunque algún
// rename haya fallado con el proceso ya terminado. La edad sale del reloj del sistema de archivos
// (fecha de modificación real), por eso aquí se usa Date.now() y no el reloj inyectable.
function barrerHuerfanos() {
  try {
    const destino = rutaCache();
    if (!destino) return;
    const dir = path.dirname(destino);
    const prefijo = `${path.basename(destino)}.`;
    const corte = Date.now() - HUERFANO_MS;
    for (const nombre of fs.readdirSync(dir)) {
      if (!nombre.startsWith(prefijo) || !nombre.endsWith('.tmp')) continue;
      const completo = path.join(dir, nombre);
      try { if (fs.statSync(completo).mtimeMs < corte) fs.unlinkSync(completo); } catch { /* en uso: caerá en el siguiente barrido */ }
    }
  } catch { /* nunca romper la consulta por limpiar */ }
}

// Convierte la respuesta de Statuspage en el resumen que lee la barra. Función pura: lo único
// externo es la hora, que se puede pasar para probarla.
function buildResult(json, ahora = ahoraMs()) {
  const estado = (json && json.status) || {};
  const indicator = String(estado.indicator || 'none');          // none | minor | major | critical | maintenance
  const description = String(estado.description || '');
  const incidentes = Array.isArray(json && json.incidents) ? json.incidents : [];
  const mantenimientos = Array.isArray(json && json.scheduled_maintenances) ? json.scheduled_maintenances : [];
  const componentes = Array.isArray(json && json.components) ? json.components : [];

  let message = '';          // «qué falla», en el idioma de la fuente oficial; vacío si todo está bien
  let level = indicator;     // decide el color

  if (indicator !== 'none') {
    const incidente = incidentes.find((i) => i && i.status !== 'resolved' && i.status !== 'completed');
    if (incidente && incidente.impact) level = String(incidente.impact);

    // «Qué falla» = nombre de los componentes que no están operativos (lo más concreto).
    const caidos = componentes
      .filter((c) => c && c.status && c.status !== 'operational' && !c.group)
      .map((c) => String(c.name || '').trim())
      .filter(Boolean);

    if (caidos.length) {
      message = caidos.slice(0, 2).join(', ') + (caidos.length > 2 ? '…' : '');
    } else if (incidente && incidente.name) {
      message = String(incidente.name);
    } else if (indicator === 'maintenance') {
      const m = mantenimientos.find((x) => x && x.status !== 'completed');
      message = (m && m.name) ? String(m.name) : 'Mantenimiento en curso';
    } else {
      message = description || 'Problema en el servicio';
    }
  }

  return { indicator, level, message, description, fetched_at: ahora, attempted_at: ahora, source: 'summary' };
}

// Descarga y parsea el resumen oficial. Llama a `alTerminar(json)` con el objeto, o con `null` si algo
// falló (sin red, tiempo agotado, respuesta distinta de 200, cuerpo enorme, JSON inválido). Está
// aislada para poder sustituirla en las pruebas: la lógica de caché se prueba sin red.
function descargarResumen(alTerminar) {
  let terminado = false;
  let req = null;
  const fin = (valor) => {
    if (terminado) return;
    terminado = true;
    clearTimeout(limite);
    alTerminar(valor);
  };
  const limite = setTimeout(() => { fin(null); try { if (req) req.destroy(); } catch { /* ya cerrada */ } }, LIMITE_TOTAL_MS);
  limite.unref();
  try {
    req = https.get(
      URL_RESUMEN,
      { timeout: TIMEOUT_HTTP_MS, headers: { 'User-Agent': 'uaeh-kit-statusline' } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); fin(null); return; }
        let cuerpo = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          cuerpo += c;
          if (cuerpo.length > MAX_CUERPO) { req.destroy(); fin(null); }
        });
        res.on('end', () => { try { fin(JSON.parse(cuerpo)); } catch { fin(null); } });
        res.on('error', () => fin(null));
      }
    );
    req.on('timeout', () => { req.destroy(); fin(null); });
    req.on('error', () => fin(null));
  } catch { fin(null); }
}

// Una consulta completa: limpia residuos, marca el intento, descarga y guarda el resultado.
function consultar(descargar = descargarResumen) {
  barrerHuerfanos();
  escribirCache(Object.assign({}, leerCache(), { attempted_at: ahoraMs() }));
  descargar((json) => {
    // Solo se guarda una respuesta con forma de Statuspage: un 200 ajeno (portal cautivo, proxy)
    // no debe pintar un «todo bien» verde.
    if (json && typeof json === 'object' && json.status && typeof json.status === 'object') escribirCache(buildResult(json));
  });
}

if (require.main === module) consultar();

module.exports = { buildResult, consultar };
