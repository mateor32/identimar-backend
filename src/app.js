const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const catalogosRoutes = require('./routes/catalogos.routes');
const observacionesRoutes = require('./routes/observaciones.routes');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Healthcheck sencillo para Render.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Rutas versionadas bajo /api/v1
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/catalogos', catalogosRoutes);
  app.use('/api/v1/observaciones', observacionesRoutes);

  // 404 y manejo global de errores siempre al final.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = createApp();
module.exports.createApp = createApp;
