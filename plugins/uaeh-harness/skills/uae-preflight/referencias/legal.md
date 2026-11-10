# Matriz legal y de privacidad contextual — preflight (uae-preflight)

Fuente de verdad: este archivo (origen: el Playbook UAEH del autor, no publicado).

**No es asesoría legal.** El preflight identifica requisitos y genera una lista de verificación; no emite un dictamen definitivo ni reemplaza la asesoría jurídica de la jurisdicción que aplique. La aplicabilidad de cada regla depende del país de operación, la ubicación de los usuarios, la naturaleza del producto y los contratos.

**Jurisdicción:** la de la configuración de UAEH (`preflight.jurisdiccion`). Si está vacía, la que muestren los hechos del repo (dominio, moneda, idioma, aviso de privacidad existente), marcada `POR_CONFIRMAR`.

## Decisiones que debe tomar el preflight

| Pregunta | Efecto sobre revisión |
|---|---|
| ¿Recolecta datos personales? | Aviso de privacidad, finalidad, transferencias, retención, ejercicio de derechos y seguridad |
| ¿Datos de salud, biometría o especialmente sensibles? | Consentimiento cuando corresponda, control reforzado, evaluación de impacto y revisión profesional |
| ¿Usuarios o clientes en otras jurisdicciones? | Evaluar RGPD (GDPR), leyes estatales, normas de consumo y transferencias transfronterizas |
| ¿Cobra suscripciones? | Precio final, renovación, cancelación, reembolsos, facturación, condiciones de tiendas |
| ¿Usa IA con datos de usuarios? | Transparencia, encargados/subprocesadores, retención, entrenamiento, revisión humana |
| ¿Emite señales de inversión, custodia/mueve dinero o presta servicios de salud? | Análisis regulatorio especializado; no asumir que un disclaimer exime requisitos |
| ¿Tiene empleados, socios, externos o proveedores? | Cesión de IP, NDA, contratos, accesos, DPA y gobierno de la sociedad |
| ¿Opera marketplace o contenido de usuarios? | Política de uso, reclamos de PI, moderación y mecanismos de reporte |

## Paquete legal de producto (condicional)

1. **Identidad del operador** y canales de contacto adecuados; datos legales coherentes con la entidad real.
2. **Términos y condiciones**: aceptación, descripción precisa, límites legítimos, propiedad intelectual, contenido usuario, suspensión, disputas.
3. **Privacidad**: categorías de datos, finalidades, bases/consentimientos aplicables, transferencias, terceros, plazos y los derechos de las personas sobre sus datos según la jurisdicción (por ejemplo, ARCO en México: acceso, rectificación, cancelación y oposición; en la Unión Europea, los del RGPD).
4. **Política de cookies** y consentimiento para tecnologías no esenciales según jurisdicción y uso real.
5. **Planes/suscripciones**: precios, impuestos, renovación, periodo de prueba, cancelación y política de reembolso conforme a ley/canal de venta.
6. **Uso y riesgos de IA**: limitaciones, qué datos se envían, intervención humana y alcance del producto.
7. **Riesgos sectoriales**: salud, finanzas/trading, turismo médico, servicios profesionales u otros.
8. **Uso aceptable y propiedad intelectual** cuando hay contenido cargado o publicado por usuarios.
9. **Evidencia de aceptación**: versión, fecha, finalidad y aceptación separada cuando corresponda.
10. **Flujos UX legales**: registro, checkout, primer uso sensible, cambio de política, exportación y cierre de cuenta.

## Documentos corporativos internos (según forma societaria)

- Constitución/documentos registrales.
- Acuerdo de fundadores y accionistas, reglas de salida y toma de decisiones.
- Cap table y cesión de propiedad intelectual del software, diseño y contenido.
- Acuerdos de confidencialidad; contratos de prestación de servicios y de personal.
- ESOP/participación si existe; contratos con encargados de datos y proveedores.
- Licencias de software, derechos sobre assets y contratos de IA/infraestructura.

## Regla legal de calidad

Cada hallazgo se clasifica como `APLICA`, `NO_APLICA`, `POR_CONFIRMAR` o `REQUIERE_ABOGADO`, con la jurisdicción, el hecho que activa el requisito, la evidencia y la fuente normativa. **Nunca copiar afirmaciones específicas como obligaciones universales**: por ejemplo, días fijos de reembolso, consentimiento transfronterizo, autoridad competente, plazos de aviso, avisos de cookies o exenciones PCI; deben verificarse para la fecha y el caso real.
