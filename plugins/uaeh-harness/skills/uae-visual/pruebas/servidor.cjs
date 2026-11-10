// Servidor estatico minimo para el fixture de la puerta visual (skill uae-visual). Solo 127.0.0.1.
// Env: PUERTO (4173 por defecto), SITIO (carpeta relativa al cwd; por defecto sitio-buena).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const puerto = Number(process.env.PUERTO || 4173);
const raiz = path.resolve(process.cwd(), process.env.SITIO || 'sitio-buena');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  let ruta;
  try { ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { ruta = null; }
  const noEncontrado = () => { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('No encontrado'); };
  if (ruta === null || ruta.includes('\0')) return noEncontrado();
  const destino = path.resolve(raiz, '.' + (ruta === '/' ? '/index.html' : ruta));
  // Nunca salir de la raiz: se compara el prefijo ya resuelto.
  if (destino !== raiz && !destino.startsWith(raiz + path.sep)) return noEncontrado();
  fs.readFile(destino, (err, datos) => {
    if (err) return noEncontrado();
    res.writeHead(200, { 'content-type': MIME[path.extname(destino).toLowerCase()] || 'application/octet-stream' });
    res.end(datos);
  });
}).listen(puerto, '127.0.0.1');
