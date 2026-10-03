// Clase App — servidor (Express + Socket.io + SQLite)
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const CLASS_CODE = (process.env.CLASS_CODE || 'CLASE2026').trim();
if (!process.env.CLASS_CODE) {
  console.warn('[aviso] CLASS_CODE no definido: usando el código por defecto "CLASE2026". Defínelo en producción.');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const COLORES = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16', '#f97316', '#14b8a6'];
const limpiar = (s, max = 200) => String(s ?? '').trim().slice(0, max);

// ---------- Autenticación (nombre + código de la clase) ----------
function usuarioPorToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.nombre, u.color FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ?`).get(token) || null;
}

app.post('/api/login', (req, res) => {
  const nombre = limpiar(req.body.nombre, 40).replace(/\s+/g, ' ');
  const codigo = limpiar(req.body.codigo, 60);
  if (nombre.length < 2) return res.status(400).json({ error: 'Escribe tu nombre (mínimo 2 letras).' });
  if (!codigo) return res.status(400).json({ error: 'El código de la clase es obligatorio.' });
  if (codigo.toUpperCase() !== CLASS_CODE.toUpperCase()) return res.status(401).json({ error: 'Código de la clase incorrecto.' });

  let usuario = db.prepare('SELECT id, nombre, color FROM usuarios WHERE nombre = ? COLLATE NOCASE').get(nombre);
  if (!usuario) {
    const n = db.prepare('SELECT COUNT(*) c FROM usuarios').get().c;
    const info = db.prepare('INSERT INTO usuarios (nombre, color) VALUES (?, ?)').run(nombre, COLORES[n % COLORES.length]);
    usuario = { id: info.lastInsertRowid, nombre, color: COLORES[n % COLORES.length] };
    io.emit('usuarios:cambio');
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sesiones (token, usuario_id) VALUES (?, ?)').run(token, usuario.id);
  res.json({ token, usuario });
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
  res.json(db.prepare('SELECT id, nombre, color FROM usuarios ORDER BY nombre COLLATE NOCASE').all());
});

// ---------- Materias ----------
const totalUsuarios = () => db.prepare('SELECT COUNT(*) c FROM usuarios').get().c;

app.get('/api/materias', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, u.nombre AS creador,
      (SELECT COUNT(*) FROM tareas t WHERE t.materia_id = m.id) AS total_tareas,
      (SELECT COUNT(*) FROM tareas t JOIN estados e ON e.tarea_id = t.id AND e.usuario_id = ? AND e.hecho = 1 WHERE t.materia_id = m.id) AS mis_hechas,
      (SELECT COUNT(*) FROM tareas t JOIN estados e ON e.tarea_id = t.id AND e.ayuda = 1 WHERE t.materia_id = m.id) AS pedidos_ayuda
    FROM materias m LEFT JOIN usuarios u ON u.id = m.creado_por
    ORDER BY m.nombre COLLATE NOCASE`).all(req.usuario.id);
  res.json(rows);
});

app.post('/api/materias', auth, (req, res) => {
  const nombre = limpiar(req.body.nombre, 80);
  if (!nombre) return res.status(400).json({ error: 'La materia necesita un nombre.' });
  const info = db.prepare('INSERT INTO materias (nombre, docente, color, creado_por) VALUES (?, ?, ?, ?)')
    .run(nombre, limpiar(req.body.docente, 80), limpiar(req.body.color, 9) || '#6366f1', req.usuario.id);
  io.emit('datos:cambio', { tipo: 'materia', id: info.lastInsertRowid });
  res.status(201).json(db.prepare('SELECT * FROM materias WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/materias/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM materias WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Materia no encontrada.' });
  const nombre = limpiar(req.body.nombre ?? m.nombre, 80);
  if (!nombre) return res.status(400).json({ error: 'La materia necesita un nombre.' });
  db.prepare('UPDATE materias SET nombre = ?, docente = ?, color = ? WHERE id = ?')
    .run(nombre, limpiar(req.body.docente ?? m.docente, 80), limpiar(req.body.color ?? m.color, 9), m.id);
  io.emit('datos:cambio', { tipo: 'materia', id: m.id });
  res.json(db.prepare('SELECT * FROM materias WHERE id = ?').get(m.id));
});

