const path = require('path');
const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');

const authRoutes = require('./routes/auth.routes');
const catalogosRoutes = require('./routes/catalogos.routes');
const observacionesRoutes = require('./routes/observaciones.routes');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');

const openapiDocument = YAML.load(path.join(__dirname, 'docs', 'openapi.yaml'));

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Healthcheck sencillo para Render.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Documentación OpenAPI (Swagger UI en /api/docs, JSON en /api/docs.json).
  app.get('/api/docs.json', (_req, res) => res.json(openapiDocument));
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openapiDocument, {
      customSiteTitle: 'IdentiMar API — Docs',
      swaggerOptions: { persistAuthorization: true },
    }),
  );

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
