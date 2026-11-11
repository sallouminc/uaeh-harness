#!/usr/bin/env node
// scripts/instalar.cjs — instalador de la capa 1 del método UAEH (plugin uaeh-kit).
//
// Uso: node instalar.cjs <subcomando> [opciones]
//   claude-md   [--global | --proyecto <dir>] [--idioma es|en] [--quitar] [--aplicar] [--json]
//   settings    [--quitar] [--aplicar] [--json]
//   statusline  [--quitar] [--aplicar] [--json]
//   proyecto    <dir> [--nombre <texto>] [--aplicar] [--json]
//   todo        [--idioma es|en] [--quitar] [--aplicar] [--json]   (claude-md global + settings + statusline; con --quitar, en orden inverso)
//
// Reglas de este script:
//   · EN SECO por defecto: imprime qué cambiaría. Solo escribe con --aplicar.
//   · Antes de pisar un archivo existente deja <archivo>.uaeh-respaldo-<AAAAMMDD-HHmmss> a su lado
//     (hora de ahora() en la zona efectiva; si el nombre ya existe, se numera: nunca se pisa un respaldo).
//   · Solo borra con --quitar (la reversa de cada subcomando; nunca de oficio) y únicamente lo que el propio
//     instalador puso:
//       claude-md   → el bloque UAEH del CLAUDE.md.
//       settings    → env.CLAUDE_CODE_SUBAGENT_MODEL y autoCompactWindow, SOLO si su valor actual es exactamente el de
//                     templates/settings-snippet.json (si el usuario lo cambió, se conserva y se avisa con NOTA); el objeto
//                     "env" se quita solo si la retirada lo deja vacío. Ninguna otra clave se toca.
//       statusline  → "statusLine" de settings.json SOLO si apunta al espejo del kit, y los archivos que el subcomando copió
//                     al espejo (los de COPIAS_ESPEJO, VERSION y package.json; nunca la carpeta estable/ entera, porque el
//                     plugin uaeh-harness escribe en estable/uaeh-harness/), más las carpetas que esa retirada deje vacías.
//       todo        → las tres reversas, en orden inverso.
//     Los archivos del espejo son copias del plugin: se borran sin respaldo. settings.json y CLAUDE.md sí se respaldan.
//     Idempotente: la segunda corrida dice «nada que hacer». Un settings.json roto no se toca.
//   · Las rutas de estado salen de lib/comun.cjs; las plantillas y los archivos del plugin, de __dirname.
//   · Si un settings.json no parsea, no se toca: se imprime lo que hay que pegar a mano.
//   · statusline deja en el espejo (<UAEH_HOME>/estable) los archivos de la barra, VERSION y un package.json
//     {"type":"commonjs"}: así un "type":"module" de cualquier carpeta ancestro no rompe los .js del espejo.
//   · Salida humana: una línea por acción «TIPO  detalle», con TIPO ∈ HARÍA | HECHO | SIN CAMBIOS |
//     RESPALDO | FALTA | NOTA | ERROR. Con --json: { subcomando, aplicado, acciones:[{tipo, ruta, detalle}], codigo }.
//   · Código de salida: 0 bien · 1 error (p. ej. settings.json roto) · 2 uso incorrecto.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const comun = require(path.join(__dirname, 'lib', 'comun.cjs'));

const RAIZ = path.resolve(__dirname, '..');
const PLANTILLAS = path.join(RAIZ, 'templates');
const MARCA_NOMBRE = '{NOMBRE DEL PROYECTO}';
const ANCHO_TIPO = 11; // «SIN CAMBIOS»
const BOM = String.fromCharCode(0xFEFF); // marca de orden de bytes UTF-8 (U+FEFF)

// package.json del espejo. Declara CommonJS: si algún package.json ANCESTRO del espejo dijera "type":"module",
// los .js de la barra dejarían de cargar («require is not defined»). Con este archivo, el más cercano manda.
const PACKAGE_ESPEJO = '{"type":"commonjs"}\n';

// Archivos del plugin que se copian al espejo de ruta fija (estableDir). El origen es relativo a la raíz
// del plugin y el destino, relativo al espejo: conservan la misma disposición para que la barra
// encuentre a sus hermanos con __dirname.
const COPIAS_ESPEJO = [
  'statusline/statusline.js',
  'statusline/claude-status-fetch.js',
  'scripts/ventana-contexto.cjs',
  'scripts/lib/comun.cjs',
];

// ── Acciones y salida ─────────────────────────────────────────────────────────────────────

function accion(tipo, ruta, detalle, extra) {
  return Object.assign({ tipo, ruta: ruta || null, detalle }, extra || {});
}

// Una línea por acción. Si la ruta no va ya dentro del detalle, se añade al final.
function formatearAccion(a) {
  const detalle = String(a.detalle == null ? '' : a.detalle);
  const sufijo = a.ruta && !detalle.includes(a.ruta) ? `  → ${a.ruta}` : '';
  return `${String(a.tipo).padEnd(ANCHO_TIPO)}  ${detalle}${sufijo}`;
}

