// Tests a nivel de service: ejercen la integración real con visión mockeando
// (a) el pool de Postgres (query + withTransaction), (b) Supabase Storage,
// (c) el service de visión. Así validamos que crearObservacion:
//   - inserte prediccion cuando la IA responde OK
//   - transicione a 'no_concluyente' cuando el servicio de visión está caído

process.env.DATABASE_URL = 'postgres://no-usado-en-tests';
process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'anon';
process.env.SUPABASE_BUCKET = 'observaciones';
process.env.VISION_API_URL = 'https://vision.test/predict';
process.env.VISION_API_KEY = 'test-key';

// ---- Mock de la BD ---------------------------------------------------------
// `withTransaction(fn)` llama a `fn(client)` y nos devuelve lo que retorne.
// Cada test provee un `client` nuevo con un dispatcher por fragmento de SQL.
// Guardamos el cliente en un holder; el nombre `mockClientHolder` empieza por
// `mock` para pasar el guard de hoisting de jest.
const mockClientHolder = { current: null };
jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(async (fn) => fn(mockClientHolder.current)),
}));

// ---- Mock de Supabase Storage ---------------------------------------------
const mockUpload = jest.fn(async () => undefined);
const mockDelete = jest.fn(async () => undefined);
const mockSigned = jest.fn(async () => 'https://signed/url');
jest.mock('../src/config/supabase', () => ({
  uploadImage: (...a) => mockUpload(...a),
  deleteImage: (...a) => mockDelete(...a),
  getSignedUrl: (...a) => mockSigned(...a),
}));

// ---- Mock del service de visión -------------------------------------------
const mockSolicitarInferencia = jest.fn();
jest.mock('../src/services/vision.service', () => ({
  solicitarInferencia: (...a) => mockSolicitarInferencia(...a),
}));

const observacionesService = require('../src/services/observaciones.service');

// ---- Helpers ---------------------------------------------------------------

const IDS = {
  tipoAmbiente: 'ta-manglar',
  condicion: 'co-viva',
  estRecibido: 'est-recibido',
  estIdentificado: 'est-identificado',
  estPendiente: 'est-pendiente',
  estNoConcluyente: 'est-no-concluyente',
  especieHypanus: 'esp-hypanus',
  versionModelo: 'vm-1',
  obs: 'obs-nueva',
  img: 'img-nueva',
};

/**
 * Devuelve un cliente de pg mockeado cuya `.query()` responde en función del
 * SQL (comparado por fragmentos). Mantener este switch cerca del service real.
 */
function clienteFalso() {
  return {
    query: jest.fn(async (sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (/FROM tipo_ambiente WHERE codigo/i.test(s)) {
        return { rows: [{ id: IDS.tipoAmbiente }] };
      }
      if (/FROM condicion_organismo WHERE codigo/i.test(s)) {
        return { rows: [{ id: IDS.condicion }] };
      }
      if (/FROM estado_observacion WHERE codigo/i.test(s)) {
        const map = {
          recibido: IDS.estRecibido,
          identificado: IDS.estIdentificado,
          pendiente_experto: IDS.estPendiente,
          no_concluyente: IDS.estNoConcluyente,
        };
        return { rows: [{ id: map[params[0]] }] };
      }
      if (/INSERT INTO observacion /i.test(s)) {
        return { rows: [{ id: IDS.obs, creado_en: '2026-10-26T12:00:00.000Z' }] };
      }
      if (/INSERT INTO imagen /i.test(s)) {
        return { rows: [{ id: IDS.img }] };
      }
      if (/INSERT INTO historial_estado/i.test(s)) {
        return { rows: [] };
      }
      if (/SELECT estado_id FROM observacion WHERE id/i.test(s)) {
        return { rows: [{ estado_id: IDS.estRecibido }] };
      }
      if (/FROM especie WHERE codigo/i.test(s)) {
        return params[0] === 'Hypanus_guttatus'
          ? { rows: [{ id: IDS.especieHypanus }] }
          : { rows: [] };
      }
      if (/FROM version_modelo WHERE version/i.test(s)) {
        return { rows: [{ id: IDS.versionModelo }] };
      }
      if (/INSERT INTO prediccion/i.test(s)) {
        return { rows: [] };
      }
      if (/UPDATE observacion SET/i.test(s)) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`SQL no esperado en test: ${s.slice(0, 160)}`);
    }),
  };
}

