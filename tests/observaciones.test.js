// Pruebas del endpoint POST /api/v1/observaciones.
// Mockeamos el service (que es quien toca BD y Storage) para aislar la ruta.

process.env.JWT_SECRET = 'test-secret-identimar';
process.env.JWT_ACCESS_TTL = '1h';
process.env.DATABASE_URL = 'postgres://no-usado-en-tests';
// Variables de Supabase: aun con mock, el require() del config no debe explotar.
process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'anon';
process.env.SUPABASE_BUCKET = 'observaciones';

const { ValidacionError } = require('../src/utils/errors');

// Service mockeado. Guardamos la última llamada para hacer aserciones.
// Las vars DEBEN empezar con "mock" para pasar el guard de hoisting de jest.
const mockCrearObservacion = jest.fn();
const mockListarObservaciones = jest.fn();
const mockObtenerObservacionCompleta = jest.fn();
jest.mock('../src/services/observaciones.service', () => ({
  crearObservacion: (...args) => mockCrearObservacion(...args),
  listarObservaciones: (...args) => mockListarObservaciones(...args),
  obtenerObservacionCompleta: (...args) => mockObtenerObservacionCompleta(...args),
}));

// supabase.getSignedUrl se usa en el detalle. Mock a un string estable.
const mockGetSignedUrl = jest.fn(async (path) => `https://signed/${path}?sig=xyz`);
jest.mock('../src/config/supabase', () => ({
  uploadImage: jest.fn(async () => undefined),
  deleteImage: jest.fn(async () => undefined),
  getSignedUrl: (...args) => mockGetSignedUrl(...args),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

// PNG 1x1 válido (rojo opaco). Suficiente para image-size y multer.
const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

const USUARIO = { id: '11111111-1111-1111-1111-111111111111', correo: 'ana@uraba.co', rol: 'usuario' };
const EXPERTO = { id: '22222222-2222-2222-2222-222222222222', correo: 'exp@uraba.co', rol: 'experto' };
const ADMIN = { id: '33333333-3333-3333-3333-333333333333', correo: 'adm@uraba.co', rol: 'administrador' };

function tokenPara(user) {
  return jwt.sign({ sub: user.id, correo: user.correo, rol: user.rol, type: 'access' },
    process.env.JWT_SECRET, { expiresIn: '1h' });
}
function tokenValido() { return tokenPara(USUARIO); }

function datosOk(overrides = {}) {
  return JSON.stringify({
    latitud: 8.75,
    longitud: -76.65,
    fecha_hora_evento: '2026-10-08T14:30:00Z',
    tipo_ambiente_codigo: 'manglar',
    condicion_organismo_codigo: 'viva',
    notas: 'Hembra adulta cerca de la orilla.',
    ...overrides,
  });
}

beforeEach(() => {
  mockCrearObservacion.mockReset();
  mockListarObservaciones.mockReset();
  mockObtenerObservacionCompleta.mockReset();
  mockGetSignedUrl.mockClear();
});

describe('POST /api/v1/observaciones', () => {
  test('201: crea la observación y devuelve { id, estado, creado_en }', async () => {
    mockCrearObservacion.mockResolvedValueOnce({
      id: 'obs-uuid-1',
      estado: 'recibido',
      creado_en: '2026-10-08T14:30:05.000Z',
    });

    const res = await request(app)
      .post('/api/v1/observaciones')
      .set('Authorization', `Bearer ${tokenValido()}`)
      .field('datos', datosOk())
      .attach('imagen', PNG_BUFFER, { filename: 'raya.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: 'obs-uuid-1',
      estado: 'recibido',
      creado_en: '2026-10-08T14:30:05.000Z',
    });

    // El controller empaquetó bien la llamada al service.
    expect(mockCrearObservacion).toHaveBeenCalledTimes(1);
    const args = mockCrearObservacion.mock.calls[0][0];
    expect(args.usuario.id).toBe(USUARIO.id);
    expect(args.datos.latitud).toBe(8.75);
    expect(args.datos.tipo_ambiente_codigo).toBe('manglar');
    expect(args.imagen).toMatchObject({
      mimetype: 'image/png',
      width: 1,
      height: 1,
      size: PNG_BUFFER.length,
    });
    expect(args.imagen.checksum).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    expect(Buffer.isBuffer(args.imagen.buffer)).toBe(true);
  });

  test('400: falta la imagen', async () => {
    const res = await request(app)
      .post('/api/v1/observaciones')
      .set('Authorization', `Bearer ${tokenValido()}`)
      .field('datos', datosOk());

    expect(res.status).toBe(400);
    expect(res.body.error.codigo).toBe('VALIDACION');
    expect(res.body.error.mensaje).toMatch(/imagen/i);
    expect(mockCrearObservacion).not.toHaveBeenCalled();
  });

  test('400: latitud fuera de rango', async () => {
    const res = await request(app)
      .post('/api/v1/observaciones')
      .set('Authorization', `Bearer ${tokenValido()}`)
      .field('datos', datosOk({ latitud: 123 }))
      .attach('imagen', PNG_BUFFER, { filename: 'raya.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.error.codigo).toBe('VALIDACION');
    expect(res.body.error.detalles).toEqual(
      expect.arrayContaining([expect.objectContaining({ campo: 'latitud' })]),
    );
    expect(mockCrearObservacion).not.toHaveBeenCalled();
  });

  test('400: tipo_ambiente no existe (service propaga ValidacionError)', async () => {
    mockCrearObservacion.mockRejectedValueOnce(
      new ValidacionError('El tipo_ambiente_codigo "marte" no existe', [
        { campo: 'tipo_ambiente_codigo', mensaje: 'Código no reconocido' },
      ]),
    );

    const res = await request(app)
      .post('/api/v1/observaciones')
      .set('Authorization', `Bearer ${tokenValido()}`)
      .field('datos', datosOk({ tipo_ambiente_codigo: 'marte' }))
      .attach('imagen', PNG_BUFFER, { filename: 'raya.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.error.codigo).toBe('VALIDACION');
    expect(res.body.error.detalles[0].campo).toBe('tipo_ambiente_codigo');
  });

  test('400: mimetype no permitido (p. ej. gif)', async () => {
    const gif = Buffer.from('GIF89a', 'ascii');
    const res = await request(app)
      .post('/api/v1/observaciones')
      .set('Authorization', `Bearer ${tokenValido()}`)
      .field('datos', datosOk())
      .attach('imagen', gif, { filename: 'raya.gif', contentType: 'image/gif' });

    expect(res.status).toBe(400);
    expect(res.body.error.codigo).toBe('VALIDACION');
    expect(res.body.error.mensaje).toMatch(/JPEG|PNG/);
  });

  test('401: sin token no se puede crear', async () => {
    const res = await request(app)
      .post('/api/v1/observaciones')
      .field('datos', datosOk())
      .attach('imagen', PNG_BUFFER, { filename: 'raya.png', contentType: 'image/png' });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/observaciones  (listado)
// ---------------------------------------------------------------------------

describe('GET /api/v1/observaciones', () => {
  test('usuario normal fuerza filtroUsuarioId = su id', async () => {
    mockListarObservaciones.mockResolvedValueOnce({
      items: [{ id: 'obs-1' }],
      pagina: 1,
      tamano: 20,
      total: 1,
    });

    const res = await request(app)
      .get('/api/v1/observaciones')
      .set('Authorization', `Bearer ${tokenPara(USUARIO)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [{ id: 'obs-1' }], pagina: 1, tamano: 20, total: 1 });

    expect(mockListarObservaciones).toHaveBeenCalledWith({
      filtroUsuarioId: USUARIO.id,
      estadoNombre: null,
      pagina: 1,
      tamano: 20,
    });
  });

  test('admin recibe filtroUsuarioId = null (ve todas)', async () => {
    mockListarObservaciones.mockResolvedValueOnce({ items: [], pagina: 1, tamano: 20, total: 0 });

    await request(app)
      .get('/api/v1/observaciones')
      .set('Authorization', `Bearer ${tokenPara(ADMIN)}`)
      .expect(200);

    expect(mockListarObservaciones.mock.calls[0][0].filtroUsuarioId).toBeNull();
  });

  test('propaga filtros de query y pagination', async () => {
    mockListarObservaciones.mockResolvedValueOnce({ items: [], pagina: 3, tamano: 50, total: 0 });

    await request(app)
      .get('/api/v1/observaciones?estado=recibido&pagina=3&tamano=50')
      .set('Authorization', `Bearer ${tokenPara(ADMIN)}`)
      .expect(200);

    expect(mockListarObservaciones).toHaveBeenCalledWith({
      filtroUsuarioId: null,
      estadoNombre: 'recibido',
      pagina: 3,
      tamano: 50,
    });
  });

  test('400 cuando tamano > 100', async () => {
    const res = await request(app)
      .get('/api/v1/observaciones?tamano=500')
      .set('Authorization', `Bearer ${tokenPara(USUARIO)}`);

    expect(res.status).toBe(400);
    expect(res.body.error.codigo).toBe('VALIDACION');
  });

  test('401 sin token', async () => {
    const res = await request(app).get('/api/v1/observaciones');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/observaciones/:id  (detalle)
// ---------------------------------------------------------------------------

function fixtureDetalle({ autorId = USUARIO.id } = {}) {
  return {
    observacion: {
      id: 'obs-detalle-1',
      usuario_id: autorId,
      latitud: 8.75,
      longitud: -76.65,
      fecha_hora_evento: '2026-10-08T14:30:00Z',
      notas: null,
      creado_en: '2026-10-08T14:30:05.000Z',
      estado: { id: 'est-1', codigo: 'recibido', nombre_visible: 'Recibido', orden: 1, es_terminal: false },
      tipo_ambiente: { id: 'amb-1', codigo: 'manglar', nombre_visible: 'Manglar' },
      condicion_organismo: { id: 'cond-1', codigo: 'viva', nombre_visible: 'Viva' },
      especie_sugerida: null,
      usuario: { id: autorId, nombre_completo: 'Ana', correo: 'ana@uraba.co', rol: 'usuario' },
    },
    imagen: {
      id: 'img-1',
      url_storage: 'observaciones/obs-detalle-1.png',
      mime: 'image/png',
      bytes: 100,
      ancho_px: 1,
      alto_px: 1,
      checksum_sha256: 'a'.repeat(64),
      creado_en: '2026-10-08T14:30:06.000Z',
    },
    prediccion: null,
    validacion: null,
    historial: [
      {
        id: 'h-1',
        estado_anterior: null,
        estado_nuevo: { id: 'est-1', codigo: 'recibido', nombre_visible: 'Recibido' },
        usuario: { id: autorId, nombre_completo: 'Ana', rol: 'usuario' },
        nota: 'Observación creada',
        ocurrido_en: '2026-10-08T14:30:05.000Z',
      },
    ],
  };
}

describe('GET /api/v1/observaciones/:id', () => {
  test('autor puede ver su observación con URL firmada', async () => {
    mockObtenerObservacionCompleta.mockResolvedValueOnce(fixtureDetalle());

    const res = await request(app)
      .get('/api/v1/observaciones/obs-detalle-1')
      .set('Authorization', `Bearer ${tokenPara(USUARIO)}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('obs-detalle-1');
    expect(res.body.estado).toMatchObject({ codigo: 'recibido' });
    expect(res.body.imagen).toMatchObject({
      url_firmada: 'https://signed/observaciones/obs-detalle-1.png?sig=xyz',
      url_expira_en: 3600,
    });
    expect(res.body.historial).toHaveLength(1);
    expect(res.body).not.toHaveProperty('usuario_id'); // ya va en `usuario`

    expect(mockGetSignedUrl).toHaveBeenCalledWith('observaciones/obs-detalle-1.png', 3600);
  });

  test('403: usuario normal no puede ver observación de otro', async () => {
    mockObtenerObservacionCompleta.mockResolvedValueOnce(
      fixtureDetalle({ autorId: 'otro-usuario-id' }),
    );

    const res = await request(app)
      .get('/api/v1/observaciones/obs-detalle-1')
      .set('Authorization', `Bearer ${tokenPara(USUARIO)}`);

    expect(res.status).toBe(403);
    expect(res.body.error.codigo).toBe('SIN_PERMISO');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  test('experto puede ver observación ajena', async () => {
    mockObtenerObservacionCompleta.mockResolvedValueOnce(
      fixtureDetalle({ autorId: 'otro-usuario-id' }),
    );

    const res = await request(app)
      .get('/api/v1/observaciones/obs-detalle-1')
      .set('Authorization', `Bearer ${tokenPara(EXPERTO)}`);

    expect(res.status).toBe(200);
  });

  test('admin puede ver observación ajena', async () => {
    mockObtenerObservacionCompleta.mockResolvedValueOnce(
      fixtureDetalle({ autorId: 'otro-usuario-id' }),
    );

    const res = await request(app)
      .get('/api/v1/observaciones/obs-detalle-1')
      .set('Authorization', `Bearer ${tokenPara(ADMIN)}`);

    expect(res.status).toBe(200);
  });

  test('404 si no existe', async () => {
    mockObtenerObservacionCompleta.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/v1/observaciones/no-existe')
      .set('Authorization', `Bearer ${tokenPara(USUARIO)}`);

    expect(res.status).toBe(404);
    expect(res.body.error.codigo).toBe('NO_ENCONTRADO');
  });

  test('401 sin token', async () => {
    const res = await request(app).get('/api/v1/observaciones/cualquiera');
    expect(res.status).toBe(401);
  });
});