function formatearHumano(informe) {
  const lineas = [];
  let pasoPrevio = null;
  for (const a of informe.acciones) {
    if (a.paso && a.paso !== pasoPrevio) { lineas.push(`[${a.paso}]`); pasoPrevio = a.paso; }
    lineas.push(formatearAccion(a));
    if (a.snippet) lineas.push('', a.snippet, '');
  }
  const hay = (tipo) => informe.acciones.some((a) => a.tipo === tipo);
  if (!informe.aplicado) {
    lineas.push(hay('HARÍA')
      ? 'En seco: no se escribió nada. Repite el comando con --aplicar para ejecutar lo anterior.'
      : 'En seco: no hay nada que cambiar.');
  } else {
    const hechos = informe.acciones.filter((a) => a.tipo === 'HECHO').length;
    const respaldos = informe.acciones.filter((a) => a.tipo === 'RESPALDO').length;
    lineas.push(`Aplicado: ${hechos} cambio(s), ${respaldos} respaldo(s).`);
  }
  return lineas.join('\n');
}

// ── Respaldos y escritura ─────────────────────────────────────────────────────────────────

// 20261030-200000: hora de ahora() en la zona efectiva (UAEH_TZ > config > sistema).
function marcaTiempo() {
  const tz = comun.zonaHoraria(comun.cargarConfig().config);
  return comun.isoZona(comun.ahora(), tz).slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

// Nunca devuelve un nombre que ya exista: dos respaldos en el mismo segundo no se pisan.
function rutaRespaldo(ruta) {
  const base = `${ruta}.uaeh-respaldo-${marcaTiempo()}`;
  let candidato = base;
  for (let n = 2; fs.existsSync(candidato); n++) candidato = `${base}-${n}`;
  return candidato;
}

function claveRuta(ruta) {
  const r = path.resolve(ruta);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// Archivos que esta corrida ya respaldó o creó. Un archivo que se reescribe en dos pasos (settings.json en
// `todo`) deja UN solo respaldo —el del estado original—, no uno por paso con estados intermedios.
const tocadosEnCorrida = new Set();

// Respalda (si el archivo existe) y escribe. `contenido` puede ser texto, Buffer u objeto (→ JSON de la
// biblioteca común). Devuelve true si escribió; si falla, anota un ERROR y devuelve false.
function escribirConRespaldo(acciones, ruta, contenido) {
  try {
    const clave = claveRuta(ruta);
    if (fs.existsSync(ruta) && !tocadosEnCorrida.has(clave)) {
      const respaldo = rutaRespaldo(ruta);
      fs.copyFileSync(ruta, respaldo, fs.constants.COPYFILE_EXCL);
      acciones.push(accion('RESPALDO', respaldo, `copia de ${ruta}`));
    }
    tocadosEnCorrida.add(clave);
    if (typeof contenido === 'string' || Buffer.isBuffer(contenido)) {
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      fs.writeFileSync(ruta, contenido);
    } else {
      comun.escribirJson(ruta, contenido);
    }
    return true;
  } catch (e) {
    acciones.push(accion('ERROR', ruta, `no se pudo escribir: ${e.message}`));
    return false;
  }
}

// Texto con detección de BOM (para devolverlo igual al reescribir). { existe, texto, bom, error? }
// La decodificación es ESTRICTA: un archivo que no sea UTF-8 válido (p. ej. guardado en Windows-1252) no se
// lee con caracteres de reemplazo, porque al reescribirlo se perderían sus bytes originales.
function leerArchivo(ruta) {
  if (!fs.existsSync(ruta)) return { existe: false, texto: '', bom: false };
  try {
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(ruta));
    const bom = raw.charCodeAt(0) === 0xFEFF;
    return { existe: true, texto: bom ? raw.slice(1) : raw, bom };
  } catch (e) {
    const motivo = e instanceof TypeError ? 'no es UTF-8 válido' : e.message;
    return { existe: true, texto: '', bom: false, error: motivo };
  }
}

// ── Bloque UAEH dentro de un CLAUDE.md ────────────────────────────────────────────────────

// Localiza el bloque con los marcadores de la biblioteca común. Exige UN solo BEGIN y UN solo END en ese
// orden: ante cualquier otra cosa (marcador huérfano, duplicado, invertido) el estado es 'danado' y no se
// toca el archivo, porque adivinar qué borrar podría llevarse texto del usuario.
function localizarBloque(texto) {
  const inicios = [...texto.matchAll(new RegExp(comun.BLOQUE_INICIO.source, 'g'))];
  const fines = [...texto.matchAll(new RegExp(comun.BLOQUE_FIN.source, 'g'))];
  if (!inicios.length && !fines.length) return { estado: 'ausente' };
  if (inicios.length !== 1 || fines.length !== 1) {
    return { estado: 'danado', motivo: `hay ${inicios.length} marcador(es) UAEH:BEGIN y ${fines.length} UAEH:END; debe haber uno de cada uno` };
  }
  const b = inicios[0];
  const e = fines[0];
  if (e.index < b.index) return { estado: 'danado', motivo: 'UAEH:END aparece antes que UAEH:BEGIN' };
  return { estado: 'presente', inicio: b.index, fin: e.index + e[0].length, version: b[1] || null };
}

// Bloque de la plantilla (ES o EN) con {{VERSION}} resuelta: desde BEGIN hasta END inclusive, en LF.
function bloqueDePlantilla(idiomaElegido) {
  const archivo = idiomaElegido === 'en' ? 'bloque-claude-md.en.md' : 'bloque-claude-md.md';
  const ruta = path.join(PLANTILLAS, archivo);
  const crudo = comun.leerTexto(ruta);
  if (crudo == null) throw new Error(`falta la plantilla ${ruta}`);
  const texto = crudo.replace(/\r\n/g, '\n').split('{{VERSION}}').join(comun.versionPlugin());
  const loc = localizarBloque(texto);
  if (loc.estado !== 'presente') throw new Error(`la plantilla ${archivo} no trae un solo par de marcadores UAEH:BEGIN / UAEH:END`);
  return texto.slice(loc.inicio, loc.fin);
}

// Añade el bloque al final con una línea en blanco antes. `bloque` ya viene con el fin de línea `eol`.
function anadirBloque(original, bloque, eol) {
  if (original === '') return bloque + eol;
  let saltos = 0;
  let i = original.length;
  while (i > 0 && original[i - 1] === '\n') {
    saltos++;
    i--;
    if (i > 0 && original[i - 1] === '\r') i--;
  }
  const separador = saltos >= 2 ? '' : (saltos === 1 ? eol : eol + eol);
  return original + separador + bloque + eol;
}

// Quita el bloque y, a lo sumo, UNA línea en blanco contigua (primero la anterior; si no hay, la posterior).
function quitarBloque(original, loc) {
  let antes = original.slice(0, loc.inicio);
  let despues = original.slice(loc.fin).replace(/^[ \t]*\r?\n/, ''); // resto de la línea del marcador END
  if (/\r?\n[ \t]*\r?\n$/.test(antes)) antes = antes.replace(/[ \t]*\r?\n$/, '');
  else despues = despues.replace(/^[ \t]*\r?\n/, '');
  return antes + despues;
}

function textoVersion(v) { return v ? `v${v}` : '(sin versión)'; }
function contarLineas(texto) { return texto.split(/\r?\n/).length; }

// ── claude-md ─────────────────────────────────────────────────────────────────────────────

function claudeMd(o) {
  const acciones = [];
  const destino = o.proyecto
    ? path.join(path.resolve(o.proyecto), 'CLAUDE.md')
    : path.join(comun.claudeHome(), 'CLAUDE.md');
  const lectura = leerArchivo(destino);
  if (lectura.error) return [accion('ERROR', destino, `no se pudo leer (${lectura.error}); no se tocó el archivo`)];

  const original = lectura.texto;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const loc = localizarBloque(original);
  if (loc.estado === 'danado') {
    return [accion('ERROR', destino, `bloque UAEH dañado (${loc.motivo}); arréglalo a mano y vuelve a correr. No se tocó el archivo.`)];
  }
  const prefijo = lectura.bom ? BOM : '';
  const aplicar = !!o.aplicar;
  const conRespaldo = lectura.existe ? ' (con respaldo)' : '';

  if (o.quitar) {
    if (loc.estado === 'ausente') {
      return [accion('SIN CAMBIOS', destino, `sin cambios (no hay bloque UAEH en ${destino})`)];
    }
    const viejo = textoVersion(loc.version);
    const lineas = contarLineas(original.slice(loc.inicio, loc.fin));
    const nuevo = quitarBloque(original, loc);
    if (!aplicar) {
      acciones.push(accion('HARÍA', destino, `se quitaría el bloque ${viejo} (${lineas} líneas) de ${destino}${conRespaldo}`));
    } else if (escribirConRespaldo(acciones, destino, prefijo + nuevo)) {
      acciones.push(accion('HECHO', destino, `bloque ${viejo} quitado de ${destino}${nuevo.trim() === '' ? ' (el archivo queda vacío)' : ''}`));
    }
    return acciones;
  }

  let bloque;
  try { bloque = bloqueDePlantilla(o.idioma || comun.idioma(comun.cargarConfig().config)); } catch (e) {
    return [accion('ERROR', null, e.message)];
  }
  const version = comun.versionPlugin();
  const lineas = contarLineas(bloque);
  const bloqueEol = bloque.replace(/\n/g, eol);

  let nuevo;
  if (loc.estado === 'ausente') nuevo = anadirBloque(original, bloqueEol, eol);
  else nuevo = original.slice(0, loc.inicio) + bloqueEol + original.slice(loc.fin);

  if (lectura.existe && nuevo === original) {
    return [accion('SIN CAMBIOS', destino, `sin cambios (${destino} ya tiene el bloque v${version})`)];
  }

  if (loc.estado === 'ausente') {
    const nota = lectura.existe ? '' : ' (el archivo se crearía)';
    if (!aplicar) {
      acciones.push(accion('HARÍA', destino, `se añadiría el bloque v${version} (${lineas} líneas) a ${destino}${nota}${conRespaldo}`));
    } else if (escribirConRespaldo(acciones, destino, prefijo + nuevo)) {
      acciones.push(accion('HECHO', destino, `bloque v${version} añadido (${lineas} líneas) a ${destino}${lectura.existe ? '' : ' (archivo nuevo)'}`));
    }
  } else {
    const viejo = textoVersion(loc.version);
    const cambio = viejo === `v${version}` ? `${viejo} → v${version} (contenido distinto)` : `${viejo} → v${version}`;
    if (!aplicar) {
      acciones.push(accion('HARÍA', destino, `se reemplazaría ${cambio} en ${destino}${conRespaldo}`));
    } else if (escribirConRespaldo(acciones, destino, prefijo + nuevo)) {
      acciones.push(accion('HECHO', destino, `bloque reemplazado ${cambio} en ${destino}`));
    }
  }
  return acciones;
}

// ── settings ──────────────────────────────────────────────────────────────────────────────

// { estado: 'ausente' | 'vacio' | 'ok' | 'roto', datos, motivo }. Un archivo vacío se trata como {}.
function leerSettings(ruta) {
  const lectura = leerArchivo(ruta);
  if (!lectura.existe) return { estado: 'ausente', datos: {} };
  if (lectura.error) return { estado: 'roto', motivo: lectura.error };
  const texto = lectura.texto;
  if (!texto.trim()) return { estado: 'vacio', datos: {} };
  let datos;
  try { datos = JSON.parse(texto); } catch (e) { return { estado: 'roto', motivo: e.message }; }
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return { estado: 'roto', motivo: 'la raíz no es un objeto JSON' };
  return { estado: 'ok', datos };
}

function leerSnippetSettings() {
  const ruta = path.join(PLANTILLAS, 'settings-snippet.json');
  const snippet = comun.leerJson(ruta);
  if (!snippet || typeof snippet !== 'object' || Array.isArray(snippet)) throw new Error(`falta o no parsea la plantilla ${ruta}`);
  return snippet;
}

// Primer modelSettings.<modelo>.autoCompactWindow definido, o null.
function compactacionPorModelo(datos) {
  const porModelo = datos.modelSettings;
  if (!porModelo || typeof porModelo !== 'object' || Array.isArray(porModelo)) return null;
  for (const [modelo, valores] of Object.entries(porModelo)) {
    if (valores && typeof valores === 'object' && valores.autoCompactWindow != null) {
      return { modelo, valor: valores.autoCompactWindow };
    }
  }
  return null;
}

// Fusión pura: solo agrega lo que falta. Devuelve { salida, cambios } o { error }.
function mezclarSettings(datos, snippet) {
  const salida = JSON.parse(JSON.stringify(datos));
  const cambios = [];
  const env = snippet && snippet.env && typeof snippet.env === 'object' ? snippet.env : {};
  if (Object.keys(env).length && salida.env != null && (typeof salida.env !== 'object' || Array.isArray(salida.env))) {
    return { error: '"env" existe pero no es un objeto' };
  }
  for (const [clave, valor] of Object.entries(env)) {
    const actual = salida.env == null ? undefined : salida.env[clave];
    if (actual !== undefined) {
      cambios.push({ clave: `env.${clave}`, estado: 'ya definido', valor: actual });
    } else {
      if (salida.env == null) salida.env = {};
      salida.env[clave] = valor;
      cambios.push({ clave: `env.${clave}`, estado: 'agregado', valor });
    }
  }
  if (snippet && snippet.autoCompactWindow !== undefined) {
    const porModelo = compactacionPorModelo(salida);
    if (salida.autoCompactWindow !== undefined) {
      cambios.push({ clave: 'autoCompactWindow', estado: 'ya definido', valor: salida.autoCompactWindow });
    } else if (porModelo) {
      cambios.push({ clave: 'autoCompactWindow', estado: 'ya definido', valor: porModelo.valor, origen: `modelSettings.${porModelo.modelo}.autoCompactWindow` });
    } else {
      salida.autoCompactWindow = snippet.autoCompactWindow;
      cambios.push({ clave: 'autoCompactWindow', estado: 'agregado', valor: snippet.autoCompactWindow });
    }
  }
  return { salida, cambios };
}

function detalleCambio(c) {
  if (c.estado === 'agregado') return `${c.clave}: agregado (${JSON.stringify(c.valor)})`;
  const donde = c.origen ? `${c.origen} = ${JSON.stringify(c.valor)}` : JSON.stringify(c.valor);
  return `${c.clave}: ya definido (${donde})`;
}

function errorSettingsRoto(destino, motivo, snippet) {
  return accion('ERROR', destino,
    `no se pudo usar como JSON (${motivo}); no se tocó. Pega a mano este bloque en el archivo, fusionándolo con lo que ya tenga:`,
    { snippet: JSON.stringify(snippet, null, 2) });
}

function settings(o) {
  if (o.quitar) return quitarSettings(o);
  const destino = path.join(comun.claudeHome(), 'settings.json');
  let snippet;
  try { snippet = leerSnippetSettings(); } catch (e) { return [accion('ERROR', null, e.message)]; }
  const lectura = leerSettings(destino);
  if (lectura.estado === 'roto') return [errorSettingsRoto(destino, lectura.motivo, snippet)];

  const { salida, cambios, error } = mezclarSettings(lectura.datos, snippet);
  if (error) return [errorSettingsRoto(destino, error, snippet)];

  const acciones = [];
  const agregados = cambios.filter((c) => c.estado === 'agregado');
  const nota = lectura.estado === 'ausente' ? ' (archivo nuevo)' : (agregados.length ? ' (con respaldo)' : '');
  if (agregados.length && o.aplicar && !escribirConRespaldo(acciones, destino, salida)) return acciones;
  for (const c of cambios) {
    if (c.estado === 'agregado') {
      acciones.push(accion(o.aplicar ? 'HECHO' : 'HARÍA', destino, detalleCambio(c) + (o.aplicar ? '' : nota)));
    } else {
      acciones.push(accion('SIN CAMBIOS', destino, detalleCambio(c)));
    }
  }
  return acciones;
}

// Reversa de mezclarSettings. Quita solo lo que ese instalador habría puesto Y conserva su valor exacto.
// Devuelve { salida, items } (items: {clave, estado: 'quitar'|'ausente'|'distinto', valor?, esperado?}) o { error }.
function desmezclarSettings(datos, snippet) {
  const salida = JSON.parse(JSON.stringify(datos));
  const items = [];
  const env = snippet && snippet.env && typeof snippet.env === 'object' ? snippet.env : {};
  const hayEnv = Object.keys(env).length > 0;
  if (hayEnv && salida.env != null && (typeof salida.env !== 'object' || Array.isArray(salida.env))) {
    return { error: '"env" existe pero no es un objeto' };
  }
  let quitadosDeEnv = 0;
  for (const [clave, esperado] of Object.entries(env)) {
    const actual = salida.env == null ? undefined : salida.env[clave];
    if (actual === undefined) items.push({ clave: `env.${clave}`, estado: 'ausente' });
    else if (isDeepStrictEqual(actual, esperado)) { delete salida.env[clave]; quitadosDeEnv++; items.push({ clave: `env.${clave}`, estado: 'quitar', valor: actual }); }
    else items.push({ clave: `env.${clave}`, estado: 'distinto', valor: actual, esperado });
  }
  if (quitadosDeEnv > 0 && Object.keys(salida.env).length === 0) {
    delete salida.env;
    items.push({ clave: 'env', estado: 'quitar', vacio: true });
  }
  if (snippet && snippet.autoCompactWindow !== undefined) {
    const actual = salida.autoCompactWindow;
    if (actual === undefined) items.push({ clave: 'autoCompactWindow', estado: 'ausente' });
    else if (isDeepStrictEqual(actual, snippet.autoCompactWindow)) { delete salida.autoCompactWindow; items.push({ clave: 'autoCompactWindow', estado: 'quitar', valor: actual }); }
    else items.push({ clave: 'autoCompactWindow', estado: 'distinto', valor: actual, esperado: snippet.autoCompactWindow });
  }
  return { salida, items };
}

// Claves (con punto) que el snippet pone: para las instrucciones de borrado manual.
function clavesDelSnippet(snippet) {
  const lista = Object.keys(snippet.env && typeof snippet.env === 'object' ? snippet.env : {}).map((k) => `env.${k}`);
  if (snippet.autoCompactWindow !== undefined) lista.push('autoCompactWindow');
  return lista;
}

function quitarSettings(o) {
  const destino = path.join(comun.claudeHome(), 'settings.json');
  let snippet;
  try { snippet = leerSnippetSettings(); } catch (e) { return [accion('ERROR', null, e.message)]; }
  const lectura = leerSettings(destino);
  if (lectura.estado === 'ausente') return [accion('SIN CAMBIOS', destino, `no existe ${destino}: nada que hacer`)];
  if (lectura.estado === 'roto') {
    return [accion('ERROR', destino, `no se pudo usar como JSON (${lectura.motivo}); no se tocó. Quita a mano, si existen, estas claves: ${clavesDelSnippet(snippet).join(', ')}`)];
  }
  const { salida, items, error } = desmezclarSettings(lectura.datos, snippet);
  if (error) return [accion('ERROR', destino, `${error}; no se tocó el archivo`)];

  const acciones = [];
  const quitados = items.filter((c) => c.estado === 'quitar');
  if (quitados.length && o.aplicar && !escribirConRespaldo(acciones, destino, salida)) return acciones;
  for (const c of items) {
    if (c.estado === 'quitar') {
      const que = c.vacio ? 'objeto vacío tras la retirada, quitado' : `quitado (${JSON.stringify(c.valor)})`;
      acciones.push(accion(o.aplicar ? 'HECHO' : 'HARÍA', destino, `${c.clave}: ${que}${o.aplicar ? '' : ' (con respaldo)'}`));
    } else if (c.estado === 'distinto') {
      acciones.push(accion('NOTA', destino, `${c.clave}: el valor actual (${JSON.stringify(c.valor)}) no es el que puso el kit (${JSON.stringify(c.esperado)}); se conserva`));
    } else {
      acciones.push(accion('SIN CAMBIOS', destino, `${c.clave}: no está; nada que hacer`));
    }
  }
  return acciones;
}

// ── statusline ────────────────────────────────────────────────────────────────────────────

function comandoBarra() {
  const espejo = comun.estableDir().replace(/\\/g, '/');
  return `node "${espejo}/statusline/statusline.js"`;
}

// ¿El comando de la barra apunta dentro del espejo? (barras normalizadas; sin distinguir mayúsculas en Windows)
function apuntaAlEspejo(comando) {
  if (typeof comando !== 'string') return false;
  const normalizar = (s) => {
    const n = s.replace(/\\/g, '/');
    return process.platform === 'win32' ? n.toLowerCase() : n;
  };
  return normalizar(comando).includes(`${normalizar(comun.estableDir())}/`);
}

// Copia un archivo del plugin al espejo si falta o cambió (con respaldo si ya existía y era distinto).
function sincronizar(acciones, aplicar, nuevo, destino, etiqueta) {
  const existe = fs.existsSync(destino);
  if (existe) {
    let actual = null;
    try { actual = fs.readFileSync(destino); } catch { actual = null; }
    if (actual && actual.equals(nuevo)) {
      acciones.push(accion('SIN CAMBIOS', destino, `${etiqueta}: ya está al día`));
      return;
    }
  }
  if (!aplicar) {
    acciones.push(accion('HARÍA', destino, `${existe ? 'actualizar (con respaldo)' : 'copiar'} ${etiqueta}`));
    return;
  }
  if (escribirConRespaldo(acciones, destino, nuevo)) {
    acciones.push(accion('HECHO', destino, `${etiqueta}: ${existe ? 'actualizado' : 'copiado'}`));
  }
}

function configurarBarra(acciones, aplicar) {
  const destino = path.join(comun.claudeHome(), 'settings.json');
  const comando = comandoBarra();
  const bloque = { statusLine: { type: 'command', command: comando } };
  const snippet = JSON.stringify(bloque, null, 2);
  const lectura = leerSettings(destino);
  if (lectura.estado === 'roto') { acciones.push(errorSettingsRoto(destino, lectura.motivo, bloque)); return; }

  const actual = lectura.datos.statusLine;
  if (actual == null) {
    const nota = lectura.estado === 'ausente' ? ' (archivo nuevo)' : ' (con respaldo)';
    if (!aplicar) {
      acciones.push(accion('HARÍA', destino, `statusLine: se añadiría ${comando}${nota}`));
    } else if (escribirConRespaldo(acciones, destino, { ...lectura.datos, statusLine: bloque.statusLine })) {
      acciones.push(accion('HECHO', destino, `statusLine: añadida ${comando}`));
    }
    return;
  }
  const propio = actual && typeof actual === 'object' ? actual.command : undefined;
  if (apuntaAlEspejo(propio)) {
    acciones.push(accion('SIN CAMBIOS', destino, 'statusLine: ya configurada (apunta al espejo del kit)'));
    return;
  }
  acciones.push(accion('SIN CAMBIOS', destino,
    'statusLine: barra propia; no se toca. Si prefieres la del kit, reemplaza tu statusLine por este bloque:',
    { snippet }));
}

// Reversa de statusline. 1) statusLine de settings.json (solo si apunta al espejo); 2) archivos copiados al
// espejo (solo los que copia statusline); 3) carpetas que eso deje vacías, hasta el propio espejo.
function quitarStatusline(o) {
  const acciones = [];
  const aplicar = !!o.aplicar;
  const destino = path.join(comun.claudeHome(), 'settings.json');
  const lectura = leerSettings(destino);
  if (lectura.estado === 'ausente' || lectura.estado === 'vacio') {
    acciones.push(accion('SIN CAMBIOS', destino, 'statusLine: no hay settings.json con contenido; nada que hacer'));
  } else if (lectura.estado === 'roto') {
    // Sin leer settings.json no se sabe si su statusLine apunta al espejo: borrar el espejo dejaría la barra
    // apuntando a un archivo que ya no existe. No se toca nada.
    acciones.push(accion('ERROR', destino, `no se pudo usar como JSON (${lectura.motivo}); no se tocó, y el espejo tampoco. Arréglalo (o quita a mano su "statusLine" del kit) y repite el comando`));
    return acciones;
  } else {
    const actual = lectura.datos.statusLine;
    const comando = actual && typeof actual === 'object' ? actual.command : undefined;
    if (actual == null) {
      acciones.push(accion('SIN CAMBIOS', destino, 'statusLine: no está; nada que hacer'));
    } else if (!apuntaAlEspejo(comando)) {
      acciones.push(accion('SIN CAMBIOS', destino, 'statusLine: barra propia (no apunta al espejo del kit); no se toca'));
    } else if (!aplicar) {
      acciones.push(accion('HARÍA', destino, `statusLine: se quitaría ${JSON.stringify(comando)} (con respaldo)`));
    } else {
      const resto = { ...lectura.datos };
      delete resto.statusLine;
      if (escribirConRespaldo(acciones, destino, resto)) acciones.push(accion('HECHO', destino, `statusLine: quitada ${JSON.stringify(comando)}`));
    }
  }

  const espejo = comun.estableDir();
  const rels = [...COPIAS_ESPEJO, 'VERSION', 'package.json'];
  const presentes = rels.filter((rel) => {
    try { return fs.lstatSync(path.join(espejo, ...rel.split('/'))).isFile(); } catch { return false; }
  });
  if (!presentes.length) {
    acciones.push(accion('SIN CAMBIOS', espejo, `espejo: no hay archivos del kit en ${espejo}; nada que hacer`));
    return acciones;
  }
  const carpetas = new Set();
  for (const rel of presentes) {
    const ruta = path.join(espejo, ...rel.split('/'));
    if (!aplicar) { acciones.push(accion('HARÍA', ruta, `borrar ${rel} del espejo`)); continue; }
    try {
      fs.unlinkSync(ruta);
      acciones.push(accion('HECHO', ruta, `${rel}: borrado del espejo`));
      for (let d = path.dirname(ruta); d.length > espejo.length; d = path.dirname(d)) carpetas.add(d);
      carpetas.add(espejo);
    } catch (e) {
      acciones.push(accion('ERROR', ruta, `${rel}: no se pudo borrar (${e.message})`));
    }
  }
  // De la más profunda a la más superficial; rmdir solo borra carpetas vacías.
  for (const d of [...carpetas].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(d); acciones.push(accion('HECHO', d, `carpeta vacía quitada: ${d}`)); } catch { /* no está vacía o ya no existe: se deja */ }
  }
  return acciones;
}

