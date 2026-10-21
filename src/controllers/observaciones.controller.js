const crypto = require('crypto');
const { z } = require('zod');
const imageSize = require('image-size');

const observacionesService = require('../services/observaciones.service');
const validacionesService = require('../services/validaciones.service');
const supabase = require('../config/supabase');
const { ValidacionError, SinPermisoError, NoEncontradoError } = require('../utils/errors');

// TTL de la URL firmada que se devuelve en el detalle.
const SIGNED_URL_SEGUNDOS = 60 * 60;
const TAMANO_DEFECTO = 20;
const TAMANO_MAX = 100;

// ---- Schema Zod ------------------------------------------------------------

const crearObservacionSchema = z.object({
  latitud: z
    .number({ invalid_type_error: 'latitud debe ser número' })
    .min(-90, 'latitud debe estar entre -90 y 90')
    .max(90, 'latitud debe estar entre -90 y 90'),
  longitud: z
    .number({ invalid_type_error: 'longitud debe ser número' })
    .min(-180, 'longitud debe estar entre -180 y 180')
    .max(180, 'longitud debe estar entre -180 y 180'),
  fecha_hora_evento: z
    .string()
    .datetime({ offset: true, message: 'fecha_hora_evento debe ser ISO-8601 (eventDate)' }),
  tipo_ambiente_codigo: z.string().trim().min(1, 'tipo_ambiente_codigo es obligatorio'),
  condicion_organismo_codigo: z.string().trim().min(1, 'condicion_organismo_codigo es obligatorio'),
  especie_id: z.string().uuid('especie_id debe ser un UUID').optional(),
  notas: z.string().max(1000, 'notas no puede exceder 1000 caracteres').optional(),
});

function parsear(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detalles = result.error.issues.map((i) => ({
      campo: i.path.join('.') || '(raíz)',
      mensaje: i.message,
    }));
    throw new ValidacionError('Datos inválidos', detalles);
  }
  return result.data;
}

/**
 * Parsea el campo `datos` del multipart. Viene como JSON stringificado.
 */
function parsearDatos(raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw new ValidacionError('El campo "datos" es obligatorio');
  }
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new ValidacionError('El campo "datos" no es JSON válido');
  }
}

/**
 * Mide dimensiones de la imagen desde el header (image-size, pure JS).
 */
