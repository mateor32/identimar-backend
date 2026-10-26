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

module.exports = {
  solicitarInferencia,
  SIGNED_URL_SEGUNDOS,
  TIMEOUT_MS,
};
