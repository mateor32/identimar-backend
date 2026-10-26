const supabase = require('../config/supabase');

// 10 minutos: suficiente para que el modelo descargue la imagen desde Storage
// aunque haya reintentos, y lo bastante corto para que la URL no quede expuesta
// más tiempo del necesario.
const SIGNED_URL_SEGUNDOS = 600;

// El servicio del Equipo 2 debería responder en < 1s; damos 30s para cubrir
// cold-starts del contenedor y descargas lentas de la imagen.
const TIMEOUT_MS = 30_000;

/**
 * Llama al servicio de visión del Equipo 2 y devuelve la predicción
 * normalizada al contrato interno del backend.
 *
 * El servicio recibe:
 *   { id_observacion, url_imagen }           (JSON)
 *   header x-api-key                          (en minúsculas)
 *
 * Y responde:
 *   { id_observacion, especie_propuesta, confianza, umbral_minimo,
 *     estado: 'identificado'|'no_concluyente',
 *     version_modelo, tiempo_inferencia_ms }
 *
 * Errores:
 *   - 401                         → 'VISION_API_KEY inválida'
 *   - cualquier otro status >=400 → 'Vision API error: {status}'
 *   - timeout / error de red      → 'SERVICIO_VISION_NO_DISPONIBLE'
 *
 * El llamador atrapa SERVICIO_VISION_NO_DISPONIBLE y transiciona la
 * observación a 'no_concluyente'.
 *
 * @param {string} observacionId  UUID de la observación recién creada
 * @param {string} imagenPath     path del archivo dentro del bucket de Supabase
 */
async function solicitarInferencia(observacionId, imagenPath) {
  const endpoint = process.env.VISION_API_URL;
  const apiKey = process.env.VISION_API_KEY;

  if (!endpoint || !apiKey) {
    // Config faltante: lo tratamos igual que un servicio caído para que la
    // observación pueda seguir y quedar en no_concluyente.
    const err = new Error('SERVICIO_VISION_NO_DISPONIBLE');
    err.causa = 'VISION_API_URL o VISION_API_KEY no definidos';
    throw err;
  }

  const urlImagen = await supabase.getSignedUrl(imagenPath, SIGNED_URL_SEGUNDOS);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        id_observacion: observacionId,
        url_imagen: urlImagen,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // AbortError (timeout), ECONNREFUSED, DNS, TLS, etc.
    const e = new Error('SERVICIO_VISION_NO_DISPONIBLE');
    e.cause = err;
    throw e;
  }

  if (response.status === 401) {
    throw new Error('VISION_API_KEY inválida');
  }
  if (!response.ok) {
    throw new Error(`Vision API error: ${response.status}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    // Respuesta 2xx pero body no-JSON: lo tratamos como servicio inestable.
    const e = new Error('SERVICIO_VISION_NO_DISPONIBLE');
    e.cause = err;
    throw e;
  }

  return {
    especie_codigo: data.especie_propuesta ?? null,
    confianza: Number(data.confianza),
    version_modelo: data.version_modelo,
    estado_vision: data.estado,
    umbral_minimo: data.umbral_minimo,
    tiempo_inferencia_ms: data.tiempo_inferencia_ms,
    respuesta_cruda: data,
  };
}

// ---------------------------------------------------------------------------
// Feedback al modelo (dataset de reentrenamiento del Equipo 2)
// ---------------------------------------------------------------------------

// 10s: el endpoint de feedback solo recibe metadatos + URL, es más rápido que
// la inferencia.
const FEEDBACK_TIMEOUT_MS = 10_000;

/**
 * Envía la validación experta al modelo del Equipo 2 para construir dataset
 * de reentrenamiento. **Best-effort**: cualquier fallo se registra en logs
 * pero NUNCA se propaga al llamador; devuelve `null` cuando no pudo enviar.
 *
 * @param {object} args
 * @param {string} args.observacionId
 * @param {string} args.especieCodigo    código del catálogo (p. ej. 'Hypanus_guttatus')
 * @param {string} args.imagenPath       path dentro del bucket de Supabase
 * @param {string} args.validadoPor      texto descriptivo del experto ("Nombre <correo>")
 */
async function enviarFeedbackAlModelo({ observacionId, especieCodigo, imagenPath, validadoPor }) {
  const feedbackUrl = process.env.VISION_FEEDBACK_URL;
  const apiKey = process.env.VISION_API_KEY;

  if (!feedbackUrl) {
    // eslint-disable-next-line no-console
    console.warn('[Feedback] VISION_FEEDBACK_URL no configurada, saltando');
    return null;
  }
  if (!especieCodigo) {
    // eslint-disable-next-line no-console
    console.warn('[Feedback] No se envía porque no hay especie confirmada');
    return null;
  }

  try {
    const imagenUrl = await supabase.getSignedUrl(imagenPath, SIGNED_URL_SEGUNDOS);

    const response = await fetch(feedbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '',
      },
      body: JSON.stringify({
        id_observacion: observacionId,
        especie_confirmada: especieCodigo,
        validado_por: validadoPor || '',
        url_imagen: imagenUrl,
      }),
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // eslint-disable-next-line no-console
      console.warn(`[Feedback] Fallo ${response.status}: ${body}`);
      return null;
    }

    const data = await response.json();
    // eslint-disable-next-line no-console
    console.log(`[Feedback] OK — ${data.estado} para observación ${observacionId}`);
    return data;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[Feedback] Error:', error.message);
    return null;
  }
}

module.exports = {
  solicitarInferencia,
  enviarFeedbackAlModelo,
  SIGNED_URL_SEGUNDOS,
  TIMEOUT_MS,
  FEEDBACK_TIMEOUT_MS,
};
