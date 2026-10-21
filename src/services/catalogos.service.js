const { query } = require('../config/database');

/**
 * Lista especies con la familia embebida.
 * Si en el schema real alguna columna tiene otro nombre, ajústalo aquí
 * (solo este archivo toca la BD de catálogos).
 */
async function listarEspecies() {
  const { rows } = await query(
    `SELECT
       e.id,
       e.codigo,
       e.nombre_cientifico,
       e.nombre_comun,
       e.grupo,
       e.descripcion,
       e.url_imagen_referencia,
       json_build_object(
         'id', f.id,
         'nombre_cientifico', f.nombre_cientifico
       ) AS familia
     FROM especie e
     JOIN familia f ON f.id = e.familia_id
     ORDER BY e.nombre_cientifico ASC`,
  );
  return rows;
}

async function listarFamilias() {
  const { rows } = await query(
    `SELECT id, nombre_cientifico, descripcion
     FROM familia
     ORDER BY nombre_cientifico ASC`,
  );
  return rows;
}

async function listarTiposAmbiente() {
  const { rows } = await query(
    `SELECT id, codigo, nombre_visible, descripcion
     FROM tipo_ambiente
     ORDER BY nombre_visible ASC`,
  );
  return rows;
}

async function listarCondicionesOrganismo() {
  const { rows } = await query(
    `SELECT id, codigo, nombre_visible, descripcion
     FROM condicion_organismo
     ORDER BY nombre_visible ASC`,
  );
  return rows;
}

/**
 * Los estados incluyen `orden` (para graficar la máquina) y `es_terminal`
 * (para que la app sepa cuándo no habrá más transiciones).
 */
async function listarEstados() {
  const { rows } = await query(
    `SELECT id, codigo, nombre_visible, descripcion, orden, es_terminal
     FROM estado_observacion
     ORDER BY orden ASC`,
  );
  return rows;
}

module.exports = {
  listarEspecies,
  listarFamilias,
  listarTiposAmbiente,
  listarCondicionesOrganismo,
  listarEstados,
};
