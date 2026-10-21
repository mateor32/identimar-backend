const { Router } = require('express');

const authController = require('../controllers/auth.controller');
const { requireAuth } = require('../middlewares/auth.middleware');

// Pequeño wrapper para que los errores lanzados en handlers async
// terminen en el errorHandler global sin tener try/catch en cada uno.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = Router();

router.post('/registro', wrap(authController.registro));
router.post('/login', wrap(authController.login));
router.post('/refresh', wrap(authController.refresh));
router.get('/perfil', requireAuth, wrap(authController.perfil));

module.exports = router;