function statusline(o) {
  if (o.quitar) return quitarStatusline(o);
  const acciones = [];
  const aplicar = !!o.aplicar;
  const espejo = comun.estableDir();
  for (const rel of COPIAS_ESPEJO) {
    const origen = path.join(RAIZ, ...rel.split('/'));
    if (!fs.existsSync(origen)) {
      acciones.push(accion('FALTA', origen, `${rel}: no existe en el plugin; no se copia`));
      continue;
    }
    let contenido;
    try { contenido = fs.readFileSync(origen); } catch (e) {
      acciones.push(accion('ERROR', origen, `${rel}: no se pudo leer (${e.message})`));
      continue;
    }
    sincronizar(acciones, aplicar, contenido, path.join(espejo, ...rel.split('/')), rel);
  }
  sincronizar(acciones, aplicar, Buffer.from(`${comun.versionPlugin()}\n`, 'utf8'), path.join(espejo, 'VERSION'), 'VERSION');
  sincronizar(acciones, aplicar, Buffer.from(PACKAGE_ESPEJO, 'utf8'), path.join(espejo, 'package.json'), 'package.json');
  configurarBarra(acciones, aplicar);
  return acciones;
}

// ── proyecto ──────────────────────────────────────────────────────────────────────────────

// Rutas relativas (con «/») de todos los archivos bajo `dir`, ordenadas.
function listarArchivos(dir, prefijo = '') {
  const salida = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefijo ? `${prefijo}/${e.name}` : e.name;
    if (e.isDirectory()) salida.push(...listarArchivos(path.join(dir, e.name), rel));
    else if (e.isFile()) salida.push(rel);
  }
  return salida.sort();
}

