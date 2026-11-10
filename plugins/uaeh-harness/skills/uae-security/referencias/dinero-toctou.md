# Unidad obligatoria: dinero y transacciones

Aplica a todo proyecto que mueva dinero, comisiones, saldos, pagos, créditos o cupos: apps con comisiones, saldos, pagos o créditos. Se siembra como unidad propia en el libro de cobertura (`attack_class` de lógica de negocio / concurrencia).

Qué se busca (con cita y, si aplica, PoC en la caja de arena con `--bd`):
1. **Leer-decidir-escribir separados (TOCTOU):** `SELECT saldo` → `if` → `UPDATE`. Lo correcto es UNA operación condicionada (`UPDATE … SET saldo = saldo - x WHERE id = ? AND saldo >= x`) o un bloqueo explícito (`SELECT … FOR UPDATE` dentro de transacción). PoC: N peticiones concurrentes contra la base desechable y comparar el saldo final con el esperado.
2. **Idempotencia:** doble clic / reintento / webhook repetido no duplica el cargo ni el abono (llave de idempotencia, `UNIQUE` sobre el id externo).
3. **Montos del cliente:** precio, descuento, comisión, tipo de cambio o moneda nunca vienen del navegador; se recalculan en el servidor. Montos negativos, cero o con decimales extra.
4. **Webhooks de pago:** firma verificada antes de tocar el estado; tolerancia a reintentos.
5. **Bitácora:** todo movimiento deja rastro inmutable (quién, cuándo, cuánto, antes/después).
6. **Gasto ilimitado en APIs de pago (IA incluida):** tope por usuario y tope global diario.

Si el proyecto documenta sus reglas de negocio (skills o docs propios), un hallazgo de cálculo se valida contra ellas, no contra intuición.
