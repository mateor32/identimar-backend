const { verificarToken } = require('../utils/jwt');
const { NoAutenticadoError, SinPermisoError } = require('../utils/errors');

/**
 * Extrae el token del header Authorization: "Bearer <token>".
 * Devuelve null si no viene, para que requireAuth lance un error consistente.
 */
function extraerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || typeof header !== 'string') return null;
  const [esquema, token] = header.split(' ');
  if (esquema !== 'Bearer' || !token) return null;
  return token.trim();
}

/**
 * Middleware que exige un access token válido.
 * Deja en req.usuario el payload decodificado { sub, correo, rol }.
 */
function requireAuth(req, _res, next) {
  const token = extraerToken(req);
  if (!token) {
    return next(new NoAutenticadoError('Falta el token de autenticación'));
  }

  const payload = verificarToken(token);

  // Solo los access tokens habilitan rutas protegidas.
  // Los refresh tokens se usan únicamente en POST /auth/refresh.
  if (payload.type && payload.type !== 'access') {
    return next(new NoAutenticadoError('Se requiere un access token'));
  }

  req.usuario = { id: payload.sub, correo: payload.correo, rol: payload.rol };
  return next();
}

/**
 * Middleware factory. Autoriza solo si el rol del usuario está entre los permitidos.
 * Debe usarse DESPUÉS de requireAuth.
 *   router.get('/x', requireAuth, requireRole('experto', 'administrador'), handler)
 */
function requireRole(...rolesPermitidos) {
  return (req, _res, next) => {
    if (!req.usuario) {
      return next(new NoAutenticadoError('No autenticado'));
    }
    if (!rolesPermitidos.includes(req.usuario.rol)) {
      return next(new SinPermisoError('Tu rol no tiene acceso a este recurso'));
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