function proyecto(o) {
  const dir = path.resolve(o.dir);
  const nombre = (o.nombre && o.nombre.trim()) || path.basename(dir) || 'proyecto';
  const origen = path.join(PLANTILLAS, 'proyecto');
  if (!fs.existsSync(origen)) return [accion('ERROR', origen, 'falta la carpeta de plantillas templates/proyecto')];
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) return [accion('ERROR', dir, 'la ruta existe y no es una carpeta')];

  const acciones = [];
  for (const rel of listarArchivos(origen)) {
    const destino = path.join(dir, ...rel.split('/'));
    if (fs.existsSync(destino)) {
      acciones.push(accion('SIN CAMBIOS', destino, 'existe (no se toca)'));
      continue;
    }
    if (!o.aplicar) {
      acciones.push(accion('HARÍA', destino, `crear ${rel}`));
      continue;
    }
    const plantilla = comun.leerTexto(path.join(origen, ...rel.split('/')));
    if (plantilla == null) { acciones.push(accion('ERROR', destino, `no se pudo leer la plantilla ${rel}`)); continue; }
    if (escribirConRespaldo(acciones, destino, plantilla.split(MARCA_NOMBRE).join(nombre))) {
      acciones.push(accion('HECHO', destino, `creado ${rel}`));
    }
  }
  return acciones;
}

