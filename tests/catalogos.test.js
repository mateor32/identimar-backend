// Pruebas de endpoints de catálogos.
// Mockeamos el service para no depender de la BD real; los conteos replican
// los de los seeds oficiales (5 especies, 5 familias, 6 ambientes, 5 condiciones, 7 estados).

process.env.JWT_SECRET = 'test-secret-identimar';
process.env.DATABASE_URL = 'postgres://no-usado-en-tests';

// Nota: jest.mock() se hace hoist al top del archivo, así que las fixtures
// viven DENTRO de la factory (no podemos referenciar consts externas aquí).
jest.mock('../src/services/catalogos.service', () => {
  const FAMILIAS = [
    { id: 'fam-1', nombre: 'Dasyatidae' },
    { id: 'fam-2', nombre: 'Myliobatidae' },
    { id: 'fam-3', nombre: 'Rhinopteridae' },
    { id: 'fam-4', nombre: 'Urotrygonidae' },
    { id: 'fam-5', nombre: 'Narcinidae' },
  ];
  const ESPECIES = [
    { id: 'esp-1', nombre_cientifico: 'Hypanus guttatus', nombre_comun: 'Raya látigo', familia: FAMILIAS[0] },
    { id: 'esp-2', nombre_cientifico: 'Hypanus americanus', nombre_comun: 'Raya látigo americana', familia: FAMILIAS[0] },
    { id: 'esp-3', nombre_cientifico: 'Aetobatus narinari', nombre_comun: 'Raya águila', familia: FAMILIAS[1] },
    { id: 'esp-4', nombre_cientifico: 'Rhinoptera bonasus', nombre_comun: 'Raya diablo', familia: FAMILIAS[2] },
    { id: 'esp-5', nombre_cientifico: 'Narcine bancroftii', nombre_comun: 'Raya eléctrica', familia: FAMILIAS[4] },
  ];
  const TIPOS_AMBIENTE = [
    { id: 'amb-1', nombre: 'Playa arenosa' },
    { id: 'amb-2', nombre: 'Estuario' },
    { id: 'amb-3', nombre: 'Manglar' },
    { id: 'amb-4', nombre: 'Zona rocosa' },
    { id: 'amb-5', nombre: 'Arrecife' },
    { id: 'amb-6', nombre: 'Mar abierto' },
  ];
  const CONDICIONES = [
    { id: 'cond-1', nombre: 'Viva' },
    { id: 'cond-2', nombre: 'Muerta' },
    { id: 'cond-3', nombre: 'Capturada' },
    { id: 'cond-4', nombre: 'Liberada' },
    { id: 'cond-5', nombre: 'Desconocida' },
  ];
  const ESTADOS = [
    { id: 'est-1', nombre: 'recibido', orden: 1, es_terminal: false },
    { id: 'est-2', nombre: 'procesando', orden: 2, es_terminal: false },
    { id: 'est-3', nombre: 'identificado', orden: 3, es_terminal: false },
    { id: 'est-4', nombre: 'no_concluyente', orden: 4, es_terminal: false },
    { id: 'est-5', nombre: 'pendiente_experto', orden: 5, es_terminal: false },
    { id: 'est-6', nombre: 'validado', orden: 6, es_terminal: true },
    { id: 'est-7', nombre: 'corregido', orden: 7, es_terminal: true },
  ];

  return {
    listarEspecies: jest.fn(async () => ESPECIES),
    listarFamilias: jest.fn(async () => FAMILIAS),
    listarTiposAmbiente: jest.fn(async () => TIPOS_AMBIENTE),
    listarCondicionesOrganismo: jest.fn(async () => CONDICIONES),
    listarEstados: jest.fn(async () => ESTADOS),
  };
});

const request = require('supertest');
const app = require('../src/app');
const catalogosService = require('../src/services/catalogos.service');
const catalogosController = require('../src/controllers/catalogos.controller');

beforeEach(() => {
  catalogosController.__resetCache();
  jest.clearAllMocks();
});

describe('GET /api/v1/catalogos/*', () => {
  test('GET /especies devuelve 5 especies con familia embebida', async () => {
    const res = await request(app).get('/api/v1/catalogos/especies');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(5);
    expect(res.body[0]).toHaveProperty('familia');
    expect(res.body[0].familia).toMatchObject({ id: expect.any(String), nombre: expect.any(String) });
  });

  test('GET /familias devuelve 5 familias', async () => {
    const res = await request(app).get('/api/v1/catalogos/familias');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });

  test('GET /tipos-ambiente devuelve 6 tipos', async () => {
    const res = await request(app).get('/api/v1/catalogos/tipos-ambiente');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
  });

  test('GET /condiciones-organismo devuelve 5 condiciones', async () => {
    const res = await request(app).get('/api/v1/catalogos/condiciones-organismo');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });

  test('GET /estados devuelve 7 estados ordenados con es_terminal', async () => {
    const res = await request(app).get('/api/v1/catalogos/estados');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(7);
    // Vienen ordenados por `orden`.
    expect(res.body.map((e) => e.orden)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Terminales declarados.
    const terminales = res.body.filter((e) => e.es_terminal).map((e) => e.nombre);
    expect(terminales.sort()).toEqual(['corregido', 'validado']);
  });

  test('los endpoints de catálogos son públicos (no exigen token)', async () => {
    const res = await request(app).get('/api/v1/catalogos/familias');
    expect(res.status).toBe(200);
  });
});

describe('Caché en memoria (TTL 5 min)', () => {
  test('la segunda llamada al mismo catálogo no vuelve a consultar el service', async () => {
    await request(app).get('/api/v1/catalogos/familias').expect(200);
    await request(app).get('/api/v1/catalogos/familias').expect(200);

    expect(catalogosService.listarFamilias).toHaveBeenCalledTimes(1);
  });

  test('__resetCache fuerza una nueva consulta', async () => {
    await request(app).get('/api/v1/catalogos/familias').expect(200);
    catalogosController.__resetCache();
    await request(app).get('/api/v1/catalogos/familias').expect(200);

    expect(catalogosService.listarFamilias).toHaveBeenCalledTimes(2);
  });
});