function argsBase() {
  return {
    usuario: { id: 'u-1' },
    datos: {
      latitud: 8.75,
      longitud: -76.65,
      fecha_hora_evento: '2026-10-26T12:00:00Z',
      tipo_ambiente_codigo: 'manglar',
      condicion_organismo_codigo: 'viva',
    },
    imagen: {
      buffer: Buffer.from([0, 1, 2]),
      mimetype: 'image/jpeg',
      size: 3,
      width: 10,
      height: 10,
      checksum: 'a'.repeat(64),
    },
  };
}

beforeEach(() => {
  mockUpload.mockClear();
  mockDelete.mockClear();
  mockSigned.mockClear();
  mockSolicitarInferencia.mockReset();
  mockClientHolder.current = clienteFalso();
});

// ---------------------------------------------------------------------------

describe('crearObservacion con integración de visión', () => {
  test('éxito: inserta prediccion y la observación queda en "identificado"', async () => {
    mockSolicitarInferencia.mockResolvedValueOnce({
      especie_codigo: 'Hypanus_guttatus',
      confianza: 0.87,
      version_modelo: 'yolov8n-identimar-1.0.0',
      estado_vision: 'identificado',
      umbral_minimo: 0.7,
      tiempo_inferencia_ms: 450,
      respuesta_cruda: { estado: 'identificado', confianza: 0.87 },
    });

    const resultado = await observacionesService.crearObservacion(argsBase());

    expect(resultado).toEqual({
      id: IDS.obs,
      estado: 'identificado',
      creado_en: '2026-10-26T12:00:00.000Z',
    });

    // El service llamó a visión con el id y el path reales.
    expect(mockSolicitarInferencia).toHaveBeenCalledWith(
      IDS.obs,
      `observaciones/${IDS.obs}.jpeg`,
    );

    // Se insertó exactamente una prediccion con los FKs correctos.
    const prediccion = mockClientHolder.current.query.mock.calls.find(([sql]) =>
      /INSERT INTO prediccion/i.test(sql),
    );
    expect(prediccion).toBeDefined();
    const [, params] = prediccion;
    expect(params[0]).toBe(IDS.obs);              // observacion_id
    expect(params[1]).toBe(IDS.img);              // imagen_id
    expect(params[2]).toBe(IDS.especieHypanus);   // especie_propuesta_id
    expect(params[3]).toBe(IDS.versionModelo);    // version_modelo_id
    expect(params[4]).toBe(0.87);                 // confianza
    expect(JSON.parse(params[5])).toMatchObject({ estado: 'identificado' });

    // Dos filas de historial: creación + transición post-inferencia.
    const historial = mockClientHolder.current.query.mock.calls.filter(([sql]) =>
      /INSERT INTO historial_estado/i.test(sql),
    );
    expect(historial).toHaveLength(2);
    expect(historial[1][1][4]).toMatch(/confianza/i);
  });

  test('visión caída: observación queda en "no_concluyente" sin propagar error', async () => {
    mockSolicitarInferencia.mockRejectedValueOnce(new Error('SERVICIO_VISION_NO_DISPONIBLE'));

    const resultado = await observacionesService.crearObservacion(argsBase());

    expect(resultado).toEqual({
      id: IDS.obs,
      estado: 'no_concluyente',
      creado_en: '2026-10-26T12:00:00.000Z',
    });

    // No se insertó predicción.
    const prediccion = mockClientHolder.current.query.mock.calls.find(([sql]) =>
      /INSERT INTO prediccion/i.test(sql),
    );
    expect(prediccion).toBeUndefined();

    // Historial: creación + transición a no_concluyente con el motivo esperado.
    const historial = mockClientHolder.current.query.mock.calls.filter(([sql]) =>
      /INSERT INTO historial_estado/i.test(sql),
    );
    expect(historial).toHaveLength(2);
    expect(historial[1][1][4]).toBe('Servicio de visión no disponible');
  });

  test('modelo "identificado" pero especie no sembrada: cae en "pendiente_experto"', async () => {
    mockSolicitarInferencia.mockResolvedValueOnce({
      especie_codigo: 'Especie_desconocida',
      confianza: 0.91,
      version_modelo: 'yolov8n-identimar-1.0.0',
      estado_vision: 'identificado',
      umbral_minimo: 0.7,
      tiempo_inferencia_ms: 400,
      respuesta_cruda: { estado: 'identificado' },
    });

    const resultado = await observacionesService.crearObservacion(argsBase());

    expect(resultado.estado).toBe('pendiente_experto');

    // Predicción se inserta con especie_propuesta_id = NULL.
    const prediccion = mockClientHolder.current.query.mock.calls.find(([sql]) =>
      /INSERT INTO prediccion/i.test(sql),
    );
    expect(prediccion[1][2]).toBeNull();
  });
});
