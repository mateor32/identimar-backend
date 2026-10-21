const catalogosService = require('../services/catalogos.service');

// Caché en memoria por catálogo. Los catálogos cambian muy poco, así que
// 5 minutos es un compromiso razonable entre frescura y carga a la BD.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // clave -> { expira: number, datos: any[] }

async function cachear(clave, fn) {
  const ahora = Date.now();
  const entrada = cache.get(clave);
  if (entrada && entrada.expira > ahora) {
    return entrada.datos;
  }
  const datos = await fn();
  cache.set(clave, { expira: ahora + TTL_MS, datos });
  return datos;
}

// Útil para tests y para una futura ruta admin de invalidación.
function __resetCache() {
  cache.clear();
}

/**
 * Cada handler devuelve un array JSON directo (sin wrapper { data, meta }),
 * tal como pide el contrato.
 */
async function getEspecies(_req, res) {
  const datos = await cachear('especies', catalogosService.listarEspecies);
  res.json(datos);
}

async function getFamilias(_req, res) {
  const datos = await cachear('familias', catalogosService.listarFamilias);
  res.json(datos);
}

async function getTiposAmbiente(_req, res) {
  const datos = await cachear('tipos-ambiente', catalogosService.listarTiposAmbiente);
  res.json(datos);
}

async function getCondicionesOrganismo(_req, res) {
  const datos = await cachear('condiciones-organismo', catalogosService.listarCondicionesOrganismo);
  res.json(datos);
}

async function getEstados(_req, res) {
  const datos = await cachear('estados', catalogosService.listarEstados);
  res.json(datos);
}

module.exports = {
  getEspecies,
  getFamilias,
  getTiposAmbiente,
  getCondicionesOrganismo,
  getEstados,
  __resetCache,
  TTL_MS,
};
