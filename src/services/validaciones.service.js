const { withTransaction } = require('../config/database');
const {
  ValidacionError,
  NoEncontradoError,
  ConflictoError,
} = require('../utils/errors');
const { ESTADOS_PENDIENTES } = require('./observaciones.service');
const { enviarFeedbackAlModelo } = require('./vision.service');

// Decisiones que generan dataset de reentrenamiento. 'rechazada' queda fuera:
// no hay especie confirmada que enviar.
const DECISIONES_CON_FEEDBACK = new Set(['confirmada', 'corregida']);

/**
 * Mapa decisión → { nuevoEstado, usaEspecie }.
 *   confirmada → observación queda VALIDADA, no se toca especie_aceptada.
 *   corregida  → observación queda CORREGIDA, especie_aceptada = la que proponga el experto.
 *   rechazada  → observación queda CORREGIDA, especie_aceptada = NULL.
 */
const REGLAS_DECISION = {
  confirmada: { nuevoEstado: 'validado', requiereEspecie: false, especieAceptada: 'confirmar' },
  corregida: { nuevoEstado: 'corregido', requiereEspecie: true, especieAceptada: 'nueva' },
  rechazada: { nuevoEstado: 'corregido', requiereEspecie: false, especieAceptada: 'anular' },
};

async function obtenerIdEstado(client, codigo) {
  const { rows } = await client.query(
    `SELECT id FROM estado_observacion WHERE codigo = $1 LIMIT 1`,
    [codigo],
  );
  if (!rows[0]) {
    throw new NoEncontradoError(`Estado "${codigo}" no está sembrado en la BD`);
  }
  return rows[0].id;
}

async function obtenerDecisionId(client, codigo) {
  // El seed debe tener `codigo` ('confirmada'|'corregida'|'rechazada') en decision_validacion.
  const { rows } = await client.query(
    `SELECT id FROM decision_validacion WHERE codigo = $1 LIMIT 1`,
    [codigo],
  );
  if (!rows[0]) {
    throw new NoEncontradoError(`Decisión "${codigo}" no está sembrada en la BD`);
  }
  return rows[0].id;
}

async function obtenerEspeciePorCodigo(client, codigo) {
  const { rows } = await client.query(
    `SELECT id, nombre_cientifico, nombre_comun
     FROM especie
     WHERE codigo = $1
     LIMIT 1`,
    [codigo],
  );
  if (!rows[0]) {
    throw new ValidacionError(`La especie "${codigo}" no existe`, [
      { campo: 'especie_final_codigo', mensaje: 'Código no reconocido' },
    ]);
  }
  return rows[0];
}

/**
 * Registra la validación experta de forma atómica.
 *
 * @param {object} args
 * @param {string} args.observacionId
 * @param {{ id: string }} args.experto
 * @param {'confirmada'|'corregida'|'rechazada'} args.decision
 * @param {string|undefined} args.especieFinalCodigo
 * @param {string|undefined} args.comentario
 * @returns {Promise<object>} resumen de la validación aplicada
 */
