// Utilidades compartidas por SQLite y Firestore.
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const COLORES = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16', '#f97316', '#14b8a6'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function http(status, message) {
  return new HttpError(status, message);
}

function generarCodigo() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += ALFABETO[bytes[i] % ALFABETO.length];
  return s;
}

function ahora() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function publicar(usuario, clase) {
  return {
    id: usuario.id,
    nombre: usuario.nombre,
    color: usuario.color,
    clase_id: clase.id,
    es_creador: clase.creador_id === usuario.id,
    clase: { id: clase.id, nombre: clase.nombre, codigo: clase.codigo },
  };
}

module.exports = { ALFABETO, COLORES, HttpError, http, generarCodigo, ahora, publicar };