app.delete('/api/materias/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM materias WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Materia no encontrada.' });
  io.emit('datos:cambio', { tipo: 'materia', id: Number(req.params.id), eliminado: true });
  res.json({ ok: true });
});

// ---------- Tareas ----------
function estadosDeTarea(tareaId) {
  return db.prepare(`SELECT e.usuario_id, u.nombre, u.color, e.hecho, e.ayuda, e.actualizado
    FROM estados e JOIN usuarios u ON u.id = e.usuario_id
    WHERE e.tarea_id = ? AND (e.hecho = 1 OR e.ayuda = 1) ORDER BY e.actualizado`).all(tareaId);
}
function tareaCompleta(id) {
  const t = db.prepare(`SELECT t.*, m.nombre AS materia_nombre, m.color AS materia_color, u.nombre AS creador,
      (SELECT COUNT(*) FROM mensajes x WHERE x.tarea_id = t.id) AS num_mensajes
    FROM tareas t JOIN materias m ON m.id = t.materia_id LEFT JOIN usuarios u ON u.id = t.creado_por WHERE t.id = ?`).get(id);
  if (!t) return null;
  const est = estadosDeTarea(id);
  t.hechos = est.filter(e => e.hecho).map(({ usuario_id, nombre, color }) => ({ usuario_id, nombre, color }));
  t.ayuda = est.filter(e => e.ayuda).map(({ usuario_id, nombre, color }) => ({ usuario_id, nombre, color }));
  t.total_estudiantes = totalUsuarios();
  return t;
}

app.get('/api/materias/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM materias WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Materia no encontrada.' });
  const ids = db.prepare(`SELECT id FROM tareas WHERE materia_id = ?
    ORDER BY CASE WHEN fecha_entrega IS NULL OR fecha_entrega = '' THEN 1 ELSE 0 END, fecha_entrega, id`).all(m.id);
  m.tareas = ids.map(r => tareaCompleta(r.id));
  res.json(m);
});

app.get('/api/tareas', auth, (req, res) => {
  const ids = db.prepare(`SELECT id FROM tareas ORDER BY CASE WHEN fecha_entrega IS NULL OR fecha_entrega = '' THEN 1 ELSE 0 END, fecha_entrega, id`).all();
  res.json(ids.map(r => tareaCompleta(r.id)));
});

app.get('/api/tareas/:id', auth, (req, res) => {
  const t = tareaCompleta(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tarea no encontrada.' });
  res.json(t);
});

const fechaValida = f => !f || /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(f);

app.post('/api/materias/:id/tareas', auth, (req, res) => {
  const m = db.prepare('SELECT id FROM materias WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Materia no encontrada.' });
  const titulo = limpiar(req.body.titulo, 120);
  const fecha = limpiar(req.body.fecha_entrega, 16);
  if (!titulo) return res.status(400).json({ error: 'La tarea necesita un título.' });
  if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha de entrega no válida.' });
  const info = db.prepare('INSERT INTO tareas (materia_id, titulo, descripcion, fecha_entrega, creado_por) VALUES (?, ?, ?, ?, ?)')
    .run(m.id, titulo, limpiar(req.body.descripcion, 4000), fecha || null, req.usuario.id);
  io.emit('datos:cambio', { tipo: 'tarea', id: info.lastInsertRowid, materia_id: m.id });
  res.status(201).json(tareaCompleta(info.lastInsertRowid));
});

app.put('/api/tareas/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tareas WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tarea no encontrada.' });
  const titulo = limpiar(req.body.titulo ?? t.titulo, 120);
  const fecha = limpiar(req.body.fecha_entrega ?? t.fecha_entrega, 16);
  if (!titulo) return res.status(400).json({ error: 'La tarea necesita un título.' });
  if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha de entrega no válida.' });
  db.prepare('UPDATE tareas SET titulo = ?, descripcion = ?, fecha_entrega = ? WHERE id = ?')
    .run(titulo, limpiar(req.body.descripcion ?? t.descripcion, 4000), fecha || null, t.id);
  io.emit('datos:cambio', { tipo: 'tarea', id: t.id, materia_id: t.materia_id });
  res.json(tareaCompleta(t.id));
});

app.delete('/api/tareas/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tareas WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tarea no encontrada.' });
  db.prepare('DELETE FROM tareas WHERE id = ?').run(t.id);
  io.emit('datos:cambio', { tipo: 'tarea', id: t.id, materia_id: t.materia_id, eliminado: true });
  res.json({ ok: true });
});

