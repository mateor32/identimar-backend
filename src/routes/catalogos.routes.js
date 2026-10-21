const { Router } = require('express');

const catalogosController = require('../controllers/catalogos.controller');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = Router();

// Rutas públicas: la app las consume para armar formularios y selects.
router.get('/especies', wrap(catalogosController.getEspecies));
router.get('/familias', wrap(catalogosController.getFamilias));
router.get('/tipos-ambiente', wrap(catalogosController.getTiposAmbiente));
router.get('/condiciones-organismo', wrap(catalogosController.getCondicionesOrganismo));
router.get('/estados', wrap(catalogosController.getEstados));

module.exports = router;
