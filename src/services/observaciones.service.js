const { query, withTransaction } = require('../config/database');
const supabase = require('../config/supabase');
const { ValidacionError, NoEncontradoError } = require('../utils/errors');
const { extensionDeMime } = require('../middlewares/upload.middleware');

/**
 * Resuelve el id de una fila de catálogo a partir de una columna "código".
 * Si no existe, lanza ValidacionError con un mensaje útil para el formulario.
 *
 * Nota: si en el schema real la columna identificadora se llama distinto
 * (p. ej. `nombre` en vez de `codigo`), cámbialo aquí.
 */
async function resolverIdPorCodigo(client, tabla, codigo, etiquetaCampo) {
  const { rows } = await client.query(
    `SELECT id FROM ${tabla} WHERE codigo = $1 LIMIT 1`,
    [codigo],
  );
  if (rows[0]) return rows[0].id;
  throw new ValidacionError(`El ${etiquetaCampo} "${codigo}" no existe`, [
    { campo: etiquetaCampo, mensaje: 'Código no reconocido' },
  ]);
}

async function obtenerEstadoIdPorCodigo(client, codigo) {
  const { rows } = await client.query(
    `SELECT id FROM estado_observacion WHERE codigo = $1 LIMIT 1`,
    [codigo],
  );
  if (!rows[0]) {
    // Esto sería un bug de datos (seeds faltantes), no un input inválido.
    throw new NoEncontradoError(`Estado "${codigo}" no está sembrado en la BD`);
  }
  return rows[0].id;
}

/**
 * Crea una observación completa de forma atómica.
 *
 * @param {object} args
 * @param {{ id: string }} args.usuario   - autor (viene del JWT)
 * @param {object} args.datos             - ya validados por Zod
 * @param {{ buffer: Buffer, mimetype: string, size: number, width: number, height: number, checksum: string }} args.imagen
 * @returns {Promise<{ id: string, estado: string, creado_en: string }>}
 */