// Marcar hecha / pedir ayuda (del usuario actual)
app.put('/api/tareas/:id/estado', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tareas WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tarea no encontrada.' });
  const prev = db.prepare('SELECT hecho, ayuda FROM estados WHERE tarea_id = ? AND usuario_id = ?').get(t.id, req.usuario.id) || { hecho: 0, ayuda: 0 };
  let hecho = req.body.hecho === undefined ? prev.hecho : (req.body.hecho ? 1 : 0);
  let ayuda = req.body.ayuda === undefined ? prev.ayuda : (req.body.ayuda ? 1 : 0);
  if (req.body.hecho && hecho) ayuda = 0; // si ya la hiciste, ya no necesitas ayuda
  db.prepare(`INSERT INTO estados (tarea_id, usuario_id, hecho, ayuda, actualizado) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tarea_id, usuario_id) DO UPDATE SET hecho = excluded.hecho, ayuda = excluded.ayuda, actualizado = excluded.actualizado`)
    .run(t.id, req.usuario.id, hecho, ayuda);
  const tarea = tareaCompleta(t.id);
  io.emit('estado:cambio', { tarea, por: req.usuario });
  res.json(tarea);
});

// ---------- Mensajes ----------
const SQL_MENSAJE = `SELECT x.id, x.tarea_id, x.texto, x.creado, u.id AS usuario_id, u.nombre, u.color
  FROM mensajes x JOIN usuarios u ON u.id = x.usuario_id`;

app.get('/api/mensajes', auth, (req, res) => {
  const tarea = req.query.tarea ? Number(req.query.tarea) : null;
  const rows = tarea
    ? db.prepare(`${SQL_MENSAJE} WHERE x.tarea_id = ? ORDER BY x.id DESC LIMIT 200`).all(tarea)
    : db.prepare(`${SQL_MENSAJE} WHERE x.tarea_id IS NULL ORDER BY x.id DESC LIMIT 200`).all();
  res.json(rows.reverse());
});

function guardarMensaje(usuario, tareaId, texto) {
  texto = limpiar(texto, 2000);
  if (!texto) throw new Error('Mensaje vacío.');
  if (tareaId && !db.prepare('SELECT id FROM tareas WHERE id = ?').get(tareaId)) throw new Error('Tarea no encontrada.');
  const info = db.prepare('INSERT INTO mensajes (tarea_id, usuario_id, texto) VALUES (?, ?, ?)').run(tareaId || null, usuario.id, texto);
  const msg = db.prepare(`${SQL_MENSAJE} WHERE x.id = ?`).get(info.lastInsertRowid);
  io.emit('chat:nuevo', msg); // todos lo reciben; el cliente filtra por sala (general o tarea)
  return msg;
}

app.post('/api/mensajes', auth, (req, res) => {
  try { res.status(201).json(guardarMensaje(req.usuario, req.body.tarea_id ? Number(req.body.tarea_id) : null, req.body.texto)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Socket.io ----------
const conectados = new Map(); // usuario_id -> nº de conexiones
const listaConectados = () => [...conectados.keys()];

io.use((socket, next) => {
  const u = usuarioPorToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('no autorizado'));
  socket.data.usuario = u;
  next();
});

io.on('connection', socket => {
  const u = socket.data.usuario;
  conectados.set(u.id, (conectados.get(u.id) || 0) + 1);
  io.emit('presencia', listaConectados());

  socket.on('chat:enviar', (data, ack) => {
    try {
      const msg = guardarMensaje(u, data && data.tarea_id ? Number(data.tarea_id) : null, data && data.texto);
      ack && ack({ ok: true, mensaje: msg });
    } catch (e) { ack && ack({ ok: false, error: e.message }); }
  });

  socket.on('escribiendo', data => {
    socket.broadcast.emit('escribiendo', { usuario: u, tarea_id: (data && data.tarea_id) || null });
  });

  socket.on('disconnect', () => {
    const n = (conectados.get(u.id) || 1) - 1;
    if (n <= 0) conectados.delete(u.id); else conectados.set(u.id, n);
    io.emit('presencia', listaConectados());
  });
});

app.get('/api/salud', (req, res) => res.json({ ok: true }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`Clase App escuchando en http://localhost:${PORT}`));
