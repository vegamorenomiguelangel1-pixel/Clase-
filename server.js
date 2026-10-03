// Clase App — servidor (Express + Socket.io + SQLite)
// Varias clases a la vez: cada una tiene su código, sus usuarios y su sala de Socket.io.
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const CREATE_MAX = Number(process.env.RATE_CREATE_MAX || 10);
const JOIN_MAX = Number(process.env.RATE_JOIN_MAX || 60);
const CREATE_WINDOW = Number(process.env.RATE_CREATE_WINDOW_MS || 60 * 60 * 1000);
const JOIN_WINDOW = Number(process.env.RATE_JOIN_WINDOW_MS || 10 * 60 * 1000);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('trust proxy', 1);

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const COLORES = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16', '#f97316', '#14b8a6'];
const limpiar = (s, max = 200) => String(s ?? '').trim().slice(0, max);
const room = id => 'clase:' + id;

const SQL_USUARIO = `SELECT u.id, u.nombre, u.color, u.clase_id,
    c.nombre AS clase_nombre, c.codigo AS clase_codigo,
    CASE WHEN c.creador_id = u.id THEN 1 ELSE 0 END AS es_creador
  FROM sesiones s
  JOIN usuarios u ON u.id = s.usuario_id
  JOIN clases c ON c.id = u.clase_id
  WHERE s.token = ?`;

function publicar(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    color: row.color,
    clase_id: row.clase_id,
    es_creador: !!row.es_creador,
    clase: { id: row.clase_id, nombre: row.clase_nombre, codigo: row.clase_codigo },
  };
}
function usuarioPorToken(token) {
  if (!token) return null;
  return publicar(db.prepare(SQL_USUARIO).get(token));
}
function sesionDe(usuarioId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sesiones (token, usuario_id) VALUES (?, ?)').run(token, usuarioId);
  const usuario = usuarioPorToken(token);
  return { token, usuario, clase: usuario.clase };
}

// ---------- Límite sencillo por IP ----------
const limites = new Map();
function ipDe(req) {
  return req.ip || req.socket?.remoteAddress || 'desconocida';
}
function limitado(tipo, ip, max, ventana) {
  if (limites.size > 20000) {
    const ahora = Date.now();
    for (const [k, v] of limites) if (ahora >= v.reset) limites.delete(k);
  }
  const clave = tipo + ':' + ip;
  const ahora = Date.now();
  let b = limites.get(clave);
  if (!b || ahora >= b.reset) {
    b = { n: 0, reset: ahora + ventana };
    limites.set(clave, b);
  }
  b.n += 1;
  return b.n > max ? b.reset : 0;
}
function frenar(tipo, max, ventana) {
  return (req, res, next) => {
    const hasta = limitado(tipo, ipDe(req), max, ventana);
    if (!hasta) return next();
    const secs = Math.max(1, Math.ceil((hasta - Date.now()) / 1000));
    res.set('Retry-After', String(secs));
    res.status(429).json({ error: `Demasiados intentos. Espera ${secs}s e inténtalo de nuevo.` });
  };
}

function normalizarCodigo(s) {
  return limpiar(s, 40).toUpperCase().replace(/\s+/g, '');
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
  let row = db.prepare('SELECT id FROM usuarios WHERE clase_id = ? AND nombre = ? COLLATE NOCASE').get(claseId, nombre);
  let nuevo = false;
  if (!row) {
    const n = db.prepare('SELECT COUNT(*) c FROM usuarios WHERE clase_id = ?').get(claseId).c;
    const info = db.prepare('INSERT INTO usuarios (clase_id, nombre, color) VALUES (?, ?, ?)').run(claseId, nombre, COLORES[n % COLORES.length]);
    row = { id: info.lastInsertRowid };
    nuevo = true;
  }
  return { id: row.id, nuevo };
}

