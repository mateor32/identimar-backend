// Clases de error de la API. Los mensajes (al usuario) van en español.

class ApiError extends Error {
  constructor(status, codigo, mensaje, detalles) {
    super(mensaje);
    this.name = this.constructor.name;
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

class ValidacionError extends ApiError {
  constructor(mensaje = 'Datos inválidos', detalles) {
    super(400, 'VALIDACION', mensaje, detalles);
  }
}

class NoAutenticadoError extends ApiError {
  constructor(mensaje = 'No autenticado') {
    super(401, 'NO_AUTENTICADO', mensaje);
  }
}

class SinPermisoError extends ApiError {
  constructor(mensaje = 'No tienes permiso para realizar esta acción') {
    super(403, 'SIN_PERMISO', mensaje);
  }
}

class NoEncontradoError extends ApiError {
  constructor(mensaje = 'Recurso no encontrado') {
    super(404, 'NO_ENCONTRADO', mensaje);
  }
}

class ConflictoError extends ApiError {
  constructor(mensaje = 'Conflicto con el estado actual del recurso') {
    super(409, 'CONFLICTO', mensaje);
  }
}

module.exports = {
  ApiError,
  ValidacionError,
  NoAutenticadoError,
  SinPermisoError,
  NoEncontradoError,
  ConflictoError,
};
