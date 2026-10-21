const jwt = require('jsonwebtoken');
const { NoAutenticadoError } = require('./errors');

// Secretos y TTLs se leen de env. Hay defaults solo para desarrollo/tests;
// en producción (Render) estas variables son obligatorias.
const JWT_SECRET = process.env.JWT_SECRET || 'identimar-dev-secret-change-me';
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '1h';
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '7d';

// Convierte strings tipo "1h", "7d", "900s" a segundos. Útil para `expires_in`.
function ttlASegundos(ttl) {
  if (typeof ttl === 'number') return ttl;
  const match = /^(\d+)\s*([smhd])?$/.exec(String(ttl).trim());
  if (!match) return 3600;
  const n = parseInt(match[1], 10);
  const unidad = match[2] || 's';
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[unidad];
  return n * factor;
}

/**
 * Construye el payload común de los tokens.
 * sub = id del usuario (convención estándar JWT).
 */
function payloadBase(usuario) {
  return {
    sub: usuario.id,
    correo: usuario.correo,
    rol: usuario.rol,
  };
}

function generarAccessToken(usuario) {
  return jwt.sign({ ...payloadBase(usuario), type: 'access' }, JWT_SECRET, { expiresIn: ACCESS_TTL });
}

function generarRefreshToken(usuario) {
  return jwt.sign({ ...payloadBase(usuario), type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_TTL });
}

/**
 * Verifica y decodifica un token.
 * Lanza NoAutenticadoError si está vencido, mal firmado o malformado.
 */
function verificarToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new NoAutenticadoError('Token expirado');
    }
    throw new NoAutenticadoError('Token inválido');
  }
}

module.exports = {
  generarAccessToken,
  generarRefreshToken,
  verificarToken,
  ttlASegundos,
  ACCESS_TTL,
  REFRESH_TTL,
};
