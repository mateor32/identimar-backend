const { z } = require('zod');

const authService = require('../services/auth.service');
const { hashPassword, verificarPassword } = require('../utils/password');
const {
  generarAccessToken,
  generarRefreshToken,
  verificarToken,
  ttlASegundos,
  ACCESS_TTL,
} = require('../utils/jwt');
const {
  ValidacionError,
  ConflictoError,
  NoAutenticadoError,
  NoEncontradoError,
} = require('../utils/errors');

// ---- Schemas Zod -----------------------------------------------------------

const registroSchema = z.object({
  nombre_completo: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres').max(120),
  correo: z.string().trim().toLowerCase().email('El correo no es válido'),
  password: z
    .string()
    .min(8, 'La contraseña debe tener al menos 8 caracteres')
    .max(72, 'La contraseña no puede exceder 72 caracteres'), // límite de bcrypt
  telefono: z.string().trim().max(30, 'telefono no puede exceder 30 caracteres').optional(),
});

const loginSchema = z.object({
  correo: z.string().trim().toLowerCase().email('El correo no es válido'),
  password: z.string().min(1, 'La contraseña es obligatoria'),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'El refresh_token es obligatorio'),
});

/**
 * Toma un ZodError y lo transforma en ValidacionError con detalles amigables.
 */
function parsear(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detalles = result.error.issues.map((i) => ({
      campo: i.path.join('.'),
      mensaje: i.message,
    }));
    throw new ValidacionError('Datos inválidos', detalles);
  }
  return result.data;
}

// ---- Handlers --------------------------------------------------------------

/**
 * POST /auth/registro
 * No devuelve token: tras registrarse el usuario debe hacer login.
 */
async function registro(req, res) {
  const datos = parsear(registroSchema, req.body);

  const existente = await authService.buscarPorCorreo(datos.correo);
  if (existente) {
    throw new ConflictoError('Ya existe un usuario con ese correo');
  }

  const passwordHash = await hashPassword(datos.password);
  const usuario = await authService.crearUsuario({
    nombreCompleto: datos.nombre_completo,
    correo: datos.correo,
    passwordHash,
    telefono: datos.telefono,
  });

  res.status(201).json({ usuario });
}

/**
 * POST /auth/login
 * Devuelve access_token + refresh_token + expires_in + usuario público.
 */
async function login(req, res) {
  const datos = parsear(loginSchema, req.body);

  const registro = await authService.buscarPorCorreo(datos.correo);
  // Mismo mensaje en ambos casos para no filtrar si el correo existe.
  if (!registro || !(await verificarPassword(datos.password, registro.password_hash))) {
    throw new NoAutenticadoError('Correo o contraseña incorrectos');
  }
  if (registro.activo === false) {
    throw new NoAutenticadoError('La cuenta está desactivada');
  }

  const usuario = authService.mapearUsuarioPublico(registro);
  res.json({
    access_token: generarAccessToken(usuario),
    refresh_token: generarRefreshToken(usuario),
    expires_in: ttlASegundos(ACCESS_TTL),
    usuario,
  });
}

/**
 * POST /auth/refresh
 * Intercambia un refresh_token válido por un nuevo access_token.
 * No rota el refresh en esta versión (simplificación académica).
 */
async function refresh(req, res) {
  const { refresh_token: refreshToken } = parsear(refreshSchema, req.body);

  const payload = verificarToken(refreshToken);
  if (payload.type !== 'refresh') {
    throw new NoAutenticadoError('Se esperaba un refresh token');
  }

  // Releer el usuario desde la BD por si cambió rol o fue desactivado.
  const usuario = await authService.buscarPorId(payload.sub);
  if (!usuario || usuario.activo === false) {
    throw new NoAutenticadoError('El usuario ya no es válido');
  }

  res.json({
    access_token: generarAccessToken(usuario),
    expires_in: ttlASegundos(ACCESS_TTL),
  });
}

/**
 * GET /auth/perfil
 * Devuelve el usuario autenticado. Requiere requireAuth en la ruta.
 */
async function perfil(req, res) {
  const usuario = await authService.buscarPorId(req.usuario.id);
  if (!usuario) {
    throw new NoEncontradoError('Usuario no encontrado');
  }
  res.json({ usuario });
}

module.exports = {
  registro,
  login,
  refresh,
  perfil,
  // exportamos los schemas por si los tests los necesitan
  registroSchema,
  loginSchema,
  refreshSchema,
};