app.post('/api/clases', frenar('crear', CREATE_MAX, CREATE_WINDOW), (req, res) => {
  const nombre = limpiar(req.body.nombre, 40).replace(/\s+/g, ' ');
  const claseNombre = limpiar(req.body.clase, 80).replace(/\s+/g, ' ');
  if (nombre.length < 2) return res.status(400).json({ error: 'Escribe tu nombre (mínimo 2 letras).' });
  if (claseNombre.length < 2) return res.status(400).json({ error: 'La clase necesita un nombre (mínimo 2 letras).' });
  try {
    const out = db.transaction(() => {
      const clase = insertarClase(claseNombre);
      const usuario = asegurarUsuario(clase.id, nombre);
      db.prepare('UPDATE clases SET creador_id = ? WHERE id = ?').run(usuario.id, clase.id);
      return sesionDe(usuario.id);
    })();
    res.status(201).json(out);
  } catch (e) {
    res.status(400).json({ error: e.message || 'No se pudo crear la clase.' });
  }
});

app.post('/api/login', frenar('unirse', JOIN_MAX, JOIN_WINDOW), (req, res) => {
  const nombre = limpiar(req.body.nombre, 40).replace(/\s+/g, ' ');
  const codigo = normalizarCodigo(req.body.codigo);
  if (nombre.length < 2) return res.status(400).json({ error: 'Escribe tu nombre (mínimo 2 letras).' });
  if (!codigo) return res.status(400).json({ error: 'El código de la clase es obligatorio.' });
  const clase = db.prepare('SELECT * FROM clases WHERE codigo = ? COLLATE NOCASE').get(codigo);
  if (!clase) return res.status(401).json({ error: 'Código de la clase incorrecto.' });
  try {
    const out = db.transaction(() => {
      const usuario = asegurarUsuario(clase.id, nombre);
      const sesion = sesionDe(usuario.id);
      return { ...sesion, nuevo: usuario.nuevo };
    })();
    if (out.nuevo) io.to(room(clase.id)).emit('usuarios:cambio');
    res.json({ token: out.token, usuario: out.usuario, clase: out.clase });
  } catch (e) {
    res.status(400).json({ error: e.message || 'No se pudo entrar.' });
  }
});

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const u = usuarioPorToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!u) return res.status(401).json({ error: 'Sesión no válida. Vuelve a entrar.' });
  req.usuario = u;
  next();
}

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sesiones WHERE token = ?').run(req.headers.authorization.slice(7));
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json(req.usuario));
app.get('/api/usuarios', auth, (req, res) => {
  res.json(db.prepare('SELECT id, nombre, color FROM usuarios WHERE clase_id = ? ORDER BY nombre COLLATE NOCASE').all(req.usuario.clase_id));
});

