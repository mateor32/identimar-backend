# Changelog

## 2026-10-26 — Feedback al modelo del Equipo 2 tras validación experta

Cuando un experto registra una validación con decisión `confirmada` o
`corregida`, el backend hace **fire-and-forget** a `VISION_FEEDBACK_URL` con la
especie confirmada para alimentar el dataset de reentrenamiento del Equipo 2.
`rechazada` no envía nada (no hay especie confirmada).

### Reglas

- Es best-effort: cualquier fallo del endpoint queda en `console.warn` y la
  validación responde 201 como si nada.
- URL de la imagen firmada a 600 s. Header `x-api-key`. Timeout 10 s.
- El payload es `{ id_observacion, especie_confirmada, validado_por, url_imagen }`.
- `validado_por` se arma como `"<nombre_completo> <<correo>>"` leído de la BD
  dentro de la misma transacción de la validación (no hay round-trip extra
  tras el commit).

### Cambios

- `src/services/vision.service.js` — nueva función `enviarFeedbackAlModelo`.
- `src/services/validaciones.service.js` — recolecta `imagen.url_storage`,
  `especie.codigo` (post-UPDATE) y datos del experto dentro de la TX, y
  dispara el feedback fuera del commit (`.catch` para que una rechazo del
  promise no se escape como "unhandled rejection").
- `.env.example` — nueva `VISION_FEEDBACK_URL`.
- Tests nuevos: 5 casos en `tests/vision.service.test.js` (éxito 201, fallo
  500, sin especie, sin URL, error de red) y `tests/validaciones.service.test.js`
  completo (5 casos: confirmada, corregida, rechazada, feedback que lanza,
  observación sin especie confirmada).

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
