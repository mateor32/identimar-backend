const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'observaciones';

// El cliente se crea perezosamente para que en tests (donde no hay credenciales)
// no explote el require().
let _client = null;
function cliente() {
  if (_client) return _client;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son obligatorios');
  }
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
}

/**
 * Sube un buffer al bucket privado y devuelve el path (clave dentro del bucket),
 * no una URL. Las URLs se firman bajo demanda con getSignedUrl().
 *
 * @param {{ path: string, buffer: Buffer, contentType: string }} args
 * @returns {Promise<string>} el path dentro del bucket
 */
async function uploadImage({ path, buffer, contentType }) {
  const { error } = await cliente()
    .storage.from(SUPABASE_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });
  if (error) {
    const err = new Error(`No se pudo subir la imagen: ${error.message}`);
    err.cause = error;
    throw err;
  }
  return path;
}

/**
 * Borra un archivo del bucket. Se usa para compensar cuando la transacción
 * en BD falla DESPUÉS de que el upload tuvo éxito.
 */
async function deleteImage(path) {
  const { error } = await cliente().storage.from(SUPABASE_BUCKET).remove([path]);
  if (error) {
    // best-effort: no re-lanzamos para no enmascarar el error original.
    console.warn(`[supabase] no se pudo borrar ${path}: ${error.message}`);
  }
}

/**
 * Genera una URL firmada temporal para que el cliente pueda ver la imagen.
 * @param {string} path
 * @param {number} segundos TTL (default 1h)
 */
async function getSignedUrl(path, segundos = 3600) {
  const { data, error } = await cliente()
    .storage.from(SUPABASE_BUCKET)
    .createSignedUrl(path, segundos);
  if (error) {
    throw new Error(`No se pudo firmar la URL: ${error.message}`);
  }
  return data.signedUrl;
}

module.exports = { uploadImage, deleteImage, getSignedUrl, SUPABASE_BUCKET };