app.put('/api/clase', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM clases WHERE id = ?').get(req.usuario.clase_id);
  if (!c || c.creador_id !== req.usuario.id) return res.status(403).json({ error: 'Solo quien creó la clase puede cambiarla.' });
  let nombre = c.nombre;
  let codigo = c.codigo;
  if (req.body.nombre !== undefined) {
    nombre = limpiar(req.body.nombre, 80).replace(/\s+/g, ' ');
    if (nombre.length < 2) return res.status(400).json({ error: 'El nombre de la clase es muy corto.' });
  }
  if (req.body.regenerar) {
    try {
      codigo = db.transaction(() => {
        for (let i = 0; i < 8; i++) {
          const nuevo = db.generarCodigo();
          try {
            db.prepare('UPDATE clases SET codigo = ? WHERE id = ?').run(nuevo, c.id);
            return nuevo;
          } catch (e) {
            if (!/UNIQUE/i.test(String(e.message))) throw e;
          }
        }
        throw new Error('No se pudo generar un código. Intenta de nuevo.');
      })();
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  db.prepare('UPDATE clases SET nombre = ? WHERE id = ?').run(nombre, c.id);
  const clase = { id: c.id, nombre, codigo };
  io.to(room(c.id)).emit('clase:cambio', clase);
  res.json(clase);
});

// ---------- Materias ----------
const totalUsuarios = claseId => db.prepare('SELECT COUNT(*) c FROM usuarios WHERE clase_id = ?').get(claseId).c;

app.get('/api/materias', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, u.nombre AS creador,
      (SELECT COUNT(*) FROM tareas t WHERE t.materia_id = m.id) AS total_tareas,
      (SELECT COUNT(*) FROM tareas t JOIN estados e ON e.tarea_id = t.id AND e.usuario_id = ? AND e.hecho = 1 WHERE t.materia_id = m.id) AS mis_hechas,
      (SELECT COUNT(*) FROM tareas t JOIN estados e ON e.tarea_id = t.id AND e.ayuda = 1 WHERE t.materia_id = m.id) AS pedidos_ayuda
    FROM materias m LEFT JOIN usuarios u ON u.id = m.creado_por
    WHERE m.clase_id = ?
    ORDER BY m.nombre COLLATE NOCASE`).all(req.usuario.id, req.usuario.clase_id);
  res.json(rows);
});

app.post('/api/materias', auth, (req, res) => {
  const nombre = limpiar(req.body.nombre, 80);
  if (!nombre) return res.status(400).json({ error: 'La materia necesita un nombre.' });
  const info = db.prepare('INSERT INTO materias (clase_id, nombre, docente, color, creado_por) VALUES (?, ?, ?, ?, ?)')
    .run(req.usuario.clase_id, nombre, limpiar(req.body.docente, 80), limpiar(req.body.color, 9) || '#6366f1', req.usuario.id);
  io.to(room(req.usuario.clase_id)).emit('datos:cambio', { tipo: 'materia', id: info.lastInsertRowid });
  res.status(201).json(db.prepare('SELECT * FROM materias WHERE id = ? AND clase_id = ?').get(info.lastInsertRowid, req.usuario.clase_id));
});

app.put('/api/materias/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM materias WHERE id = ? AND clase_id = ?').get(req.params.id, req.usuario.clase_id);
  if (!m) return res.status(404).json({ error: 'Materia no encontrada.' });
  const nombre = limpiar(req.body.nombre ?? m.nombre, 80);
  if (!nombre) return res.status(400).json({ error: 'La materia necesita un nombre.' });
  db.prepare('UPDATE materias SET nombre = ?, docente = ?, color = ? WHERE id = ? AND clase_id = ?')
    .run(nombre, limpiar(req.body.docente ?? m.docente, 80), limpiar(req.body.color ?? m.color, 9), m.id, m.clase_id);
  io.to(room(m.clase_id)).emit('datos:cambio', { tipo: 'materia', id: m.id });
  res.json(db.prepare('SELECT * FROM materias WHERE id = ?').get(m.id));
});

app.delete('/api/materias/:id', auth, (req, res) => {
  const m = db.prepare('SELECT id, clase_id FROM materias WHERE id = ? AND clase_id = ?').get(req.params.id, req.usuario.clase_id);
  if (!m) return res.status(404).json({ error: 'Materia no encontrada.' });
  db.prepare('DELETE FROM materias WHERE id = ? AND clase_id = ?').run(m.id, m.clase_id);
  io.to(room(m.clase_id)).emit('datos:cambio', { tipo: 'materia', id: m.id, eliminado: true });
  res.json({ ok: true });
});

// ---------- Tareas ----------
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

app.get('/api/materias/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM materias WHERE id = ? AND clase_id = ?').get(req.params.id, req.usuario.clase_id);
  if (!m) return res.status(404).json({ error: 'Materia no encontrada.' });
  const ids = db.prepare(`SELECT t.id FROM tareas t WHERE t.materia_id = ?
    ORDER BY CASE WHEN t.fecha_entrega IS NULL OR t.fecha_entrega = '' THEN 1 ELSE 0 END, t.fecha_entrega, t.id`).all(m.id);
  m.tareas = ids.map(r => tareaCompleta(r.id, req.usuario.clase_id));
  res.json(m);
});

app.get('/api/tareas', auth, (req, res) => {
  const ids = db.prepare(`SELECT t.id FROM tareas t JOIN materias m ON m.id = t.materia_id
    WHERE m.clase_id = ?
    ORDER BY CASE WHEN t.fecha_entrega IS NULL OR t.fecha_entrega = '' THEN 1 ELSE 0 END, t.fecha_entrega, t.id`).all(req.usuario.clase_id);
  res.json(ids.map(r => tareaCompleta(r.id, req.usuario.clase_id)));
});

app.get('/api/tareas/:id', auth, (req, res) => {
  const t = tareaCompleta(req.params.id, req.usuario.clase_id);
  if (!t) return res.status(404).json({ error: 'Tarea no encontrada.' });
  res.json(t);
});

const fechaValida = f => !f || /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(f);

app.post('/api/materias/:id/tareas', auth, (req, res) => {
  const m = db.prepare('SELECT id, clase_id FROM materias WHERE id = ? AND clase_id = ?').get(req.params.id, req.usuario.clase_id);
  if (!m) return res.status(404).json({ error: 'Materia no encontrada.' });
  const titulo = limpiar(req.body.titulo, 120);
  const fecha = limpiar(req.body.fecha_entrega, 16);
  if (!titulo) return res.status(400).json({ error: 'La tarea necesita un título.' });
  if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha de entrega no válida.' });
  const info = db.prepare('INSERT INTO tareas (materia_id, titulo, descripcion, fecha_entrega, creado_por) VALUES (?, ?, ?, ?, ?)')
    .run(m.id, titulo, limpiar(req.body.descripcion, 4000), fecha || null, req.usuario.id);
  io.to(room(m.clase_id)).emit('datos:cambio', { tipo: 'tarea', id: info.lastInsertRowid, materia_id: m.id });
  res.status(201).json(tareaCompleta(info.lastInsertRowid, m.clase_id));
});

app.put('/api/tareas/:id', auth, (req, res) => {
  const t = db.prepare(`SELECT t.* FROM tareas t JOIN materias m ON m.id = t.materia_id
    WHERE t.id = ? AND m.clase_id = ?`).get(req.params.id, req.usuario.clase_id);
  if (!t) return res.status(404).json({ error: 'Tarea no encontrada.' });
  const titulo = limpiar(req.body.titulo ?? t.titulo, 120);
  const fecha = limpiar(req.body.fecha_entrega ?? t.fecha_entrega, 16);
  if (!titulo) return res.status(400).json({ error: 'La tarea necesita un título.' });
  if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha de entrega no válida.' });
  db.prepare('UPDATE tareas SET titulo = ?, descripcion = ?, fecha_entrega = ? WHERE id = ?')
    .run(titulo, limpiar(req.body.descripcion ?? t.descripcion, 4000), fecha || null, t.id);
  io.to(room(req.usuario.clase_id)).emit('datos:cambio', { tipo: 'tarea', id: t.id, materia_id: t.materia_id });
  res.json(tareaCompleta(t.id, req.usuario.clase_id));
});

app.delete('/api/tareas/:id', auth, (req, res) => {
  const t = db.prepare(`SELECT t.id, t.materia_id FROM tareas t JOIN materias m ON m.id = t.materia_id
    WHERE t.id = ? AND m.clase_id = ?`).get(req.params.id, req.usuario.clase_id);
  if (!t) return res.status(404).json({ error: 'Tarea no encontrada.' });
  db.prepare('DELETE FROM tareas WHERE id = ?').run(t.id);
  io.to(room(req.usuario.clase_id)).emit('datos:cambio', { tipo: 'tarea', id: t.id, materia_id: t.materia_id, eliminado: true });
  res.json({ ok: true });
});

app.put('/api/tareas/:id/estado', auth, (req, res) => {
  const t = db.prepare(`SELECT t.id FROM tareas t JOIN materias m ON m.id = t.materia_id
    WHERE t.id = ? AND m.clase_id = ?`).get(req.params.id, req.usuario.clase_id);
  if (!t) return res.status(404).json({ error: 'Tarea no encontrada.' });
  const prev = db.prepare('SELECT hecho, ayuda FROM estados WHERE tarea_id = ? AND usuario_id = ?').get(t.id, req.usuario.id) || { hecho: 0, ayuda: 0 };
  let hecho = req.body.hecho === undefined ? prev.hecho : (req.body.hecho ? 1 : 0);
  let ayuda = req.body.ayuda === undefined ? prev.ayuda : (req.body.ayuda ? 1 : 0);
  if (req.body.hecho && hecho) ayuda = 0;
  db.prepare(`INSERT INTO estados (tarea_id, usuario_id, hecho, ayuda, actualizado) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tarea_id, usuario_id) DO UPDATE SET hecho = excluded.hecho, ayuda = excluded.ayuda, actualizado = excluded.actualizado`)
    .run(t.id, req.usuario.id, hecho, ayuda);
  const tarea = tareaCompleta(t.id, req.usuario.clase_id);
  io.to(room(req.usuario.clase_id)).emit('estado:cambio', {
    tarea,
    por: { id: req.usuario.id, nombre: req.usuario.nombre, color: req.usuario.color },
  });
  res.json(tarea);
});

// ---------- Mensajes ----------
const SQL_MENSAJE = `SELECT x.id, x.tarea_id, x.texto, x.creado, x.clase_id, u.id AS usuario_id, u.nombre, u.color
  FROM mensajes x JOIN usuarios u ON u.id = x.usuario_id`;

app.get('/api/mensajes', auth, (req, res) => {
  const tarea = req.query.tarea ? Number(req.query.tarea) : null;
  if (tarea) {
    const existe = db.prepare(`SELECT t.id FROM tareas t JOIN materias m ON m.id = t.materia_id
      WHERE t.id = ? AND m.clase_id = ?`).get(tarea, req.usuario.clase_id);
    if (!existe) return res.status(404).json({ error: 'Tarea no encontrada.' });
  }
  const rows = tarea
    ? db.prepare(`${SQL_MENSAJE} WHERE x.clase_id = ? AND x.tarea_id = ? ORDER BY x.id DESC LIMIT 200`).all(req.usuario.clase_id, tarea)
    : db.prepare(`${SQL_MENSAJE} WHERE x.clase_id = ? AND x.tarea_id IS NULL ORDER BY x.id DESC LIMIT 200`).all(req.usuario.clase_id);
  res.json(rows.reverse());
});

function guardarMensaje(usuario, tareaId, texto) {
  texto = limpiar(texto, 2000);
  if (!texto) { const e = new Error('Mensaje vacío.'); e.status = 400; throw e; }
  if (tareaId) {
    const t = db.prepare(`SELECT t.id FROM tareas t JOIN materias m ON m.id = t.materia_id
      WHERE t.id = ? AND m.clase_id = ?`).get(tareaId, usuario.clase_id);
    if (!t) { const e = new Error('Tarea no encontrada.'); e.status = 404; throw e; }
  }
  const info = db.prepare('INSERT INTO mensajes (clase_id, tarea_id, usuario_id, texto) VALUES (?, ?, ?, ?)')
    .run(usuario.clase_id, tareaId || null, usuario.id, texto);
  const msg = db.prepare(`${SQL_MENSAJE} WHERE x.id = ?`).get(info.lastInsertRowid);
  io.to(room(usuario.clase_id)).emit('chat:nuevo', msg);
  return msg;
}

app.post('/api/mensajes', auth, (req, res) => {
  try {
    res.status(201).json(guardarMensaje(req.usuario, req.body.tarea_id ? Number(req.body.tarea_id) : null, req.body.texto));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// ---------- Socket.io (una sala por clase) ----------
const conectados = new Map(); // usuario_id -> { n, clase_id }
function idsEnLinea(claseId) {
  const ids = [];
  for (const [id, v] of conectados) if (v.clase_id === claseId && v.n > 0) ids.push(id);
  return ids;
}
function emitirPresencia(claseId) {
  io.to(room(claseId)).emit('presencia', idsEnLinea(claseId));
}

io.use((socket, next) => {
  const u = usuarioPorToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!u || !u.clase_id) return next(new Error('no autorizado'));
  socket.data.usuario = u;
  next();
});

io.on('connection', socket => {
  const u = socket.data.usuario;
  const sala = room(u.clase_id);
  socket.join(sala);
  const prev = conectados.get(u.id);
  conectados.set(u.id, { n: (prev?.n || 0) + 1, clase_id: u.clase_id });
  emitirPresencia(u.clase_id);

  socket.on('chat:enviar', (data, ack) => {
    try {
      const msg = guardarMensaje(u, data && data.tarea_id ? Number(data.tarea_id) : null, data && data.texto);
      ack && ack({ ok: true, mensaje: msg });
    } catch (e) { ack && ack({ ok: false, error: e.message }); }
  });

  socket.on('escribiendo', data => {
    socket.to(sala).emit('escribiendo', { usuario: { id: u.id, nombre: u.nombre, color: u.color }, tarea_id: (data && data.tarea_id) || null });
  });

  socket.on('disconnect', () => {
    const cur = conectados.get(u.id);
    const n = (cur?.n || 1) - 1;
    if (n <= 0) conectados.delete(u.id); else conectados.set(u.id, { n, clase_id: u.clase_id });
    emitirPresencia(u.clase_id);
  });
});

app.get('/api/salud', (req, res) => res.json({ ok: true }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`Clase App escuchando en http://localhost:${PORT}`));
