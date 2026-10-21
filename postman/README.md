# Postman — IdentiMar Backend API v1.0

Colección oficial de Postman del backend de **IdentiMar** (Equipo 3, Proyecto Integrador I, Universidad de Antioquia). Es el entregable del **hito A de la Etapa 2** para los equipos de aplicación móvil (Equipo 1) y de visión artificial (Equipo 2).

| Archivo | Qué es |
|---|---|
| [identimar.postman_collection.json](identimar.postman_collection.json) | Colección v2.1 con las 5 carpetas (`Salud`, `Autenticación`, `Catálogos`, `Observaciones`, `Validación experta`), ejemplos y scripts de tests. |
| [identimar.postman_environment.json](identimar.postman_environment.json) | Environment `IdentiMar - Local` con `baseUrl`, `hostUrl`, `accessToken`, `refreshToken`, `userId`, `observacionId` y `especieCodigo`. |

## Importar en Postman (3 pasos)

1. En Postman: **File → Import** y arrastra los dos JSON (`identimar.postman_collection.json` y `identimar.postman_environment.json`).
2. En la esquina superior derecha, selecciona el environment **"IdentiMar - Local"**.
3. Levanta el backend con `npm run dev` (o cambia `baseUrl` y `hostUrl` a la URL de Render) y lanza los requests en el orden recomendado.

## Flujo recomendado

Los scripts de la pestaña **Tests** capturan tokens e IDs automáticamente — no hay que copiar nada a mano:

1. **01 · Autenticación → Registro** — crea `ana.torres@ejemplo.co` con password `MiClave2026!`.
2. **01 · Autenticación → Login** — guarda `accessToken`, `refreshToken` y `userId`.
3. **03 · Observaciones → Crear** — adjunta una JPEG/PNG en el campo `imagen`; guarda `observacionId`.
4. (Como experto o admin) **04 · Validación experta → Registrar validación** — prueba las tres decisiones: `confirmada`, `corregida`, `rechazada`.
5. **03 · Observaciones → Detalle** — revisa la observación con la validación aplicada.

## Variables del environment

| Variable | Para qué sirve | Cómo se puebla |
|---|---|---|
| `baseUrl` | URL base de la API (`http://localhost:3000/api/v1`). | Editable; cámbiala por la URL de Render para probar en producción. |
| `hostUrl` | URL raíz del servidor, sin `/api/v1` — solo la usa `GET /health`. | Editable. |
| `accessToken` | Header `Authorization: Bearer` heredado por toda la colección. | Automático en **Login** y **Refresh**. |
| `refreshToken` | Body de **Refresh**. | Automático en **Login**. |
| `userId` | ID del usuario autenticado. | Automático en **Login**. |
| `observacionId` | Path de **Detalle** y **Registrar validación**. | Automático al **crear** una observación. |
| `especieCodigo` | Código de especie usado en el ejemplo de validación. | Valor por defecto `URO_MICR`; cámbialo si tu BD tiene otros. |

## Autenticación

- Auth global de la colección: **Bearer `{{accessToken}}`**.
- Carpetas públicas (sobrescriben a `No Auth`): `00 · Salud`, `01 · Autenticación` (excepto `GET /auth/perfil`) y `02 · Catálogos`.
- Resto: hereda el bearer global.

## Notas sobre roles

- **Registro** siempre crea un usuario con rol `usuario`.
- Para probar `GET /observaciones/pendientes` y `POST /observaciones/:id/validacion`, actualiza el rol en la BD:

  ```sql
  UPDATE usuario
  SET rol_id = (SELECT id FROM rol WHERE codigo = 'experto')
  WHERE correo = 'ana.torres@ejemplo.co';
  -- también sirve 'administrador'
  ```

- Después haz **Login** de nuevo para que el nuevo rol quede en el payload del JWT.

## Códigos de error (consistentes en todas las rutas)

| Status | `codigo` | Significado |
|---|---|---|
| 400 | `VALIDACION` | Payload inválido o conflicto semántico de entrada. |
| 401 | `NO_AUTENTICADO` | Falta token, token expirado o credenciales malas. |
| 403 | `SIN_PERMISO` | Autenticado pero sin rol para esta ruta. |
| 404 | `NO_ENCONTRADO` | Recurso o ruta inexistente. |
| 409 | `CONFLICTO` | Estado actual del recurso incompatible con la operación. |
| 500 | `ERROR_INTERNO` | Fallo inesperado del servidor. |

## Nombres de campo (contrato real del backend)

Para que los requests funcionen **sin editar nada**, la colección usa los nombres de campo que el backend valida con Zod:

| En la colección | Para qué sirve |
|---|---|
| `nombre_completo` | Nombre completo del usuario (registro). |
| `telefono` | Teléfono del usuario (opcional, registro). |
| `tipo_ambiente_codigo` | Código del tipo de ambiente (ver `GET /catalogos/tipos-ambiente`). |
| `condicion_organismo_codigo` | Código de la condición del organismo (ver `GET /catalogos/condiciones-organismo`). |
| `observaciones_usuario` | Texto libre con las notas del observador. |
| `precision_gps_metros` | Precisión del GPS en metros (opcional). |
| `especie_aceptada_id` | UUID de la especie sugerida por el usuario (opcional). El experto puede cambiarla al validar. |

Roles reconocidos en la tabla `rol`: `usuario`, `experto`, `administrador` (no `admin`).