async function crearObservacion({ usuario, datos, imagen }) {
  // Trackeamos el path subido a Storage FUERA de la transacción para poder
  // compensar si la BD falla después del upload (orphan file prevention).
  let pathSubido = null;

  try {
    return await withTransaction(async (client) => {
      // 1. Resolver FKs desde códigos legibles.
      const tipoAmbienteId = await resolverIdPorCodigo(
        client,
        'tipo_ambiente',
        datos.tipo_ambiente_codigo,
        'tipo_ambiente_codigo',
      );
      const condicionId = await resolverIdPorCodigo(
        client,
        'condicion_organismo',
        datos.condicion_organismo_codigo,
        'condicion_organismo_codigo',
      );

      // 2. Validar especie_aceptada_id si el usuario la sugirió.
      if (datos.especie_aceptada_id) {
        const { rowCount } = await client.query(
          `SELECT 1 FROM especie WHERE id = $1`,
          [datos.especie_aceptada_id],
        );
        if (rowCount === 0) {
          throw new ValidacionError(`La especie sugerida no existe`, [
            { campo: 'especie_aceptada_id', mensaje: 'Id no reconocido' },
          ]);
        }
      }

      // 3. Estado inicial.
      const estadoId = await obtenerEstadoIdPorCodigo(client, 'recibido');

      // 4. INSERT observacion.
      const { rows: obsRows } = await client.query(
        `INSERT INTO observacion (
            usuario_id, especie_aceptada_id, tipo_ambiente_id, condicion_organismo_id,
            estado_id, latitud, longitud, precision_gps_metros,
            fecha_hora_evento, observaciones_usuario
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, creado_en`,
        [
          usuario.id,
          datos.especie_aceptada_id || null,
          tipoAmbienteId,
          condicionId,
          estadoId,
          datos.latitud,
          datos.longitud,
          datos.precision_gps_metros ?? null,
          datos.fecha_hora_evento,
          datos.observaciones_usuario || null,
        ],
      );
      const observacion = obsRows[0];

      // 5. Subir imagen a Storage. Si esto lanza, withTransaction rollbackea
      //    la observación y el catch externo no borra nada (no hay path).
      const ext = extensionDeMime(imagen.mimetype);
      const path = `observaciones/${observacion.id}.${ext}`;
      await supabase.uploadImage({ path, buffer: imagen.buffer, contentType: imagen.mimetype });
      pathSubido = path;

      // 6. INSERT imagen. Si falla, el catch externo borra el archivo.
      await client.query(
        `INSERT INTO imagen (
            observacion_id, url_storage, formato, tamano_bytes,
            ancho_px, alto_px, checksum, orden
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
        [
          observacion.id,
          path,
          ext,
          imagen.size,
          imagen.width,
          imagen.height,
          imagen.checksum,
        ],
      );

      // 7. Historial: null → recibido.
      await client.query(
        `INSERT INTO historial_estado (
            observacion_id, estado_anterior_id, estado_nuevo_id, actor_usuario_id, motivo
         )
         VALUES ($1, NULL, $2, $3, $4)`,
        [observacion.id, estadoId, usuario.id, 'Observación creada'],
      );

      return {
        id: observacion.id,
        estado: 'recibido',
        creado_en: observacion.creado_en,
      };
    });
  } catch (err) {
    // Compensación: si subimos a Storage pero la transacción falló después,
    // borramos el archivo huérfano. Best-effort, no re-lanzamos su error.
    if (pathSubido) {
      await supabase.deleteImage(pathSubido);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Lectura: listado paginado
// ---------------------------------------------------------------------------

/**
 * Lista observaciones con filtros opcionales y paginación.
 *
 * @param {object} opts
 * @param {string|null} opts.filtroUsuarioId  si viene, solo trae del usuario (visión personal);
 *                                            si es null, trae todas (visión admin).
 * @param {string|null} opts.estadoNombre     filtro por nombre de estado (p. ej. 'recibido').
 * @param {number} opts.pagina                1-indexed
 * @param {number} opts.tamano
 * @returns {Promise<{ items: object[], pagina: number, tamano: number, total: number }>}
 */
async function listarObservaciones({ filtroUsuarioId, estadoNombre, pagina, tamano }) {
  const offset = (pagina - 1) * tamano;

  // Dos queries: una para total, otra para la página. Comparten los mismos
  // filtros con `$1 IS NULL OR …` para no armar SQL a mano.
  const whereParams = [filtroUsuarioId || null, estadoNombre || null];
  const whereClause = `
    WHERE ($1::uuid IS NULL OR o.usuario_id = $1)
      AND ($2::text IS NULL OR e.codigo = $2)
  `;

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total
     FROM observacion o
     JOIN estado_observacion e ON e.id = o.estado_id
     ${whereClause}`,
    whereParams,
  );
  const total = countRows[0].total;

  const { rows: items } = await query(
    `SELECT
        o.id,
        o.latitud,
        o.longitud,
        o.fecha_hora_evento,
        o.creado_en,
        json_build_object('id', e.id, 'codigo', e.codigo, 'nombre_visible', e.nombre_visible, 'orden', e.orden, 'es_terminal', e.es_terminal) AS estado,
        CASE WHEN sp.id IS NOT NULL
             THEN json_build_object('id', sp.id, 'codigo', sp.codigo, 'nombre_cientifico', sp.nombre_cientifico, 'nombre_comun', sp.nombre_comun)
        END AS especie_aceptada
     FROM observacion o
     JOIN estado_observacion e ON e.id = o.estado_id
     LEFT JOIN especie sp ON sp.id = o.especie_aceptada_id
     ${whereClause}
     ORDER BY o.creado_en DESC
     LIMIT $3 OFFSET $4`,
    [...whereParams, tamano, offset],
  );

  return { items, pagina, tamano, total };
}

// ---------------------------------------------------------------------------
// Cola de validación experta: observaciones en 'pendiente_experto' o 'no_concluyente'
// ---------------------------------------------------------------------------

const ESTADOS_PENDIENTES = ['pendiente_experto', 'no_concluyente'];

async function listarPendientes({ pagina, tamano }) {
  const offset = (pagina - 1) * tamano;

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total
     FROM observacion o
     JOIN estado_observacion e ON e.id = o.estado_id
     WHERE e.codigo = ANY($1::text[])`,
    [ESTADOS_PENDIENTES],
  );
  const total = countRows[0].total;

  const { rows: items } = await query(
    `SELECT
        o.id,
        o.latitud,
        o.longitud,
        o.fecha_hora_evento,
        o.creado_en,
        json_build_object('id', e.id, 'codigo', e.codigo, 'nombre_visible', e.nombre_visible, 'orden', e.orden, 'es_terminal', e.es_terminal) AS estado,
        CASE WHEN sp.id IS NOT NULL
             THEN json_build_object('id', sp.id, 'codigo', sp.codigo, 'nombre_cientifico', sp.nombre_cientifico, 'nombre_comun', sp.nombre_comun)
        END AS especie_aceptada,
        json_build_object('id', u.id, 'nombre_completo', u.nombre_completo, 'rol', ur.codigo) AS usuario,
        (SELECT json_build_object('id', p.id, 'confianza', p.confianza,
                 'especie', CASE WHEN psp.id IS NOT NULL
                   THEN json_build_object('id', psp.id, 'codigo', psp.codigo, 'nombre_cientifico', psp.nombre_cientifico, 'nombre_comun', psp.nombre_comun)
                 END)
         FROM prediccion p
         LEFT JOIN especie psp ON psp.id = p.especie_propuesta_id
         WHERE p.observacion_id = o.id
         ORDER BY p.creado_en DESC
         LIMIT 1) AS prediccion
     FROM observacion o
     JOIN estado_observacion e ON e.id = o.estado_id
     JOIN usuario u ON u.id = o.usuario_id
     JOIN rol ur ON ur.id = u.rol_id
     LEFT JOIN especie sp ON sp.id = o.especie_aceptada_id
     WHERE e.codigo = ANY($1::text[])
     ORDER BY o.creado_en ASC
     LIMIT $2 OFFSET $3`,
    [ESTADOS_PENDIENTES, tamano, offset],
  );

  return { items, pagina, tamano, total };
}

// ---------------------------------------------------------------------------
// Lectura: detalle completo con imagen, predicción, validación e historial
// ---------------------------------------------------------------------------

/**
 * Devuelve una observación con todos sus relacionados o null si no existe.
 * No verifica permisos: el controller decide si el usuario puede verla.
 */
async function obtenerObservacionCompleta(id) {
  // 1. Observación principal con joins a catálogos y usuario autor.
  const { rows: obsRows } = await query(
    `SELECT
        o.id,
        o.latitud,
        o.longitud,
        o.fecha_hora_evento,
        o.precision_gps_metros,
        o.observaciones_usuario,
        o.creado_en,
        o.usuario_id,
        json_build_object('id', e.id, 'codigo', e.codigo, 'nombre_visible', e.nombre_visible, 'orden', e.orden, 'es_terminal', e.es_terminal) AS estado,
        json_build_object('id', ta.id, 'codigo', ta.codigo, 'nombre_visible', ta.nombre_visible) AS tipo_ambiente,
        json_build_object('id', co.id, 'codigo', co.codigo, 'nombre_visible', co.nombre_visible) AS condicion_organismo,
        CASE WHEN sp.id IS NOT NULL
             THEN json_build_object('id', sp.id, 'codigo', sp.codigo, 'nombre_cientifico', sp.nombre_cientifico, 'nombre_comun', sp.nombre_comun)
        END AS especie_aceptada,
        json_build_object('id', u.id, 'nombre_completo', u.nombre_completo, 'correo', u.correo, 'rol', ur.codigo) AS usuario
     FROM observacion o
     JOIN estado_observacion e ON e.id = o.estado_id
     JOIN tipo_ambiente ta ON ta.id = o.tipo_ambiente_id
     JOIN condicion_organismo co ON co.id = o.condicion_organismo_id
     JOIN usuario u ON u.id = o.usuario_id
     JOIN rol ur ON ur.id = u.rol_id
     LEFT JOIN especie sp ON sp.id = o.especie_aceptada_id
     WHERE o.id = $1`,
    [id],
  );
  const observacion = obsRows[0];
  if (!observacion) return null;

  // 2. Imagen (asumimos una por observación en la v1 del contrato).
  const { rows: imgRows } = await query(
    `SELECT id, url_storage, formato, tamano_bytes, ancho_px, alto_px, checksum, orden, subido_en
     FROM imagen
     WHERE observacion_id = $1
     ORDER BY orden ASC, subido_en ASC
     LIMIT 1`,
    [id],
  );
  const imagen = imgRows[0] || null;

  // 3. Predicción vigente (la más reciente; prediccion es append-only).
  const { rows: predRows } = await query(
    `SELECT
        p.id,
        p.confianza,
        p.creado_en,
        CASE WHEN sp.id IS NOT NULL
             THEN json_build_object('id', sp.id, 'codigo', sp.codigo, 'nombre_cientifico', sp.nombre_cientifico, 'nombre_comun', sp.nombre_comun)
        END AS especie,
        CASE WHEN vm.id IS NOT NULL
             THEN json_build_object('id', vm.id, 'version', vm.version)
        END AS version_modelo
     FROM prediccion p
     LEFT JOIN especie sp ON sp.id = p.especie_propuesta_id
     LEFT JOIN version_modelo vm ON vm.id = p.version_modelo_id
     WHERE p.observacion_id = $1
     ORDER BY p.creado_en DESC
     LIMIT 1`,
    [id],
  );
  const prediccion = predRows[0] || null;

  // 4. Validación experta (si ya la hicieron).
  const { rows: valRows } = await query(
    `SELECT
        v.id,
        v.comentario,
        v.creado_en,
        json_build_object('id', u.id, 'nombre_completo', u.nombre_completo, 'correo', u.correo, 'rol', ur.codigo) AS experto,
        json_build_object('id', d.id, 'codigo', d.codigo, 'nombre_visible', d.nombre_visible) AS decision,
        CASE WHEN sp.id IS NOT NULL
             THEN json_build_object('id', sp.id, 'codigo', sp.codigo, 'nombre_cientifico', sp.nombre_cientifico, 'nombre_comun', sp.nombre_comun)
        END AS especie_corregida
     FROM validacion_experta v
     JOIN usuario u ON u.id = v.experto_id
     JOIN rol ur ON ur.id = u.rol_id
     JOIN decision_validacion d ON d.id = v.decision_id
     LEFT JOIN especie sp ON sp.id = v.especie_final_id
     WHERE v.observacion_id = $1
     ORDER BY v.creado_en DESC
     LIMIT 1`,
    [id],
  );
  const validacion = valRows[0] || null;

  // 5. Historial de estados ordenado cronológicamente.
  const { rows: historial } = await query(
    `SELECT
        h.id,
        h.motivo,
        h.creado_en,
        CASE WHEN ea.id IS NOT NULL
             THEN json_build_object('id', ea.id, 'codigo', ea.codigo, 'nombre_visible', ea.nombre_visible)
        END AS estado_anterior,
        json_build_object('id', en.id, 'codigo', en.codigo, 'nombre_visible', en.nombre_visible) AS estado_nuevo,
        CASE WHEN u.id IS NOT NULL
             THEN json_build_object('id', u.id, 'nombre_completo', u.nombre_completo, 'rol', ur.codigo)
        END AS actor
     FROM historial_estado h
     LEFT JOIN estado_observacion ea ON ea.id = h.estado_anterior_id
     JOIN estado_observacion en ON en.id = h.estado_nuevo_id
     LEFT JOIN usuario u ON u.id = h.actor_usuario_id
     LEFT JOIN rol ur ON ur.id = u.rol_id
     WHERE h.observacion_id = $1
     ORDER BY h.creado_en ASC, h.id ASC`,
    [id],
  );

  return { observacion, imagen, prediccion, validacion, historial };
}

module.exports = {
  crearObservacion,
  listarObservaciones,
  listarPendientes,
  obtenerObservacionCompleta,
  ESTADOS_PENDIENTES,
};