// ── todo ──────────────────────────────────────────────────────────────────────────────────

function todo(o) {
  const q = !!o.quitar;
  const pasos = [
    ['claude-md', () => claudeMd({ aplicar: o.aplicar, idioma: o.idioma, quitar: q })],
    ['settings', () => settings({ aplicar: o.aplicar, quitar: q })],
    ['statusline', () => statusline({ aplicar: o.aplicar, quitar: q })],
  ];
  if (q) pasos.reverse(); // la reversa deshace en orden inverso: barra, settings, CLAUDE.md
  const acciones = [];
  for (const [paso, correrPaso] of pasos) {
    let resultado;
    try { resultado = correrPaso(); } catch (e) { resultado = [accion('ERROR', null, `error inesperado: ${e.message}`)]; }
    for (const a of resultado) acciones.push({ paso, ...a });
  }
  return acciones;
}

// ── Línea de comandos ─────────────────────────────────────────────────────────────────────

const SUBCOMANDOS = {
  'claude-md': { booleanas: ['global', 'quitar', 'aplicar', 'json'], valores: ['proyecto', 'idioma'], posicional: false, ejecutar: claudeMd },
  settings: { booleanas: ['quitar', 'aplicar', 'json'], valores: [], posicional: false, ejecutar: settings },
  statusline: { booleanas: ['quitar', 'aplicar', 'json'], valores: [], posicional: false, ejecutar: statusline },
  proyecto: { booleanas: ['aplicar', 'json'], valores: ['nombre'], posicional: true, ejecutar: proyecto },
  todo: { booleanas: ['quitar', 'aplicar', 'json'], valores: ['idioma'], posicional: false, ejecutar: todo },
};

