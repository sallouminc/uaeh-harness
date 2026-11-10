// Plantilla de la puerta visual UAEH (skill uae-visual): configuracion de pruebas visuales deterministas.
// Se copia al proyecto como playwright.visual.config.ts. No gasta tokens de modelo.
import { defineConfig } from '@playwright/test';

const URL_BASE = process.env.UAEH_VISUAL_URL || 'http://127.0.0.1:4173';

export default defineConfig({
  // Donde viven las pruebas visuales (separadas de las pruebas funcionales).
  testDir: 'tests/visual',
  // Evidencias del navegador: van a test-results/, que esta fuera de git.
  outputDir: 'test-results/visual',
  // Las baselines NUNCA se escriben solas: solo con --update-snapshots
  // explicito y despues de la aprobacion humana. Sin baseline = falla "no verificado".
  updateSnapshots: 'none',
  // Sin reintentos: el resultado debe ser repetible y honesto.
  retries: 0,
  expect: {
    toHaveScreenshot: {
      // Sin animaciones para que la captura sea estable.
      animations: 'disabled',
      // Cero pixeles de diferencia permitidos (threshold por defecto de Playwright).
      maxDiffPixels: 0,
    },
  },
  // Lista en consola + JSON que lee scripts/clasificar-resultados.cjs.
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/visual/resultado.json' }],
  ],
  use: {
    baseURL: URL_BASE,
    // Se usa el Chromium propio de Playwright (sin "channel") para estabilidad de pixeles.
  },
  projects: [
    {
      name: 'movil-360',
      // isMobile en false: asi el ancho de layout es de verdad 360 y no se reescala.
      use: { viewport: { width: 360, height: 800 }, deviceScaleFactor: 1, isMobile: false },
    },
    {
      name: 'escritorio-1440',
      use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false },
    },
  ],
  // En proyectos reales UAEH_VISUAL_SERVIDOR sera p. ej. "npm run start".
  // Con UAEH_VISUAL_SIN_SERVIDOR=1 no se levanta nada (se prueba una URL ya viva o apagada).
  webServer:
    process.env.UAEH_VISUAL_SIN_SERVIDOR === '1' || !process.env.UAEH_VISUAL_SERVIDOR
      ? undefined
      : {
          command: process.env.UAEH_VISUAL_SERVIDOR,
          url: URL_BASE,
          // Si ya hay un servidor vivo en esa URL, se reutiliza.
          reuseExistingServer: true,
          timeout: 60000,
        },
});
