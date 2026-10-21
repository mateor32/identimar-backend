const multer = require('multer');
const { ValidacionError } = require('../utils/errors');

const MIMES_PERMITIDOS = new Set(['image/jpeg', 'image/png']);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!MIMES_PERMITIDOS.has(file.mimetype)) {
      // Multer swallow-ea el error si pasamos null+false; lo lanzamos para
      // que viaje al errorHandler como ValidacionError.
      return cb(new ValidacionError('Solo se permiten imágenes JPEG o PNG'));
    }
    return cb(null, true);
  },
});

/**
 * Devuelve el formato canónico que la BD acepta en imagen.formato
 * (CHECK IN ('jpeg','png')). También sirve como extensión del archivo
 * en Supabase Storage, para mantener un único identificador.
 */
function extensionDeMime(mimetype) {
  if (mimetype === 'image/jpeg') return 'jpeg';
  if (mimetype === 'image/png') return 'png';
  return 'bin';
}

module.exports = {
  uploadImagenUnica: upload.single('imagen'),
  MAX_BYTES,
  MIMES_PERMITIDOS,
  extensionDeMime,
};
