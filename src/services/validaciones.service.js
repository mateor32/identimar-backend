const { withTransaction } = require('../config/database');
const {
  ValidacionError,
  NoEncontradoError,
  ConflictoError,
} = require('../utils/errors');
const { ESTADOS_PENDIENTES } = require('./observaciones.service');

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

  return withTransaction(async (client) => {
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

    return {
      id: validacion.id,
      decision,
      estado: regla.nuevoEstado,
      especie_aceptada: especieFinal,
      creado_en: validacion.creado_en,
    };
  });
}

module.exports = {
  registrarValidacion,
  REGLAS_DECISION,
};