function uso() {
  return [
    'Uso: node instalar.cjs <subcomando> [opciones]',
    '  claude-md   [--global | --proyecto <dir>] [--idioma es|en] [--quitar] [--aplicar] [--json]',
    '  settings    [--quitar] [--aplicar] [--json]',
    '  statusline  [--quitar] [--aplicar] [--json]',
    '  proyecto    <dir> [--nombre <texto>] [--aplicar] [--json]',
    '  todo        [--idioma es|en] [--quitar] [--aplicar] [--json]   (claude-md global + settings + statusline; --quitar los deshace en orden inverso)',
    'Sin --aplicar solo se muestra qué cambiaría. Lo que se pisa deja respaldo <archivo>.uaeh-respaldo-<fecha>.',
  ].join('\n');
}

// → { error } | { ayuda:true } | { subcomando, opciones }
function parsearArgumentos(argv) {
  if (!argv.length) return { error: 'falta el subcomando' };
  if (['--ayuda', '--help', '-h'].includes(argv[0])) return { ayuda: true };
  const subcomando = argv[0];
  const def = SUBCOMANDOS[subcomando];
  if (!def) return { error: `subcomando desconocido: ${subcomando}` };

  const opciones = {};
  const posicionales = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (['--ayuda', '--help', '-h'].includes(a)) return { ayuda: true };
    if (!a.startsWith('--')) { posicionales.push(a); continue; }
    let nombre = a.slice(2);
    let valor;
    const eq = nombre.indexOf('=');
    if (eq >= 0) { valor = nombre.slice(eq + 1); nombre = nombre.slice(0, eq); }
    if (def.booleanas.includes(nombre)) {
      if (valor !== undefined) return { error: `--${nombre} no lleva valor` };
      opciones[nombre] = true;
    } else if (def.valores.includes(nombre)) {
      if (valor === undefined) {
        valor = argv[++i];
        if (valor === undefined || valor.startsWith('--')) return { error: `falta el valor de --${nombre}` };
      }
      opciones[nombre] = valor;
    } else {
      return { error: `opción desconocida para ${subcomando}: ${a}` };
    }
  }
  if (def.posicional) {
    if (posicionales.length !== 1) return { error: `${subcomando} necesita exactamente una carpeta: ${subcomando} <dir>` };
    opciones.dir = posicionales[0];
  } else if (posicionales.length) {
    return { error: `argumento inesperado: ${posicionales[0]}` };
  }
  if (opciones.idioma !== undefined && !['es', 'en'].includes(opciones.idioma)) return { error: `--idioma debe ser es o en (recibido: ${opciones.idioma})` };
  if (opciones.global && opciones.proyecto !== undefined) return { error: '--global y --proyecto son excluyentes' };
  return { subcomando, opciones };
}

