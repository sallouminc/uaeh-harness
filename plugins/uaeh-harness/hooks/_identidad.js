#!/usr/bin/env node
// hooks/_identidad.js — compuerta por identidad para los candados del arnés UAEH.
//
// En un plugin, los hooks de PreToolUse corren en TODAS las sesiones y dentro de TODOS los subagentes (el frontmatter
// de un agente no admite `hooks`). Un candado como solo-lectura.js solo debe aplicar a los agentes revisores, así que
// mira quién ejecuta la herramienta: el evento trae `agent_type` cuando viene de un subagente («uae-verifier» o, en un
// agente de plugin, «uaeh-harness:uae-verifier»); en la sesión principal no viene.
//
// Reglas (decisión D6 del diseño):
//   · Sin `agent_type` (sesión principal), tipo no listado en candados.json, o candados.json ilegible → el candado NO
//     aplica (fail-open por identidad desconocida; documentado). El candado se pone donde sí se sabe quién es.
//   · Tipo listado → aplica, y la lógica del candado sigue siendo la de siempre (falla cerrado).
//   · El prefijo del plugin se quita con split(':').pop(): el nombre del agente es lo que se compara.
'use strict';

const fs = require('fs');
const path = require('path');

const RUTA_CANDADOS = path.join(__dirname, 'candados.json');

// Nombre del agente sin el prefijo del plugin ('' si el evento no trae agent_type de texto).
function tipoAgente(entrada) {
  const t = entrada && entrada.agent_type;
  if (typeof t !== 'string' || !t.trim()) return '';
  return t.trim().split(':').pop();
}

// Lista de agentes de un candado según candados.json; null si el archivo no se puede leer o no trae ese candado.
function agentesDe(nombreCandado) {
  try {
    let texto = fs.readFileSync(RUTA_CANDADOS, 'utf8');
    if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1); // tolera un BOM (editores de Windows)
    const datos = JSON.parse(texto);
    const lista = datos && datos[nombreCandado];
    return Array.isArray(lista) ? lista.filter((x) => typeof x === 'string') : null;
  } catch { return null; }
}

// ¿El candado `nombreCandado` aplica a quien ejecuta este evento?
//   → { aplica: boolean, tipo: string, aviso: string|null }   (aviso: candados.json ilegible o sin esa clave)
function evaluar(nombreCandado, entrada) {
  const tipo = tipoAgente(entrada);
  if (!tipo) return { aplica: false, tipo: '', aviso: null };
  const lista = agentesDe(nombreCandado);
  if (lista === null) return { aplica: false, tipo, aviso: `candados.json ilegible o sin la clave "${nombreCandado}": el candado no aplica a ${tipo}` };
  return { aplica: lista.includes(tipo), tipo, aviso: null };
}

function candadoAplica(nombreCandado, entrada) {
  return evaluar(nombreCandado, entrada).aplica;
}

module.exports = { RUTA_CANDADOS, tipoAgente, agentesDe, evaluar, candadoAplica };
