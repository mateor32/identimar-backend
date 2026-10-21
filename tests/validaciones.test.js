// Pruebas de la cola de pendientes (GET) y del registro de validación (POST).

process.env.JWT_SECRET = 'test-secret-identimar';
process.env.JWT_ACCESS_TTL = '1h';
process.env.DATABASE_URL = 'postgres://no-usado-en-tests';
process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'anon';
process.env.SUPABASE_BUCKET = 'observaciones';

const { ConflictoError, NoEncontradoError, ValidacionError } = require('../src/utils/errors');

// -- Mocks (prefijo "mock" obligatorio por hoisting de Jest). ---------------
const mockListarPendientes = jest.fn();
const mockRegistrarValidacion = jest.fn();
jest.mock('../src/services/observaciones.service', () => ({
  // Las otras funciones no se usan aquí pero las dejamos declaradas por si acaso.
  crearObservacion: jest.fn(),
  listarObservaciones: jest.fn(),
  obtenerObservacionCompleta: jest.fn(),
  listarPendientes: (...args) => mockListarPendientes(...args),
  ESTADOS_PENDIENTES: ['pendiente_experto', 'no_concluyente'],
}));
jest.mock('../src/services/validaciones.service', () => ({
  registrarValidacion: (...args) => mockRegistrarValidacion(...args),
}));
jest.mock('../src/config/supabase', () => ({
  uploadImage: jest.fn(),
  deleteImage: jest.fn(),
  getSignedUrl: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

const USUARIO = { id: 'uuid-user', correo: 'u@u.co', rol: 'usuario' };
const EXPERTO = { id: 'uuid-exp', correo: 'e@e.co', rol: 'experto' };
const ADMIN = { id: 'uuid-adm', correo: 'a@a.co', rol: 'admin' };

function tokenPara(user) {
  return jwt.sign(
    { sub: user.id, correo: user.correo, rol: user.rol, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  mockListarPendientes.mockReset();
  mockRegistrarValidacion.mockReset();
});

// ---------------------------------------------------------------------------
// GET /api/v1/observaciones/pendientes
// ---------------------------------------------------------------------------

describe('GET /api/v1/observaciones/pendientes', () => {
  test('experto obtiene la cola paginada', async () => {
    mockListarPendientes.mockResolvedValueOnce({
      items: [{ id: 'obs-1' }, { id: 'obs-2' }],
      pagina: 1,
      tamano: 20,
      total: 2,
    });

    const res = await request(app)
      .get('/api/v1/observaciones/pendientes')
      .set('Authorization', `Bearer ${tokenPara(EXPERTO)}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body).toMatchObject({ pagina: 1, tamano: 20, total: 2 });
    expect(mockListarPendientes).toHaveBeenCalledWith({ pagina: 1, tamano: 20 });
  });

  test('admin también tiene acceso', async () => {
    mockListarPendientes.mockResolvedValueOnce({ items: [], pagina: 1, tamano: 20, total: 0 });
    await request(app)
      .get('/api/v1/observaciones/pendientes')
      .set('Authorization', `Bearer ${tokenPara(ADMIN)}`)
      .expect(200);
  });

  test('usuario normal recibe 403', async () => {
    const res = await request(app)
      .get('/api/v1/observaciones/pendientes')
      .set('Authorization', `Bearer ${tokenPara(USUARIO)}`);
    expect(res.status).toBe(403);
    expect(res.body.error.codigo).toBe('SIN_PERMISO');
    expect(mockListarPendientes).not.toHaveBeenCalled();
  });

  test('respeta pagina y tamano', async () => {
    mockListarPendientes.mockResolvedValueOnce({ items: [], pagina: 2, tamano: 50, total: 0 });
    await request(app)
      .get('/api/v1/observaciones/pendientes?pagina=2&tamano=50')
      .set('Authorization', `Bearer ${tokenPara(EXPERTO)}`)
      .expect(200);
    expect(mockListarPendientes).toHaveBeenCalledWith({ pagina: 2, tamano: 50 });
  });

  test('401 sin token', async () => {
    await request(app).get('/api/v1/observaciones/pendientes').expect(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/observaciones/:id/validacion
// ---------------------------------------------------------------------------

describe('POST /api/v1/observaciones/:id/validacion', () => {
  test('decision=confirmada → 201 y nuevo estado "validado"', async () => {
    mockRegistrarValidacion.mockResolvedValueOnce({
      id: 'val-1',
      decision: 'confirmada',
      estado: 'validado',
      especie_aceptada: null,
      creado_en: '2026-10-08T15:00:00.000Z',
    });

    const res = await request(app)
      .post('/api/v1/observaciones/obs-xyz/validacion')
      .set('Authorization', `Bearer ${tokenPara(EXPERTO)}`)
      .send({ decision: 'confirmada', comentario: 'Identificación correcta.' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: 'val-1',
      decision: 'confirmada',
      estado: 'validado',
      especie_aceptada: null,
      creado_en: '2026-10-08T15:00:00.000Z',
    });

    expect(mockRegistrarValidacion).toHaveBeenCalledWith({
      observacionId: 'obs-xyz',
      experto: { id: EXPERTO.id },
      decision: 'confirmada',
      especieFinalCodigo: undefined,
      comentario: 'Identificación correcta.',
    });
  });

  test('decision=corregida → 201 con especie_aceptada poblada', async () => {
    mockRegistrarValidacion.mockResolvedValueOnce({
      id: 'val-2',
      decision: 'corregida',
      estado: 'corregido',
      especie_aceptada: { id: 'esp-9', nombre_cientifico: 'Hypanus americanus', nombre_comun: 'Raya látigo americana' },
      creado_en: '2026-10-08T15:05:00.000Z',
    });

    const res = await request(app)
      .post('/api/v1/observaciones/obs-xyz/validacion')
      .set('Authorization', `Bearer ${tokenPara(EXPERTO)}`)
      .send({ decision: 'corregida', especie_final_codigo: 'H_AMERICANUS' });

    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('corregido');
    expect(res.body.especie_aceptada.nombre_cientifico).toBe('Hypanus americanus');
    expect(mockRegistrarValidacion).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'corregida', especieFinalCodigo: 'H_AMERICANUS' }),
    );
  });

  test('decision=corregida sin especie_final_codigo → 400', async () => {
    const res = await request(app)
      .post('/api/v1/observaciones/obs-xyz/validacion')
      .set('Authorization', `Bearer ${tokenPara(EXPERTO)}`)
      .send({ decision: 'corregida' });

    expect(res.status).toBe(400);
    expect(res.body.error.codigo).toBe('VALIDACION');
    expect(res.body.error.detalles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ campo: 'especie_final_codigo' }),
      ]),
    );
    expect(mockRegistrarValidacion).not.toHaveBeenCalled();
  });

  test('decision=rechazada → 201 y estado "corregido" con especie_aceptada=null', async () => {
    mockRegistrarValidacion.mockResolvedValueOnce({
      id: 'val-3',
      decision: 'rechazada',
      estado: 'corregido',
      especie_aceptada: null,
      creado_en: '2026-10-08T15:10:00.000Z',
    });

    const res = await request(app)
      .post('/api/v1/observaciones/obs-xyz/validacion')
      .set('Authorization', `Bearer ${tokenPara(EXPERTO)}`)
      .send({ decision: 'rechazada', comentario: 'Imagen ininteligible.' });

    expect(res.status).toBe(201);
    expect(res.body.especie_aceptada).toBeNull();
  });

  test('estado no admite validación → 409', async () => {
    mockRegistrarValidacion.mockRejectedValueOnce(
      new ConflictoError('La observación está en estado "validado" y no admite validación experta'),
    );

    const res = await request(app)
      .post('/api/v1/observaciones/obs-xyz/validacion')
      .set('Authorization', `Bearer ${tokenPara(EXPERTO)}`)
      .send({ decision: 'confirmada' });

    expect(res.status).toBe(409);
    expect(res.body.error.codigo).toBe('CONFLICTO');
  });

  test('observación inexistente → 404', async () => {
    mockRegistrarValidacion.mockRejectedValueOnce(
      new NoEncontradoError('Observación no encontrada'),
    );

    const res = await request(app)
      .post('/api/v1/observaciones/obs-xyz/validacion')
      .set('Authorization', `Bearer ${tokenPara(EXPERTO)}`)
      .send({ decision: 'confirmada' });

    expect(res.status).toBe(404);
  });

  test('decision inválida → 400', async () => {
    const res = await request(app)
      .post('/api/v1/observaciones/obs-xyz/validacion')
      .set('Authorization', `Bearer ${tokenPara(EXPERTO)}`)
      .send({ decision: 'ignorada' });

    expect(res.status).toBe(400);
    expect(mockRegistrarValidacion).not.toHaveBeenCalled();
  });

  test('usuario normal recibe 403', async () => {
    const res = await request(app)
      .post('/api/v1/observaciones/obs-xyz/validacion')
      .set('Authorization', `Bearer ${tokenPara(USUARIO)}`)
      .send({ decision: 'confirmada' });

    expect(res.status).toBe(403);
    expect(mockRegistrarValidacion).not.toHaveBeenCalled();
  });

  test('especie_final_codigo inexistente → 400 propagado del service', async () => {
    mockRegistrarValidacion.mockRejectedValueOnce(
      new ValidacionError('La especie "DRAGON" no existe', [
        { campo: 'especie_final_codigo', mensaje: 'Código no reconocido' },
      ]),
    );

    const res = await request(app)
      .post('/api/v1/observaciones/obs-xyz/validacion')
      .set('Authorization', `Bearer ${tokenPara(EXPERTO)}`)
      .send({ decision: 'corregida', especie_final_codigo: 'DRAGON' });

    expect(res.status).toBe(400);
    expect(res.body.error.detalles[0].campo).toBe('especie_final_codigo');
  });

  test('401 sin token', async () => {
    await request(app).post('/api/v1/observaciones/obs-xyz/validacion').send({ decision: 'confirmada' }).expect(401);
  });
});
