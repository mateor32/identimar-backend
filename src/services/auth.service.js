

const { query } = require('../config/database');

// Columnas que se exponen al cliente. password_hash NUNCA sale de aquí.
const COLUMNAS_PUBLICAS = `
  id,
  nombre,
  correo,
  rol,
  activo,
  creado_en
`;

/**
 * Busca un usuario por correo. Devuelve el registro completo (incluido password_hash)
 * porque esta función se usa para login/verificación.
 * Para mandar al cliente, usar mapearUsuarioPublico().
 */
async function buscarPorCorreo(correo) {
  const { rows } = await query(
    `SELECT id, nombre, correo, password_hash, rol, activo, creado_en
     FROM usuario
     WHERE correo = $1`,
    [correo.toLowerCase()],
  );
  return rows[0] || null;
}

async function buscarPorId(id) {
  const { rows } = await query(
    `SELECT ${COLUMNAS_PUBLICAS}
     FROM usuario
     WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Crea un usuario con rol 'usuario' por defecto.
 * El rol experto/admin se cambia manualmente en la BD.
 */
async function crearUsuario({ nombre, correo, passwordHash }) {
  const { rows } = await query(
    `INSERT INTO usuario (nombre, correo, password_hash, rol, activo)
     VALUES ($1, $2, $3, 'usuario', TRUE)
     RETURNING ${COLUMNAS_PUBLICAS}`,
    [nombre, correo.toLowerCase(), passwordHash],
  );
  return rows[0];
}

/**
 * Proyecta un registro de usuario al formato público (sin password_hash).
 * Útil cuando venimos de buscarPorCorreo().
 */
function mapearUsuarioPublico(usuario) {
  if (!usuario) return null;
  const { password_hash: _omit, ...publico } = usuario;
  return publico;
}

module.exports = {
  buscarPorCorreo,
  buscarPorId,
  crearUsuario,
  mapearUsuarioPublico,
};