async function registrarValidacion({
  observacionId,
  experto,
  decision,
  especieFinalCodigo,
  comentario,
}) {
  const regla = REGLAS_DECISION[decision];
  if (!regla) {
    // Zod ya debió filtrar esto; es defensa en profundidad.
    throw new ValidacionError(`Decisión no reconocida: ${decision}`);
  }
  if (regla.requiereEspecie && !especieFinalCodigo) {
    throw new ValidacionError(
      'especie_final_codigo es obligatorio cuando decision = "corregida"',
      [{ campo: 'especie_final_codigo', mensaje: 'Obligatorio para esta decisión' }],
    );
  }

  const resultado = await withTransaction(async (client) => {
    // 1. Bloquear la observación y leer su estado actual.
    const { rows: obsRows } = await client.query(
      `SELECT o.id, o.estado_id, e.codigo AS estado_codigo
       FROM observacion o
       JOIN estado_observacion e ON e.id = o.estado_id
       WHERE o.id = $1
       FOR UPDATE OF o`,
      [observacionId],
    );
    const obs = obsRows[0];
    if (!obs) {
      throw new NoEncontradoError('Observación no encontrada');
    }

    // 2. El estado actual debe permitir validación.
    if (!ESTADOS_PENDIENTES.includes(obs.estado_codigo)) {
      throw new ConflictoError(
        `La observación está en estado "${obs.estado_codigo}" y no admite validación experta`,
      );
    }

    // 3. Resolver FKs del catálogo.
    const decisionId = await obtenerDecisionId(client, decision);
    const nuevoEstadoId = await obtenerIdEstado(client, regla.nuevoEstado);

    // 4. Resolver especie final (si aplica).
    let especieFinal = null;
    if (regla.especieAceptada === 'nueva') {
      especieFinal = await obtenerEspeciePorCodigo(client, especieFinalCodigo);
    }

    // 5. INSERT validacion_experta. NUNCA tocamos la tabla prediccion.
    const { rows: valRows } = await client.query(
      `INSERT INTO validacion_experta (
          observacion_id, experto_id, decision_id, especie_final_id, comentario
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, creado_en`,
      [
        observacionId,
        experto.id,
        decisionId,
        especieFinal ? especieFinal.id : null,
        comentario || null,
      ],
    );
    const validacion = valRows[0];

    // 6. UPDATE observación: nuevo estado + especie_aceptada_id según regla.
    //    - 'confirmar' deja el valor existente (no lo tocamos).
    //    - 'nueva'     lo pone a la especie resuelta.
    //    - 'anular'    lo pone a NULL.
    if (regla.especieAceptada === 'confirmar') {
      await client.query(
        `UPDATE observacion SET estado_id = $1 WHERE id = $2`,
        [nuevoEstadoId, observacionId],
      );
    } else {
      const nuevaEspecieId = especieFinal ? especieFinal.id : null;
      await client.query(
        `UPDATE observacion SET estado_id = $1, especie_aceptada_id = $2 WHERE id = $3`,
        [nuevoEstadoId, nuevaEspecieId, observacionId],
      );
    }

    // 7. Historial: estado_anterior → estado_nuevo.
    await client.query(
      `INSERT INTO historial_estado (
          observacion_id, estado_anterior_id, estado_nuevo_id, actor_usuario_id, motivo
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        observacionId,
        obs.estado_id,
        nuevoEstadoId,
        experto.id,
        `Validación experta: ${decision}`,
      ],
    );

    // 8. Contexto para feedback al modelo (fuera de la TX).
    //    Lo juntamos aquí, con la conexión abierta: trae la especie confirmada
    //    (ya actualizada en el paso 6), el path de la imagen y la identidad
    //    del experto. Si falta algo (p. ej. observación sin imagen), queda
    //    null y el fire-and-forget simplemente no se dispara.
    const { rows: ctxRows } = await client.query(
      `SELECT i.url_storage AS imagen_path,
              u.nombre_completo,
              u.correo,
              esp.codigo AS especie_codigo
       FROM observacion o
       JOIN usuario u ON u.id = $2
       LEFT JOIN imagen i ON i.observacion_id = o.id
       LEFT JOIN especie esp ON esp.id = o.especie_aceptada_id
       WHERE o.id = $1
       ORDER BY i.orden ASC NULLS LAST
       LIMIT 1`,
      [observacionId, experto.id],
    );
    const feedbackCtx = ctxRows[0] || null;

    return {
      resumen: {
        id: validacion.id,
        decision,
        estado: regla.nuevoEstado,
        especie_aceptada: especieFinal,
        creado_en: validacion.creado_en,
      },
      feedbackCtx,
    };
  });

  // Fire-and-forget: feedback al modelo del Equipo 2 para dataset de
  // reentrenamiento. Solo aplica en 'confirmada' / 'corregida' (en
  // 'rechazada' no hay especie confirmada que mandar). NUNCA bloqueamos la
  // respuesta al cliente y el error se come en el .catch; vision.service
  // ya devuelve null en vez de lanzar en los fallos esperados, pero el
  // .catch cubre fallos sincrónicos / de red inesperados.
  if (DECISIONES_CON_FEEDBACK.has(decision) && resultado.feedbackCtx) {
    const ctx = resultado.feedbackCtx;
    if (ctx.especie_codigo && ctx.imagen_path) {
      const validadoPor = ctx.nombre_completo
        ? `${ctx.nombre_completo} <${ctx.correo}>`
        : ctx.correo || '';
      enviarFeedbackAlModelo({
        observacionId,
        especieCodigo: ctx.especie_codigo,
        imagenPath: ctx.imagen_path,
        validadoPor,
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[Feedback] catch:', err.message);
      });
    }
  }

  return resultado.resumen;
}

module.exports = {
  registrarValidacion,
  REGLAS_DECISION,
};
