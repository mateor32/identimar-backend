const multer = require('multer');
const { ApiError } = require('../utils/errors');

// 404 para rutas inexistentes.
function notFoundHandler(req, res) {
  res.status(404).json({ error: { codigo: 'NO_ENCONTRADO', mensaje: 'Ruta no encontrada' } });
}

// Mapea errores de Multer a mensajes legibles en español.
function mensajeMulter(err) {
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return 'La imagen excede el tamaño máximo permitido (10 MB)';
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return 'Solo se admite un archivo en el campo "imagen"';
    case 'LIMIT_PART_COUNT':
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_FIELD_KEY':
    case 'LIMIT_FIELD_VALUE':
      return 'La petición multipart excede los límites permitidos';
    default:
      return 'No se pudo procesar el archivo subido';
  }
}

// LIMIT_FILE_SIZE merece 413 Payload Too Large (semántica HTTP correcta);
// el resto de errores multer son violaciones de contrato del request → 400.
function statusMulter(err) {
  return err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
}

function codigoMulter(err) {
  return err.code === 'LIMIT_FILE_SIZE' ? 'ARCHIVO_DEMASIADO_GRANDE' : 'VALIDACION';
}

// Manejador global de errores: convierte ApiError en respuesta JSON.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { codigo: err.codigo, mensaje: err.message, detalles: err.detalles },
    });
  }

  if (err instanceof multer.MulterError) {
    return res
      .status(statusMulter(err))
      .json({ error: { codigo: codigoMulter(err), mensaje: mensajeMulter(err) } });
  }

  // JSON mal formado en el body
  if (err.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: { codigo: 'VALIDACION', mensaje: 'El cuerpo de la petición no es JSON válido' } });
  }

  console.error(err);
  return res
    .status(500)
    .json({ error: { codigo: 'ERROR_INTERNO', mensaje: 'Error interno del servidor' } });
}

module.exports = { errorHandler, notFoundHandler };
