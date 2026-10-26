// Service-level tests para validaciones. Mockeamos BD + vision.service para
// verificar que:
//   - confirmada/corregida disparan feedback con los datos esperados.
//   - rechazada NO dispara feedback.
//   - un fallo del feedback no afecta la respuesta al cliente.

process.env.DATABASE_URL = 'postgres://no-usado-en-tests';
process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'anon';
process.env.SUPABASE_BUCKET = 'observaciones';
process.env.VISION_API_URL = 'https://vision.test/predict';
process.env.VISION_API_KEY = 'test-key';
process.env.VISION_FEEDBACK_URL = 'https://vision.test/feedback';

// Mock de BD: `withTransaction(fn)` ejecuta `fn(client)` con un cliente que
// enruta por SQL. El holder empieza por `mock` para pasar el hoisting de jest.
const mockClientHolder = { current: null };
jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(async (fn) => fn(mockClientHolder.current)),
}));

// Mock del service de visión — en este archivo nos interesa cómo lo llama
// validaciones.service, no la implementación real.
const mockEnviarFeedback = jest.fn(async () => ({ estado: 'almacenado' }));
const mockSolicitarInferencia = jest.fn();
jest.mock('../src/services/vision.service', () => ({
  solicitarInferencia: (...a) => mockSolicitarInferencia(...a),
  enviarFeedbackAlModelo: (...a) => mockEnviarFeedback(...a),
}));

const validacionesService = require('../src/services/validaciones.service');

// ---- Setup del cliente mock ------------------------------------------------

const IDS = {
  estPendiente: 'est-pendiente',
  estValidado: 'est-validado',
  estCorregido: 'est-corregido',
  decConfirmada: 'dec-confirmada',
  decCorregida: 'dec-corregida',
  decRechazada: 'dec-rechazada',
  especieHypanus: 'esp-hypanus',
  especieNueva: 'esp-nueva',
  validacion: 'val-1',
};

/**
 * Construye un cliente de pg mockeado. `overrides.estadoCodigo` controla el
 * estado actual de la observación (para probar el guard de conflicto).
 * `overrides.ctx` fuerza el payload del SELECT final de feedback.
 */
function clienteFalso({ estadoCodigo = 'pendiente_experto', ctx } = {}) {
  const ctxDefault = {
    imagen_path: 'observaciones/obs-1.jpeg',
    nombre_completo: 'Ana Pérez',
    correo: 'ana@uraba.co',
    especie_codigo: 'Hypanus_guttatus',
  };
  return {
    query: jest.fn(async (sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (/FROM observacion o JOIN estado_observacion/i.test(s) && /FOR UPDATE/i.test(s)) {
        return {
          rows: [{ id: 'obs-1', estado_id: IDS.estPendiente, estado_codigo: estadoCodigo }],
        };
      }
      if (/FROM decision_validacion WHERE codigo/i.test(s)) {
        const map = {
          confirmada: IDS.decConfirmada,
          corregida: IDS.decCorregida,
          rechazada: IDS.decRechazada,
        };
        return { rows: [{ id: map[params[0]] }] };
      }
      if (/FROM estado_observacion WHERE codigo/i.test(s)) {
        const map = {
          validado: IDS.estValidado,
          corregido: IDS.estCorregido,
        };
        return { rows: [{ id: map[params[0]] }] };
      }
      if (/FROM especie WHERE codigo/i.test(s)) {
        // Usado por obtenerEspeciePorCodigo en decision=corregida.
        return {
          rows: [
            {
              id: IDS.especieNueva,
              nombre_cientifico: 'Nueva especie',
              nombre_comun: 'Nueva',
            },
          ],
        };
      }
      if (/INSERT INTO validacion_experta/i.test(s)) {
        return { rows: [{ id: IDS.validacion, creado_en: '2026-10-26T15:00:00.000Z' }] };
      }
      if (/UPDATE observacion SET/i.test(s)) {
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO historial_estado/i.test(s)) {
        return { rows: [] };
      }
      // SELECT final de contexto para feedback.
      if (/FROM observacion o JOIN usuario u/i.test(s) && /LEFT JOIN imagen/i.test(s)) {
        return { rows: [ctx === null ? undefined : { ...ctxDefault, ...(ctx || {}) }].filter(Boolean) };
      }
      throw new Error(`SQL no esperado en test: ${s.slice(0, 160)}`);
    }),
  };
}

const argsBase = (overrides = {}) => ({
  observacionId: 'obs-1',
  experto: { id: 'exp-1' },
  decision: 'confirmada',
  comentario: 'OK',
  ...overrides,
});

beforeEach(() => {
  mockEnviarFeedback.mockClear();
  mockEnviarFeedback.mockResolvedValue({ estado: 'almacenado' });
  mockClientHolder.current = clienteFalso();
});

// ---------------------------------------------------------------------------

describe('registrarValidacion dispara feedback al modelo', () => {
  test('decision=confirmada: llama a enviarFeedbackAlModelo con el payload esperado', async () => {
    const resultado = await validacionesService.registrarValidacion(argsBase({ decision: 'confirmada' }));

    expect(resultado).toMatchObject({ id: IDS.validacion, decision: 'confirmada', estado: 'validado' });

    expect(mockEnviarFeedback).toHaveBeenCalledTimes(1);
    expect(mockEnviarFeedback).toHaveBeenCalledWith({
      observacionId: 'obs-1',
      especieCodigo: 'Hypanus_guttatus',
      imagenPath: 'observaciones/obs-1.jpeg',
      validadoPor: 'Ana Pérez <ana@uraba.co>',
    });
  });

  test('decision=corregida: también llama a feedback', async () => {
    await validacionesService.registrarValidacion(
      argsBase({ decision: 'corregida', especieFinalCodigo: 'OtraSpp' }),
    );

    expect(mockEnviarFeedback).toHaveBeenCalledTimes(1);
    expect(mockEnviarFeedback.mock.calls[0][0]).toMatchObject({
      observacionId: 'obs-1',
      especieCodigo: 'Hypanus_guttatus', // viene del SELECT post-UPDATE
      validadoPor: 'Ana Pérez <ana@uraba.co>',
    });
  });

  test('decision=rechazada: NO llama a feedback', async () => {
    await validacionesService.registrarValidacion(argsBase({ decision: 'rechazada' }));
    expect(mockEnviarFeedback).not.toHaveBeenCalled();
  });

  test('feedback que lanza no rompe la validación', async () => {
    mockEnviarFeedback.mockRejectedValueOnce(new Error('boom en feedback'));
    // Silenciamos el console.warn del .catch para no ensuciar el output.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const resultado = await validacionesService.registrarValidacion(argsBase({ decision: 'confirmada' }));

    expect(resultado.id).toBe(IDS.validacion);
    expect(resultado.estado).toBe('validado');

    // Dejamos tiempo a que el .catch se ejecute (el fire-and-forget es asíncrono).
    await new Promise((r) => setImmediate(r));
    expect(warnSpy).toHaveBeenCalledWith('[Feedback] catch:', 'boom en feedback');
    warnSpy.mockRestore();
  });

  test('sin especie confirmada (p. ej. observación sin especie_aceptada previa): skip', async () => {
    mockClientHolder.current = clienteFalso({ ctx: { especie_codigo: null } });

    await validacionesService.registrarValidacion(argsBase({ decision: 'confirmada' }));
    expect(mockEnviarFeedback).not.toHaveBeenCalled();
  });
});
