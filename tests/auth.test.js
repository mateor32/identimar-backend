// Pruebas del módulo de autenticación.
// El service se mockea para que las pruebas no dependan de la BD real.

process.env.JWT_SECRET = 'test-secret-identimar';
process.env.JWT_ACCESS_TTL = '1h';
process.env.JWT_REFRESH_TTL = '7d';
process.env.DATABASE_URL = 'postgres://no-usado-en-tests';

jest.mock('../src/services/auth.service', () => {
  // Simulamos una tabla en memoria.
  const usuarios = new Map(); // correo -> registro

  function mapearUsuarioPublico(usuario) {
    if (!usuario) return null;
    const { password_hash: _omit, ...publico } = usuario;
    return publico;
  }

  return {
    __reset: () => usuarios.clear(),
    __seed: (registro) => usuarios.set(registro.correo, registro),

    buscarPorCorreo: jest.fn(async (correo) => usuarios.get(String(correo).toLowerCase()) || null),

    buscarPorId: jest.fn(async (id) => {
      for (const u of usuarios.values()) {
        if (u.id === id) return mapearUsuarioPublico(u);
      }
      return null;
    }),

    crearUsuario: jest.fn(async ({ nombre, correo, passwordHash }) => {
      const registro = {
        id: `uuid-${usuarios.size + 1}`,
        nombre,
        correo: correo.toLowerCase(),
        password_hash: passwordHash,
        rol: 'usuario',
        activo: true,
        creado_en: new Date().toISOString(),
      };
      usuarios.set(registro.correo, registro);
      return mapearUsuarioPublico(registro);
    }),

    mapearUsuarioPublico,
  };
});

const request = require('supertest');
const app = require('../src/app');
const authService = require('../src/services/auth.service');

beforeEach(() => {
  authService.__reset();
});

describe('POST /api/v1/auth/registro', () => {
  test('registra un usuario y devuelve 201 sin token', async () => {
    const res = await request(app).post('/api/v1/auth/registro').send({
      nombre: 'Ana Pescadora',
      correo: 'ana@uraba.co',
      password: 'claveSegura123',
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('usuario');
    expect(res.body.usuario).toMatchObject({
      nombre: 'Ana Pescadora',
      correo: 'ana@uraba.co',
      rol: 'usuario',
      activo: true,
    });
    expect(res.body.usuario).not.toHaveProperty('password_hash');
    expect(res.body).not.toHaveProperty('access_token');
  });

  test('rechaza correo duplicado con 409', async () => {
    const base = {
      nombre: 'Ana Pescadora',
      correo: 'ana@uraba.co',
      password: 'claveSegura123',
    };
    await request(app).post('/api/v1/auth/registro').send(base).expect(201);

    const res = await request(app).post('/api/v1/auth/registro').send(base);
    expect(res.status).toBe(409);
    expect(res.body.error.codigo).toBe('CONFLICTO');
  });

  test('rechaza payload inválido con 400', async () => {
    const res = await request(app).post('/api/v1/auth/registro').send({
      nombre: 'A',
      correo: 'no-es-correo',
      password: 'corta',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.codigo).toBe('VALIDACION');
    expect(Array.isArray(res.body.error.detalles)).toBe(true);
  });
});

describe('POST /api/v1/auth/login', () => {
  const credenciales = {
    nombre: 'Ana Pescadora',
    correo: 'ana@uraba.co',
    password: 'claveSegura123',
  };

  beforeEach(async () => {
    await request(app).post('/api/v1/auth/registro').send(credenciales).expect(201);
  });

  test('login correcto devuelve tokens y usuario', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      correo: credenciales.correo,
      password: credenciales.password,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('access_token');
    expect(res.body).toHaveProperty('refresh_token');
    expect(typeof res.body.expires_in).toBe('number');
    expect(res.body.usuario).toMatchObject({
      correo: credenciales.correo,
      rol: 'usuario',
    });
    expect(res.body.usuario).not.toHaveProperty('password_hash');
  });

  test('password incorrecto responde 401', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      correo: credenciales.correo,
      password: 'claveQueNoEs',
    });

    expect(res.status).toBe(401);
    expect(res.body.error.codigo).toBe('NO_AUTENTICADO');
  });
});

describe('GET /api/v1/auth/perfil', () => {
  test('con token válido devuelve el usuario; sin token responde 401', async () => {
    await request(app)
      .post('/api/v1/auth/registro')
      .send({ nombre: 'Ana Pescadora', correo: 'ana@uraba.co', password: 'claveSegura123' })
      .expect(201);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ correo: 'ana@uraba.co', password: 'claveSegura123' })
      .expect(200);

    const sinToken = await request(app).get('/api/v1/auth/perfil');
    expect(sinToken.status).toBe(401);

    const conToken = await request(app)
      .get('/api/v1/auth/perfil')
      .set('Authorization', `Bearer ${login.body.access_token}`);

    expect(conToken.status).toBe(200);
    expect(conToken.body.usuario.correo).toBe('ana@uraba.co');
  });
});
