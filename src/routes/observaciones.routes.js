const { Router } = require('express');

const observacionesController = require('../controllers/observaciones.controller');
const { requireAuth, requireRole } = require('../middlewares/auth.middleware');
const { uploadImagenUnica } = require('../middlewares/upload.middleware');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = Router();

// POST /api/v1/observaciones
// multipart/form-data: campo "datos" (JSON) + campo "imagen" (binario).
router.post('/', requireAuth, uploadImagenUnica, wrap(observacionesController.crear));

// GET /api/v1/observaciones?estado=&pagina=&tamano=
router.get('/', requireAuth, wrap(observacionesController.listar));

// GET /api/v1/observaciones/pendientes  (cola para expertos y admins)
// Debe registrarse ANTES de /:id para que no sea tratada como un id.
router.get(
  '/pendientes',
  requireAuth,
  requireRole('experto', 'administrador'),
  wrap(observacionesController.pendientes),
);

// GET /api/v1/observaciones/:id
router.get('/:id', requireAuth, wrap(observacionesController.detalle));

// POST /api/v1/observaciones/:id/validacion
router.post(
  '/:id/validacion',
  requireAuth,
  requireRole('experto', 'administrador'),
  wrap(observacionesController.registrarValidacion),
);

module.exports = router;
