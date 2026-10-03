// Almacén SQLite. Misma forma de datos que ve la API (ids numéricos).
const crypto = require('crypto');
const db = require('../db');
const { COLORES, http, publicar, ahora } = require('./comun');

function sesionDe(usuarioId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sesiones (token, usuario_id) VALUES (?, ?)').run(token, usuarioId);
  return token;
}

function filaUsuario(token) {
  return db.prepare(`SELECT u.id, u.nombre, u.color, u.clase_id,
      c.nombre AS clase_nombre, c.codigo AS clase_codigo, c.creador_id
    FROM sesiones s
    JOIN usuarios u ON u.id = s.usuario_id
    JOIN clases c ON c.id = u.clase_id
    WHERE s.token = ?`).get(token);
}

function desdeFila(row) {
  if (!row) return null;
  return publicar(
    { id: row.id, nombre: row.nombre, color: row.color },
    { id: row.clase_id, nombre: row.clase_nombre, codigo: row.clase_codigo, creador_id: row.creador_id }
  );
}

function insertarClase(nombre) {
  for (let i = 0; i < 8; i++) {
    const codigo = db.generarCodigo();
    try {
      const id = db.prepare('INSERT INTO clases (nombre, codigo) VALUES (?, ?)').run(nombre, codigo).lastInsertRowid;
      return { id, codigo };
    } catch (e) {
      if (!/UNIQUE/i.test(String(e.message))) throw e;
    }
  }
  throw new Error('No se pudo generar un código. Intenta de nuevo.');
}

function asegurarUsuario(claseId, nombre) {
  let row = db.prepare('SELECT id, nombre, color FROM usuarios WHERE clase_id = ? AND nombre = ? COLLATE NOCASE').get(claseId, nombre);
  let nuevo = false;
  if (!row) {
    const n = db.prepare('SELECT COUNT(*) c FROM usuarios WHERE clase_id = ?').get(claseId).c;
    const color = COLORES[n % COLORES.length];
    const info = db.prepare('INSERT INTO usuarios (clase_id, nombre, color) VALUES (?, ?, ?)').run(claseId, nombre, color);
    row = { id: info.lastInsertRowid, nombre, color };
    nuevo = true;
  }
  return { id: row.id, nombre: row.nombre, color: row.color, nuevo };
}

function clasePorId(id) {
  return db.prepare('SELECT * FROM clases WHERE id = ?').get(id);
}

function totalUsuarios(claseId) {
  return db.prepare('SELECT COUNT(*) c FROM usuarios WHERE clase_id = ?').get(claseId).c;
}

function estadosDeTarea(tareaId, claseId) {
  return db.prepare(`SELECT e.usuario_id, u.nombre, u.color, e.hecho, e.ayuda, e.actualizado
    FROM estados e JOIN usuarios u ON u.id = e.usuario_id
    WHERE e.tarea_id = ? AND u.clase_id = ? AND (e.hecho = 1 OR e.ayuda = 1)
    ORDER BY e.actualizado`).all(tareaId, claseId);
}

function tareaCompleta(id, claseId) {
  const t = db.prepare(`SELECT t.*, m.nombre AS materia_nombre, m.color AS materia_color, m.clase_id, u.nombre AS creador,
      (SELECT COUNT(*) FROM mensajes x WHERE x.tarea_id = t.id AND x.clase_id = m.clase_id) AS num_mensajes
    FROM tareas t JOIN materias m ON m.id = t.materia_id
    LEFT JOIN usuarios u ON u.id = t.creado_por
    WHERE t.id = ? AND m.clase_id = ?`).get(id, claseId);
  if (!t) return null;
  const est = estadosDeTarea(id, claseId);
  t.hechos = est.filter(e => e.hecho).map(({ usuario_id, nombre, color }) => ({ usuario_id, nombre, color }));
  t.ayuda = est.filter(e => e.ayuda).map(({ usuario_id, nombre, color }) => ({ usuario_id, nombre, color }));
  t.total_estudiantes = totalUsuarios(claseId);
  return t;
}

