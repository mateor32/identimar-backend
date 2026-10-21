const bcrypt = require('bcryptjs');

// Rondas de bcrypt. 10 es el estándar aceptado: ~100ms por hash en hardware común.
// Si en el futuro se sube, los hashes viejos siguen siendo válidos (el salt+rounds van dentro del hash).
const SALT_ROUNDS = 10;

/**
 * Genera el hash bcrypt para una contraseña en texto plano.
 * @param {string} plaintext
 * @returns {Promise<string>} hash listo para persistir en usuario.password_hash
 */
async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

/**
 * Verifica si una contraseña en texto plano coincide con el hash almacenado.
 * @param {string} plaintext
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verificarPassword(plaintext, hash) {
  if (!hash) return false;
  return bcrypt.compare(plaintext, hash);
}

module.exports = { hashPassword, verificarPassword };