// Corre un subcomando ya parseado y arma el informe. Nunca lanza.
// El plugin uaeh-harness (si está) mide con su sello de integridad settings.json, el CLAUDE.md global y la carpeta estable:
// cambiarlos mientras otra terminal tiene una revisión en curso anula su veredicto. El kit no depende del harness, así que
// solo mira si hay fotos recientes del sello y AVISA (no se niega: quien decide es el usuario). Nunca lanza.
const SELLO_RECIENTE_MIN = 90;
function fotosRecientesDelSello() {
  try {
    const dir = path.join(comun.uaehHome(), 'integridad');
    const limite = Date.now() - SELLO_RECIENTE_MIN * 60 * 1000;
    return fs.readdirSync(dir).filter((n) => n.endsWith('.foto.json') && fs.statSync(path.join(dir, n)).mtimeMs >= limite).length;
  } catch { return 0; }
}
function tocaLoQueMideElSello(subcomando, opciones) {
  if (subcomando === 'settings' || subcomando === 'statusline' || subcomando === 'todo') return true;
  return subcomando === 'claude-md' && !opciones.proyecto;
}

function ejecutar(subcomando, opciones) {
  let acciones;
  tocadosEnCorrida.clear();
  try {
    acciones = SUBCOMANDOS[subcomando].ejecutar({ ...opciones, aplicar: !!opciones.aplicar });
  } catch (e) {
    acciones = [accion('ERROR', null, `error inesperado: ${e && e.message ? e.message : e}`)];
  }
  if (tocaLoQueMideElSello(subcomando, opciones)) {
    const n = fotosRecientesDelSello();
    if (n) acciones.unshift(accion('NOTA', null, `hay ${n} foto(s) del sello de integridad de los últimos ${SELLO_RECIENTE_MIN} min: si otra terminal tiene una revisión en curso (uaeh-harness), este cambio puede anular su veredicto. Conviene esperar a que termine.`));
  }
  const codigo = acciones.some((a) => a.tipo === 'ERROR') ? 1 : 0;
  return { subcomando, aplicado: !!opciones.aplicar, acciones, codigo };
}

function main(argv) {
  const r = parsearArgumentos(argv);
  if (r.ayuda) { console.log(uso()); return 0; }
  if (r.error) { console.error(`instalar: ${r.error}`); console.error(uso()); return 2; }
  const informe = ejecutar(r.subcomando, r.opciones);
  if (r.opciones.json) console.log(JSON.stringify(informe, null, 2));
  else console.log(formatearHumano(informe));
  return informe.codigo;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  main, ejecutar, parsearArgumentos, uso, formatearAccion, formatearHumano,
  claudeMd, settings, statusline, proyecto, todo, desmezclarSettings,
  localizarBloque, bloqueDePlantilla, anadirBloque, quitarBloque, mezclarSettings,
  marcaTiempo, rutaRespaldo, comandoBarra, apuntaAlEspejo,
};
