# Changelog

## 2026-10-26 — Integración con el servicio de visión del Equipo 2

Al crear una observación (`POST /api/v1/observaciones`) el backend llama ahora al
modelo YOLO del Equipo 2 y aplica el resultado antes de responder al cliente.

### Flujo

1. `observacion` + `imagen` + `historial(null → recibido)` se crean en una
   transacción.
2. `vision.service.solicitarInferencia(id, path)` firma la URL del archivo en
   Supabase Storage (TTL 600 s) y hace `POST` al `VISION_API_URL` con
   `x-api-key` y timeout de 30 s.
3. Con la respuesta se inserta una fila en `prediccion` (append-only) y la
   observación transiciona según el `estado` del modelo:
   - `identificado` + especie sembrada  → `identificado` (fija `especie_aceptada_id`).
   - `identificado` + especie desconocida → `pendiente_experto` (predicción con `especie_propuesta_id = NULL`).
   - `no_concluyente`                   → `pendiente_experto`.
4. Si el servicio de visión falla (`SERVICIO_VISION_NO_DISPONIBLE` o cualquier
   otro error), la observación queda en `no_concluyente` con motivo
   "Servicio de visión no disponible". El error **no** se propaga al cliente:
   la observación ya existe.

Cada transición queda registrada en `historial_estado`.

### Cambios

- Nuevo `src/services/vision.service.js` — cliente HTTP del Equipo 2.
- `src/services/observaciones.service.js` — tras el commit de creación, se
  ejecuta la inferencia en una transacción separada (`procesarInferencia`,
  `aplicarInferenciaExitosa`, `transicionarEstado`). El `INSERT imagen` ahora
  devuelve `id` para enlazar `prediccion.imagen_id`.
- `.env.example` — añadidas `VISION_API_URL` y `VISION_API_KEY`.
- Tests nuevos: `tests/vision.service.test.js` (cliente HTTP, 6 casos) y
  `tests/observaciones.service.test.js` (integración a nivel de service,
  3 casos: éxito, visión caída, especie desconocida).

### Notas de diseño

- La inferencia corre **fuera** de la transacción de creación. Mantener un
  `fetch` de hasta 30 s dentro de una transacción retendría una conexión del
  pool de Supabase y bloquearía escrituras concurrentes.
- `version_modelo` se auto-crea con `activo = false` cuando el modelo reporta
  una versión que aún no está sembrada; un admin decide después si pasa a
  vigente.
- `prediccion` sigue siendo inmutable: solo se hace `INSERT`.
