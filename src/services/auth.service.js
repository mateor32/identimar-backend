const { query } = require('../config/database');

// Columnas que se exponen al cliente. password_hash NUNCA sale de aquí.
// Resolvemos `rol` como el `codigo` de la tabla `rol` (string), para que
// req.usuario.rol siga siendo un valor comparable como 'usuario'/'experto'/'administrador'.
const SELECT_PUBLICO = `
  u.id,
  u.nombre_completo,
  u.correo,
  u.telefono,
  r.codigo AS rol,
  u.activo,
  u.creado_en
`;

/**
 * Busca un usuario por correo. Devuelve el registro completo (incluido password_hash)
 * porque esta función se usa para login/verificación.
 * Para mandar al cliente, usar mapearUsuarioPublico().
 */
async function buscarPorCorreo(correo) {
  const { rows } = await query(
    `SELECT ${SELECT_PUBLICO}, u.password_hash
     FROM usuario u
     JOIN rol r ON r.id = u.rol_id
     WHERE u.correo = $1`,
    [correo.toLowerCase()],
  );
  return rows[0] || null;
}

async function buscarPorId(id) {
  const { rows } = await query(
    `SELECT ${SELECT_PUBLICO}
     FROM usuario u
     JOIN rol r ON r.id = u.rol_id
     WHERE u.id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Crea un usuario con rol 'usuario' por defecto.
 * El rol experto/administrador se cambia manualmente en la BD.
 */
async function crearUsuario({ nombreCompleto, correo, passwordHash, telefono }) {
  const { rows } = await query(
    `WITH nuevo AS (
       INSERT INTO usuario (nombre_completo, correo, password_hash, rol_id, telefono, activo)
       VALUES ($1, $2, $3, (SELECT id FROM rol WHERE codigo = 'usuario' LIMIT 1), $4, TRUE)
       RETURNING id, nombre_completo, correo, telefono, rol_id, activo, creado_en
     )
     SELECT
       n.id, n.nombre_completo, n.correo, n.telefono,
       r.codigo AS rol, n.activo, n.creado_en
     FROM nuevo n
     JOIN rol r ON r.id = n.rol_id`,
    [nombreCompleto, correo.toLowerCase(), passwordHash, telefono || null],
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