function medirImagen(buffer) {
  try {
    const dim = imageSize(buffer);
    if (!dim || !dim.width || !dim.height) {
      throw new Error('dimensiones vacías');
    }
    return { width: dim.width, height: dim.height };
  } catch {
    throw new ValidacionError('La imagen no es un JPEG/PNG válido o está corrupta');
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ---- Handler ---------------------------------------------------------------

/**
 * POST /api/v1/observaciones
 * multipart/form-data:
 *   - datos:   JSON string con los campos de la observación
 *   - imagen:  binario (JPEG/PNG, <= 10 MB)
 */
async function crear(req, res) {
  if (!req.file) {
    throw new ValidacionError('La imagen es obligatoria', [
      { campo: 'imagen', mensaje: 'Debes adjuntar una imagen JPEG o PNG' },
    ]);
  }

  const datos = parsear(crearObservacionSchema, parsearDatos(req.body.datos));

  const { width, height } = medirImagen(req.file.buffer);
  const checksum = sha256(req.file.buffer);

  const resultado = await observacionesService.crearObservacion({
    usuario: { id: req.usuario.id },
    datos,
    imagen: {
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      size: req.file.size,
      width,
      height,
      checksum,
    },
  });

  res.status(201).json(resultado);
}

// ---- Listado ---------------------------------------------------------------

// Query params aceptados por GET /observaciones. `coerce` convierte strings a
// números porque los querystrings siempre llegan como texto.
const listarQuerySchema = z.object({
  estado: z.string().trim().min(1).optional(),
  pagina: z.coerce.number().int().min(1).default(1),
  tamano: z.coerce
    .number()
    .int()
    .min(1)
    .max(TAMANO_MAX, `tamano no puede exceder ${TAMANO_MAX}`)
    .default(TAMANO_DEFECTO),
});

async function listar(req, res) {
  const { estado, pagina, tamano } = parsear(listarQuerySchema, req.query);

  // Un admin ve todo; cualquier otro rol ve solo lo suyo.
  const filtroUsuarioId = req.usuario.rol === 'admin' ? null : req.usuario.id;

  const resultado = await observacionesService.listarObservaciones({
    filtroUsuarioId,
    estadoNombre: estado || null,
    pagina,
    tamano,
  });

  res.json(resultado);
}

// ---- Detalle ---------------------------------------------------------------

async function detalle(req, res) {
  const { id } = req.params;

  const completa = await observacionesService.obtenerObservacionCompleta(id);
  if (!completa) {
    throw new NoEncontradoError('Observación no encontrada');
  }

  // Autorización: 'usuario' solo ve lo suyo; 'experto' y 'admin' pueden ver todo.
  const esAutor = completa.observacion.usuario_id === req.usuario.id;
  const tieneAccesoAmplio = ['experto', 'admin'].includes(req.usuario.rol);
  if (!esAutor && !tieneAccesoAmplio) {
    throw new SinPermisoError('No puedes acceder a esta observación');
  }

  // Firmar URL de la imagen (si existe) para que el cliente pueda verla.
  let imagen = null;
  if (completa.imagen) {
    const urlFirmada = await supabase.getSignedUrl(completa.imagen.url_storage, SIGNED_URL_SEGUNDOS);
    imagen = { ...completa.imagen, url_firmada: urlFirmada, url_expira_en: SIGNED_URL_SEGUNDOS };
  }

  // No exponemos usuario_id en la raíz: ya va embebido en el objeto `usuario`.
  const { usuario_id: _omit, ...observacion } = completa.observacion;

  res.json({
    ...observacion,
    imagen,
    prediccion: completa.prediccion,
    validacion: completa.validacion,
    historial: completa.historial,
  });
}

// ---- Cola de pendientes ----------------------------------------------------

const pendientesQuerySchema = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  tamano: z.coerce
    .number()
    .int()
    .min(1)
    .max(TAMANO_MAX, `tamano no puede exceder ${TAMANO_MAX}`)
    .default(TAMANO_DEFECTO),
});

async function pendientes(req, res) {
  const { pagina, tamano } = parsear(pendientesQuerySchema, req.query);
  const resultado = await observacionesService.listarPendientes({ pagina, tamano });
  res.json(resultado);
}

// ---- Validación experta ----------------------------------------------------

const registrarValidacionSchema = z
  .object({
    decision: z.enum(['confirmada', 'corregida', 'rechazada'], {
      errorMap: () => ({ mensaje: 'decision debe ser confirmada, corregida o rechazada' }),
    }),
    especie_final_codigo: z.string().trim().min(1).optional(),
    comentario: z.string().max(1000, 'comentario no puede exceder 1000 caracteres').optional(),
  })
  .refine(
    (data) => data.decision !== 'corregida' || !!data.especie_final_codigo,
    {
      message: 'especie_final_codigo es obligatorio cuando decision = "corregida"',
      path: ['especie_final_codigo'],
    },
  );

async function registrarValidacion(req, res) {
  const datos = parsear(registrarValidacionSchema, req.body);

  const resultado = await validacionesService.registrarValidacion({
    observacionId: req.params.id,
    experto: { id: req.usuario.id },
    decision: datos.decision,
    especieFinalCodigo: datos.especie_final_codigo,
    comentario: datos.comentario,
  });

  res.status(201).json(resultado);
}

module.exports = {
  crear,
  listar,
  detalle,
  pendientes,
  registrarValidacion,
  crearObservacionSchema,
  listarQuerySchema,
  pendientesQuerySchema,
  registrarValidacionSchema,
};
