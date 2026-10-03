// Clase App — servidor (Express + Socket.io).
// Los datos van a Firestore si hay credenciales; si no, a SQLite.
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const storeP = require('./store');

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

const limpiar = (s, max = 200) => String(s ?? '').trim().slice(0, max);
const room = id => 'clase:' + id;
const fechaValida = f => !f || /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(f);

function idEntrada(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  return s;
}

function responderError(res, e, estadoPorDefecto) {
  if (e.status) return res.status(e.status).json({ error: e.message });
  if (estadoPorDefecto) return res.status(estadoPorDefecto).json({ error: e.message || 'No se pudo completar.' });
  console.error(e);
  res.status(500).json({ error: 'Error del servidor.' });
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

app.post('/api/clases', frenar('crear', CREATE_MAX, CREATE_WINDOW), async (req, res) => {
  const nombre = limpiar(req.body.nombre, 40).replace(/\s+/g, ' ');
  const claseNombre = limpiar(req.body.clase, 80).replace(/\s+/g, ' ');
  if (nombre.length < 2) return res.status(400).json({ error: 'Escribe tu nombre (mínimo 2 letras).' });
  if (claseNombre.length < 2) return res.status(400).json({ error: 'La clase necesita un nombre (mínimo 2 letras).' });
  try {
    const store = await storeP;
    const out = await store.crearClase({ nombreClase: claseNombre, nombreUsuario: nombre });
    res.status(201).json(out);
  } catch (e) {
    responderError(res, e, 400);
  }
});

app.post('/api/login', frenar('unirse', JOIN_MAX, JOIN_WINDOW), async (req, res) => {
  const nombre = limpiar(req.body.nombre, 40).replace(/\s+/g, ' ');
  const codigo = normalizarCodigo(req.body.codigo);
  if (nombre.length < 2) return res.status(400).json({ error: 'Escribe tu nombre (mínimo 2 letras).' });
  if (!codigo) return res.status(400).json({ error: 'El código de la clase es obligatorio.' });
  try {
    const store = await storeP;
    const out = await store.unirse({ codigo, nombre });
    if (!out) return res.status(401).json({ error: 'Código de la clase incorrecto.' });
    if (out.nuevo) io.to(room(out.clase.id)).emit('usuarios:cambio');
    res.json({ token: out.token, usuario: out.usuario, clase: out.clase });
  } catch (e) {
    responderError(res, e, 400);
  }
});

async function auth(req, res, next) {
  try {
    const store = await storeP;
    const h = req.headers.authorization || '';
    const u = await store.usuarioPorToken(h.startsWith('Bearer ') ? h.slice(7) : null);
    if (!u) return res.status(401).json({ error: 'Sesión no válida. Vuelve a entrar.' });
    req.usuario = u;
    req.store = store;
    next();
  } catch (e) {
    responderError(res, e);
  }
}

app.post('/api/logout', auth, async (req, res) => {
  await req.store.cerrarSesion(req.headers.authorization.slice(7));
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json(req.usuario));
app.get('/api/usuarios', auth, async (req, res) => {
  try { res.json(await req.store.listarUsuarios(req.usuario.clase_id)); }
  catch (e) { responderError(res, e); }
});

app.put('/api/clase', auth, async (req, res) => {
  try {
    let nombre;
    if (req.body.nombre !== undefined) {
      nombre = limpiar(req.body.nombre, 80).replace(/\s+/g, ' ');
      if (nombre.length < 2) return res.status(400).json({ error: 'El nombre de la clase es muy corto.' });
    }
    const clase = await req.store.actualizarClase(req.usuario.clase_id, req.usuario.id, { nombre, regenerar: !!req.body.regenerar });
    io.to(room(clase.id)).emit('clase:cambio', clase);
    res.json(clase);
  } catch (e) { responderError(res, e, 400); }
});

app.get('/api/materias', auth, async (req, res) => {
  try { res.json(await req.store.listarMaterias(req.usuario.clase_id, req.usuario.id)); }
  catch (e) { responderError(res, e); }
});

app.post('/api/materias', auth, async (req, res) => {
  const nombre = limpiar(req.body.nombre, 80);
  if (!nombre) return res.status(400).json({ error: 'La materia necesita un nombre.' });
  try {
    const materia = await req.store.crearMateria(req.usuario.clase_id, req.usuario.id, {
      nombre, docente: limpiar(req.body.docente, 80), color: limpiar(req.body.color, 9) || '#6366f1',
    });
    io.to(room(req.usuario.clase_id)).emit('datos:cambio', { tipo: 'materia', id: materia.id });
    res.status(201).json(materia);
  } catch (e) { responderError(res, e); }
});

app.put('/api/materias/:id', auth, async (req, res) => {
  try {
    const actual = await req.store.obtenerMateria(req.usuario.clase_id, idEntrada(req.params.id));
    if (!actual) return res.status(404).json({ error: 'Materia no encontrada.' });
    const nombre = limpiar(req.body.nombre ?? actual.nombre, 80);
    if (!nombre) return res.status(400).json({ error: 'La materia necesita un nombre.' });
    const materia = await req.store.actualizarMateria(req.usuario.clase_id, actual.id, {
      nombre,
      docente: limpiar(req.body.docente ?? actual.docente, 80),
      color: limpiar(req.body.color ?? actual.color, 9),
    });
    io.to(room(req.usuario.clase_id)).emit('datos:cambio', { tipo: 'materia', id: materia.id });
    res.json(materia);
  } catch (e) { responderError(res, e); }
});

app.delete('/api/materias/:id', auth, async (req, res) => {
  try {
    const id = idEntrada(req.params.id);
    const ok = await req.store.eliminarMateria(req.usuario.clase_id, id);
    if (!ok) return res.status(404).json({ error: 'Materia no encontrada.' });
    io.to(room(req.usuario.clase_id)).emit('datos:cambio', { tipo: 'materia', id, eliminado: true });
    res.json({ ok: true });
  } catch (e) { responderError(res, e); }
});

app.get('/api/materias/:id', auth, async (req, res) => {
  try {
    const m = await req.store.obtenerMateria(req.usuario.clase_id, idEntrada(req.params.id));
    if (!m) return res.status(404).json({ error: 'Materia no encontrada.' });
    res.json(m);
  } catch (e) { responderError(res, e); }
});

app.get('/api/tareas', auth, async (req, res) => {
  try { res.json(await req.store.listarTareas(req.usuario.clase_id)); }
  catch (e) { responderError(res, e); }
});

app.get('/api/tareas/:id', auth, async (req, res) => {
  try {
    const t = await req.store.obtenerTarea(req.usuario.clase_id, idEntrada(req.params.id));
    if (!t) return res.status(404).json({ error: 'Tarea no encontrada.' });
    res.json(t);
  } catch (e) { responderError(res, e); }
});

app.post('/api/materias/:id/tareas', auth, async (req, res) => {
  const titulo = limpiar(req.body.titulo, 120);
  const fecha = limpiar(req.body.fecha_entrega, 16);
  if (!titulo) return res.status(400).json({ error: 'La tarea necesita un título.' });
  if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha de entrega no válida.' });
  try {
    const tarea = await req.store.crearTarea(req.usuario.clase_id, idEntrada(req.params.id), req.usuario.id, {
      titulo, descripcion: limpiar(req.body.descripcion, 4000), fecha,
    });
    if (!tarea) return res.status(404).json({ error: 'Materia no encontrada.' });
    io.to(room(req.usuario.clase_id)).emit('datos:cambio', { tipo: 'tarea', id: tarea.id, materia_id: tarea.materia_id });
    res.status(201).json(tarea);
  } catch (e) { responderError(res, e); }
});

app.put('/api/tareas/:id', auth, async (req, res) => {
  try {
    const actual = await req.store.obtenerTarea(req.usuario.clase_id, idEntrada(req.params.id));
    if (!actual) return res.status(404).json({ error: 'Tarea no encontrada.' });
    const titulo = limpiar(req.body.titulo ?? actual.titulo, 120);
    const fecha = limpiar(req.body.fecha_entrega ?? actual.fecha_entrega, 16);
    if (!titulo) return res.status(400).json({ error: 'La tarea necesita un título.' });
    if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha de entrega no válida.' });
    const tarea = await req.store.actualizarTarea(req.usuario.clase_id, actual.id, {
      titulo, descripcion: limpiar(req.body.descripcion ?? actual.descripcion, 4000), fecha,
    });
    io.to(room(req.usuario.clase_id)).emit('datos:cambio', { tipo: 'tarea', id: tarea.id, materia_id: tarea.materia_id });
    res.json(tarea);
  } catch (e) { responderError(res, e); }
});

app.delete('/api/tareas/:id', auth, async (req, res) => {
  try {
    const t = await req.store.eliminarTarea(req.usuario.clase_id, idEntrada(req.params.id));
    if (!t) return res.status(404).json({ error: 'Tarea no encontrada.' });
    io.to(room(req.usuario.clase_id)).emit('datos:cambio', { tipo: 'tarea', id: t.id, materia_id: t.materia_id, eliminado: true });
    res.json({ ok: true });
  } catch (e) { responderError(res, e); }
});

app.put('/api/tareas/:id/estado', auth, async (req, res) => {
  try {
    const tarea = await req.store.marcarEstado(req.usuario.clase_id, idEntrada(req.params.id), req.usuario.id, req.body || {});
    if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada.' });
    io.to(room(req.usuario.clase_id)).emit('estado:cambio', {
      tarea,
      por: { id: req.usuario.id, nombre: req.usuario.nombre, color: req.usuario.color },
    });
    res.json(tarea);
  } catch (e) { responderError(res, e); }
});

app.get('/api/mensajes', auth, async (req, res) => {
  try {
    const tarea = req.query.tarea ? idEntrada(req.query.tarea) : null;
    res.json(await req.store.listarMensajes(req.usuario.clase_id, tarea));
  } catch (e) { responderError(res, e); }
});

async function guardarMensaje(store, usuario, tareaId, texto) {
  texto = limpiar(texto, 2000);
  if (!texto) throw Object.assign(new Error('Mensaje vacío.'), { status: 400 });
  const msg = await store.crearMensaje(usuario, tareaId || null, texto);
  io.to(room(usuario.clase_id)).emit('chat:nuevo', msg);
  return msg;
}

app.post('/api/mensajes', auth, async (req, res) => {
  try {
    const msg = await guardarMensaje(req.store, req.usuario, req.body.tarea_id ? idEntrada(req.body.tarea_id) : null, req.body.texto);
    res.status(201).json(msg);
  } catch (e) { responderError(res, e, 400); }
});

const conectados = new Map();
function idsEnLinea(claseId) {
  const ids = [];
  for (const [id, v] of conectados) if (String(v.clase_id) === String(claseId) && v.n > 0) ids.push(id);
  return ids;
}
function emitirPresencia(claseId) {
  io.to(room(claseId)).emit('presencia', idsEnLinea(claseId));
}

io.use(async (socket, next) => {
  try {
    const store = await storeP;
    const u = await store.usuarioPorToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!u || !u.clase_id) return next(new Error('no autorizado'));
    socket.data.usuario = u;
    socket.data.store = store;
    next();
  } catch (e) { next(e); }
});

io.on('connection', socket => {
  const u = socket.data.usuario;
  const sala = room(u.clase_id);
  socket.join(sala);
  const prev = conectados.get(u.id);
  conectados.set(u.id, { n: (prev?.n || 0) + 1, clase_id: u.clase_id });
  emitirPresencia(u.clase_id);

  socket.on('chat:enviar', async (data, ack) => {
    try {
      const msg = await guardarMensaje(socket.data.store, u, data && data.tarea_id ? idEntrada(data.tarea_id) : null, data && data.texto);
      ack && ack({ ok: true, mensaje: msg });
    } catch (e) { ack && ack({ ok: false, error: e.message }); }
  });

  socket.on('escribiendo', data => {
    socket.to(sala).emit('escribiendo', { usuario: { id: u.id, nombre: u.nombre, color: u.color }, tarea_id: data && data.tarea_id ? idEntrada(data.tarea_id) : null });
  });

  socket.on('disconnect', () => {
    const cur = conectados.get(u.id);
    const n = (cur?.n || 1) - 1;
    if (n <= 0) conectados.delete(u.id); else conectados.set(u.id, { n, clase_id: u.clase_id });
    emitirPresencia(u.clase_id);
  });
});

app.get('/api/salud', async (req, res) => {
  try {
    const store = await storeP;
    res.json({ ok: true, almacen: store.driver });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

storeP.then(store => {
  server.listen(PORT, () => console.log(`Clase App escuchando en http://localhost:${PORT} (${store.driver})`));
}).catch(e => {
  console.error('No se pudo abrir el almacén:', e);
  process.exit(1);
});