function abrir() {
  return {
    driver: 'sqlite',

    async crearClase({ nombreClase, nombreUsuario }) {
      return db.transaction(() => {
        const clase = insertarClase(nombreClase);
        const usuario = asegurarUsuario(clase.id, nombreUsuario);
        db.prepare('UPDATE clases SET creador_id = ? WHERE id = ?').run(usuario.id, clase.id);
        const token = sesionDe(usuario.id);
        const pub = desdeFila(filaUsuario(token));
        return { token, usuario: pub, clase: pub.clase };
      })();
    },

    async unirse({ codigo, nombre }) {
      const clase = db.prepare('SELECT * FROM clases WHERE codigo = ? COLLATE NOCASE').get(codigo);
      if (!clase) return null;
      return db.transaction(() => {
        const usuario = asegurarUsuario(clase.id, nombre);
        const token = sesionDe(usuario.id);
        const pub = desdeFila(filaUsuario(token));
        return { token, usuario: pub, clase: pub.clase, nuevo: usuario.nuevo };
      })();
    },

    async usuarioPorToken(token) {
      if (!token) return null;
      return desdeFila(filaUsuario(token));
    },

    async cerrarSesion(token) {
      db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
    },

    async listarUsuarios(claseId) {
      return db.prepare('SELECT id, nombre, color FROM usuarios WHERE clase_id = ? ORDER BY nombre COLLATE NOCASE').all(claseId);
    },

    async actualizarClase(claseId, usuarioId, { nombre, regenerar }) {
      const c = clasePorId(claseId);
      if (!c || c.creador_id !== usuarioId) throw http(403, 'Solo quien creó la clase puede cambiarla.');
      let codigo = c.codigo;
      const nuevoNombre = nombre == null ? c.nombre : nombre;
      db.transaction(() => {
        if (regenerar) {
          let listo = false;
          for (let i = 0; i < 8; i++) {
            const cand = db.generarCodigo();
            try {
              db.prepare('UPDATE clases SET codigo = ? WHERE id = ?').run(cand, c.id);
              codigo = cand;
              listo = true;
              break;
            } catch (e) {
              if (!/UNIQUE/i.test(String(e.message))) throw e;
            }
          }
          if (!listo) throw new Error('No se pudo generar un código. Intenta de nuevo.');
        }
        db.prepare('UPDATE clases SET nombre = ? WHERE id = ?').run(nuevoNombre, c.id);
      })();
      return { id: c.id, nombre: nuevoNombre, codigo };
    },

    async listarMaterias(claseId, usuarioId) {
      return db.prepare(`
        SELECT m.*, u.nombre AS creador,
          (SELECT COUNT(*) FROM tareas t WHERE t.materia_id = m.id) AS total_tareas,
          (SELECT COUNT(*) FROM tareas t JOIN estados e ON e.tarea_id = t.id AND e.usuario_id = ? AND e.hecho = 1 WHERE t.materia_id = m.id) AS mis_hechas,
          (SELECT COUNT(*) FROM tareas t JOIN estados e ON e.tarea_id = t.id AND e.ayuda = 1 WHERE t.materia_id = m.id) AS pedidos_ayuda
        FROM materias m LEFT JOIN usuarios u ON u.id = m.creado_por
        WHERE m.clase_id = ?
        ORDER BY m.nombre COLLATE NOCASE`).all(usuarioId, claseId);
    },

    async crearMateria(claseId, usuarioId, { nombre, docente, color }) {
      const info = db.prepare('INSERT INTO materias (clase_id, nombre, docente, color, creado_por) VALUES (?, ?, ?, ?, ?)')
        .run(claseId, nombre, docente, color, usuarioId);
      return db.prepare('SELECT * FROM materias WHERE id = ? AND clase_id = ?').get(info.lastInsertRowid, claseId);
    },

    async actualizarMateria(claseId, materiaId, { nombre, docente, color }) {
      const m = db.prepare('SELECT * FROM materias WHERE id = ? AND clase_id = ?').get(materiaId, claseId);
      if (!m) return null;
      db.prepare('UPDATE materias SET nombre = ?, docente = ?, color = ? WHERE id = ? AND clase_id = ?')
        .run(nombre, docente, color, m.id, m.clase_id);
      return db.prepare('SELECT * FROM materias WHERE id = ?').get(m.id);
    },

    async eliminarMateria(claseId, materiaId) {
      const m = db.prepare('SELECT id FROM materias WHERE id = ? AND clase_id = ?').get(materiaId, claseId);
      if (!m) return false;
      db.prepare('DELETE FROM materias WHERE id = ? AND clase_id = ?').run(m.id, claseId);
      return true;
    },

    async obtenerMateria(claseId, materiaId) {
      const m = db.prepare('SELECT * FROM materias WHERE id = ? AND clase_id = ?').get(materiaId, claseId);
      if (!m) return null;
      const ids = db.prepare(`SELECT id FROM tareas WHERE materia_id = ?
        ORDER BY CASE WHEN fecha_entrega IS NULL OR fecha_entrega = '' THEN 1 ELSE 0 END, fecha_entrega, id`).all(m.id);
      m.tareas = ids.map(r => tareaCompleta(r.id, claseId));
      return m;
    },

    async listarTareas(claseId) {
      const ids = db.prepare(`SELECT t.id FROM tareas t JOIN materias m ON m.id = t.materia_id
        WHERE m.clase_id = ?
        ORDER BY CASE WHEN t.fecha_entrega IS NULL OR t.fecha_entrega = '' THEN 1 ELSE 0 END, t.fecha_entrega, t.id`).all(claseId);
      return ids.map(r => tareaCompleta(r.id, claseId));
    },

    async obtenerTarea(claseId, tareaId) {
      return tareaCompleta(tareaId, claseId);
    },

    async crearTarea(claseId, materiaId, usuarioId, { titulo, descripcion, fecha }) {
      const m = db.prepare('SELECT id, clase_id FROM materias WHERE id = ? AND clase_id = ?').get(materiaId, claseId);
      if (!m) return null;
      const info = db.prepare('INSERT INTO tareas (materia_id, titulo, descripcion, fecha_entrega, creado_por) VALUES (?, ?, ?, ?, ?)')
        .run(m.id, titulo, descripcion, fecha || null, usuarioId);
      return tareaCompleta(info.lastInsertRowid, claseId);
    },

    async actualizarTarea(claseId, tareaId, { titulo, descripcion, fecha }) {
      const t = db.prepare(`SELECT t.* FROM tareas t JOIN materias m ON m.id = t.materia_id
        WHERE t.id = ? AND m.clase_id = ?`).get(tareaId, claseId);
      if (!t) return null;
      db.prepare('UPDATE tareas SET titulo = ?, descripcion = ?, fecha_entrega = ? WHERE id = ?')
        .run(titulo, descripcion, fecha || null, t.id);
      return tareaCompleta(t.id, claseId);
    },

    async eliminarTarea(claseId, tareaId) {
      const t = db.prepare(`SELECT t.id, t.materia_id FROM tareas t JOIN materias m ON m.id = t.materia_id
        WHERE t.id = ? AND m.clase_id = ?`).get(tareaId, claseId);
      if (!t) return null;
      db.prepare('DELETE FROM tareas WHERE id = ?').run(t.id);
      return { id: t.id, materia_id: t.materia_id };
    },

    async marcarEstado(claseId, tareaId, usuarioId, body) {
      const t = db.prepare(`SELECT t.id FROM tareas t JOIN materias m ON m.id = t.materia_id
        WHERE t.id = ? AND m.clase_id = ?`).get(tareaId, claseId);
      if (!t) return null;
      const prev = db.prepare('SELECT hecho, ayuda FROM estados WHERE tarea_id = ? AND usuario_id = ?').get(t.id, usuarioId) || { hecho: 0, ayuda: 0 };
      let hecho = body.hecho === undefined ? prev.hecho : (body.hecho ? 1 : 0);
      let ayuda = body.ayuda === undefined ? prev.ayuda : (body.ayuda ? 1 : 0);
      if (body.hecho && hecho) ayuda = 0;
      db.prepare(`INSERT INTO estados (tarea_id, usuario_id, hecho, ayuda, actualizado) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tarea_id, usuario_id) DO UPDATE SET hecho = excluded.hecho, ayuda = excluded.ayuda, actualizado = excluded.actualizado`)
        .run(t.id, usuarioId, hecho, ayuda, ahora());
      return tareaCompleta(t.id, claseId);
    },

    async listarMensajes(claseId, tareaId) {
      const sql = `SELECT x.id, x.tarea_id, x.texto, x.creado, x.clase_id, u.id AS usuario_id, u.nombre, u.color
        FROM mensajes x JOIN usuarios u ON u.id = x.usuario_id`;
      if (tareaId) {
        const existe = db.prepare(`SELECT t.id FROM tareas t JOIN materias m ON m.id = t.materia_id
          WHERE t.id = ? AND m.clase_id = ?`).get(tareaId, claseId);
        if (!existe) throw http(404, 'Tarea no encontrada.');
        return db.prepare(`${sql} WHERE x.clase_id = ? AND x.tarea_id = ? ORDER BY x.id DESC LIMIT 200`).all(claseId, tareaId).reverse();
      }
      return db.prepare(`${sql} WHERE x.clase_id = ? AND x.tarea_id IS NULL ORDER BY x.id DESC LIMIT 200`).all(claseId).reverse();
    },

    async crearMensaje(usuario, tareaId, texto) {
      if (tareaId) {
        const t = db.prepare(`SELECT t.id FROM tareas t JOIN materias m ON m.id = t.materia_id
          WHERE t.id = ? AND m.clase_id = ?`).get(tareaId, usuario.clase_id);
        if (!t) throw http(404, 'Tarea no encontrada.');
      }
      const info = db.prepare('INSERT INTO mensajes (clase_id, tarea_id, usuario_id, texto, creado) VALUES (?, ?, ?, ?, ?)')
        .run(usuario.clase_id, tareaId || null, usuario.id, texto, ahora());
      return db.prepare(`SELECT x.id, x.tarea_id, x.texto, x.creado, x.clase_id, u.id AS usuario_id, u.nombre, u.color
        FROM mensajes x JOIN usuarios u ON u.id = x.usuario_id WHERE x.id = ?`).get(info.lastInsertRowid);
    },
  };
}

module.exports = { abrir };
