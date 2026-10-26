// Tests del servicio de integración con la IA del Equipo 2.
// Mockeamos `fetch` globalmente y `supabase.getSignedUrl` para no tocar la red.

process.env.VISION_API_URL = 'https://vision.test/predict';
process.env.VISION_API_KEY = 'test-key';
process.env.VISION_FEEDBACK_URL = 'https://vision.test/feedback';
process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'anon';
process.env.SUPABASE_BUCKET = 'observaciones';

const mockGetSignedUrl = jest.fn(async (path, segundos) => `https://signed/${path}?s=${segundos}`);
jest.mock('../src/config/supabase', () => ({
  getSignedUrl: (...args) => mockGetSignedUrl(...args),
}));

const visionService = require('../src/services/vision.service');

const OBS_ID = '7f3a2c4e-9b1d-4a1e-9d7e-2a71c3b4e5f6';
const IMG_PATH = 'observaciones/7f3a2c4e-9b1d-4a1e-9d7e-2a71c3b4e5f6.jpeg';

beforeEach(() => {
  mockGetSignedUrl.mockClear();
  global.fetch = jest.fn();
});

afterAll(() => {
  // No dejamos basura al runner.
  delete global.fetch;
});

describe('solicitarInferencia', () => {
  test('caso 1 — éxito con alta confianza: normaliza al contrato interno', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id_observacion: OBS_ID,
        especie_propuesta: 'Hypanus_guttatus',
        confianza: 0.87,
        umbral_minimo: 0.7,
        estado: 'identificado',
        version_modelo: 'yolov8n-identimar-1.0.0+d35ef9c33669',
        tiempo_inferencia_ms: 450,
      }),
    });

    const resultado = await visionService.solicitarInferencia(OBS_ID, IMG_PATH);

    expect(resultado).toEqual({
      especie_codigo: 'Hypanus_guttatus',
      confianza: 0.87,
      version_modelo: 'yolov8n-identimar-1.0.0+d35ef9c33669',
      estado_vision: 'identificado',
      umbral_minimo: 0.7,
      tiempo_inferencia_ms: 450,
      respuesta_cruda: expect.objectContaining({ especie_propuesta: 'Hypanus_guttatus' }),
    });

    // URL firmada por 10 min (600s).
    expect(mockGetSignedUrl).toHaveBeenCalledWith(IMG_PATH, 600);

    // Headers y body correctos.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://vision.test/predict');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-api-key': 'test-key',
    });
    expect(JSON.parse(init.body)).toEqual({
      id_observacion: OBS_ID,
      url_imagen: `https://signed/${IMG_PATH}?s=600`,
    });
    // Timeout vía AbortSignal.
    expect(init.signal).toBeDefined();
  });

  test('caso 2 — no concluyente: resuelve con estado_vision="no_concluyente", sin lanzar', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id_observacion: OBS_ID,
        especie_propuesta: null,
        confianza: 0.45,
        umbral_minimo: 0.7,
        estado: 'no_concluyente',
        version_modelo: 'yolov8n-identimar-1.0.0',
        tiempo_inferencia_ms: 320,
      }),
    });

    const resultado = await visionService.solicitarInferencia(OBS_ID, IMG_PATH);

    expect(resultado.estado_vision).toBe('no_concluyente');
    expect(resultado.especie_codigo).toBeNull();
    expect(resultado.confianza).toBe(0.45);
  });

  test('caso 3 — API key inválida (401): lanza "VISION_API_KEY inválida"', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    });

    await expect(visionService.solicitarInferencia(OBS_ID, IMG_PATH))
      .rejects.toThrow('VISION_API_KEY inválida');
  });

  test('caso 3 bis — otros 4xx/5xx: lanza "Vision API error: <status>"', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: 'service unavailable' }),
    });

    await expect(visionService.solicitarInferencia(OBS_ID, IMG_PATH))
      .rejects.toThrow('Vision API error: 503');
  });

  test('caso 4 — timeout / error de red: lanza "SERVICIO_VISION_NO_DISPONIBLE"', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    global.fetch.mockRejectedValueOnce(abortErr);

    await expect(visionService.solicitarInferencia(OBS_ID, IMG_PATH))
      .rejects.toThrow('SERVICIO_VISION_NO_DISPONIBLE');
  });

  test('caso 4 bis — error ECONNREFUSED: lanza "SERVICIO_VISION_NO_DISPONIBLE"', async () => {
    const netErr = new Error('connect ECONNREFUSED 10.0.0.1:443');
    netErr.code = 'ECONNREFUSED';
    global.fetch.mockRejectedValueOnce(netErr);

    await expect(visionService.solicitarInferencia(OBS_ID, IMG_PATH))
      .rejects.toThrow('SERVICIO_VISION_NO_DISPONIBLE');
  });
});

// ---------------------------------------------------------------------------
// Feedback al modelo (dataset de reentrenamiento)
// ---------------------------------------------------------------------------

describe('enviarFeedbackAlModelo', () => {
  const feedbackArgs = {
    observacionId: OBS_ID,
    especieCodigo: 'Hypanus_guttatus',
    imagenPath: IMG_PATH,
    validadoPor: 'Ana Pérez <ana@uraba.co>',
  };

  // Silenciamos los console.warn/log del service para no ensuciar el output.
  let warnSpy, logSpy;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('éxito 201: devuelve el body parseado y manda el payload correcto', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ estado: 'almacenado', id: 'fb-1' }),
    });

    const resultado = await visionService.enviarFeedbackAlModelo(feedbackArgs);

    expect(resultado).toEqual({ estado: 'almacenado', id: 'fb-1' });

    expect(mockGetSignedUrl).toHaveBeenCalledWith(IMG_PATH, 600);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://vision.test/feedback');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-api-key': 'test-key',
    });
    expect(JSON.parse(init.body)).toEqual({
      id_observacion: OBS_ID,
      especie_confirmada: 'Hypanus_guttatus',
      validado_por: 'Ana Pérez <ana@uraba.co>',
      url_imagen: `https://signed/${IMG_PATH}?s=600`,
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Feedback] OK'));
  });

  test('fallo 500: devuelve null, NO lanza error, loguea warn', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });

    const resultado = await visionService.enviarFeedbackAlModelo(feedbackArgs);

    expect(resultado).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Feedback] Fallo 500'));
  });

  test('sin especieCodigo: skip inmediato, no llama fetch', async () => {
    const resultado = await visionService.enviarFeedbackAlModelo({
      ...feedbackArgs,
      especieCodigo: null,
    });

    expect(resultado).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  test('sin VISION_FEEDBACK_URL: skip inmediato', async () => {
    const prev = process.env.VISION_FEEDBACK_URL;
    delete process.env.VISION_FEEDBACK_URL;
    try {
      const resultado = await visionService.enviarFeedbackAlModelo(feedbackArgs);
      expect(resultado).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      process.env.VISION_FEEDBACK_URL = prev;
    }
  });

  test('error de red: devuelve null, NO lanza', async () => {
    global.fetch.mockRejectedValueOnce(new Error('boom'));
    const resultado = await visionService.enviarFeedbackAlModelo(feedbackArgs);
    expect(resultado).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[Feedback] Error:', 'boom');
  });
});
