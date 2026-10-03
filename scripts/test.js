// Prueba automática: levanta un servidor temporal (BD aparte), prueba la API y
// verifica en tiempo real con clientes Socket.io, incluido el aislamiento entre clases.
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { io } = require('socket.io-client');

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
let ok = 0, fail = 0;
const check = (cond, msg) => { if (cond) { ok++; console.log('  ✔', msg); } else { fail++; console.log('  ✘', msg); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function hacerApi(base) {
  return async function api(p, { method = 'GET', body, token } = {}) {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}
function esperarEvento(sock, ev, pred = () => true, ms = 3000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout esperando ' + ev)), ms);
    const h = d => { if (pred(d)) { clearTimeout(t); sock.off(ev, h); res(d); } };
    sock.on(ev, h);
  });
}
function espia(sock, ev) {
  const hits = [];
  const h = d => hits.push(d);
  sock.on(ev, h);
  return { hits, off() { sock.off(ev, h); } };
}
function arrancar(env) {
  const dataDir = env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'clase-test-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      FIREBASE_SERVICE_ACCOUNT: '', FIREBASE_PROJECT_ID: '', GOOGLE_APPLICATION_CREDENTIALS: '', FIRESTORE_EMULATOR_HOST: '',
      SEED: 'false', CLASS_CODE: '', RATE_CREATE_MAX: '10', RATE_JOIN_MAX: '60', ...env, DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; process.stderr.write('[srv] ' + d); });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('el servidor no arrancó:\n' + log)), 8000);
    const onData = d => { if (String(d).includes('escuchando')) { clearTimeout(t); resolve(); } };
    srv.stdout.on('data', onData);
    srv.on('exit', code => { if (code) { clearTimeout(t); reject(new Error('el servidor terminó (' + code + '):\n' + log)); } });
  });
  return { srv, dataDir, ready };
}
async function detener(srv, dataDir) {
  if (srv && !srv.killed) srv.kill();
  await wait(80);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function pruebaApp() {
  const PORT = 3999, BASE = `http://localhost:${PORT}`;
  const { srv, dataDir, ready } = arrancar({ PORT: String(PORT) });
  const api = hacerApi(BASE);
  await ready;
  const sockets = [];
  try {
    console.log('Login');
    check((await api('/api/salud')).data.almacen === 'sqlite', 'sin credenciales de Firebase se usa SQLite');
    check((await api('/api/login', { method: 'POST', body: { nombre: 'Ana', codigo: '' } })).status === 400, 'sin código → 400');
    check((await api('/api/login', { method: 'POST', body: { nombre: 'Ana', codigo: 'malo' } })).status === 401, 'código incorrecto → 401');
    const creada = await api('/api/clases', { method: 'POST', body: { nombre: 'Ana', clase: 'Física 2' } });
    check(creada.status === 201 && creada.data.token && creada.data.usuario.es_creador, 'Ana crea una clase y es la creadora');
    const CODE = creada.data.clase.codigo;
    const a = creada.data;
    check(new RegExp(`^[${ALFABETO}]{6}$`).test(CODE), 'código de 6 letras/dígitos sin caracteres ambiguos');
    const b = await api('/api/login', { method: 'POST', body: { nombre: 'Beto', codigo: CODE.toLowerCase() } });
    check(b.status === 200 && b.data.token && !b.data.usuario.es_creador, 'Beto entra con el código (aunque vaya en minúsculas)');
    const a2 = await api('/api/login', { method: 'POST', body: { nombre: 'ana', codigo: ' ' + CODE + ' ' } });
    check(a2.data.usuario.id === a.usuario.id, 'mismo nombre en la misma clase (sin importar mayúsculas) = mismo usuario');
    check((await api('/api/materias')).status === 401, 'API sin token → 401');

    console.log('Materias y tareas');
    const ms = (await api('/api/materias', { token: a.token })).data;
    check(Array.isArray(ms) && ms.length === 0, 'clase nueva empieza vacía, sin datos de ejemplo');
    const m = await api('/api/materias', { method: 'POST', token: a.token, body: { nombre: 'Física I', docente: 'Ing. X', color: '#ef4444' } });
    check(m.status === 201 && m.data.ejemplo === 0, 'crear materia');
    check((await api('/api/materias/' + m.data.id, { method: 'PUT', token: b.data.token, body: { nombre: 'Física General' } })).data.nombre === 'Física General', 'editar materia');
    const t = await api(`/api/materias/${m.data.id}/tareas`, { method: 'POST', token: a.token, body: { titulo: 'Práctica 1', descripcion: 'Ejercicios 1-10', fecha_entrega: '2026-10-10' } });
    check(t.status === 201 && t.data.total_estudiantes === 2, 'crear tarea');
    check((await api(`/api/materias/${m.data.id}/tareas`, { method: 'POST', token: a.token, body: { titulo: 'x', fecha_entrega: 'mañana' } })).status === 400, 'fecha inválida → 400');
    check((await api('/api/tareas/' + t.data.id, { method: 'PUT', token: a.token, body: { titulo: 'Práctica 1 (corregida)' } })).data.titulo === 'Práctica 1 (corregida)', 'editar tarea');
    check((await api('/api/materias/' + m.data.id, { token: a.token })).data.tareas.length === 1, 'listar tareas de la materia');

    console.log('Tiempo real (2 clientes Socket.io)');
    check(await new Promise(r => { const s = io(BASE, { auth: { token: 'falso' }, reconnection: false }); s.on('connect_error', () => { s.close(); r(true); }); s.on('connect', () => { s.close(); r(false); }); }), 'socket con token falso rechazado');
    const sa = io(BASE, { auth: { token: a.token } }), sb = io(BASE, { auth: { token: b.data.token } });
    sockets.push(sa, sb);
    await Promise.all([new Promise(r => sa.on('connect', r)), new Promise(r => sb.on('connect', r))]);
    check(true, 'ambos clientes conectados');

    let ev = esperarEvento(sb, 'estado:cambio', d => d.tarea.id === t.data.id);
    await api(`/api/tareas/${t.data.id}/estado`, { method: 'PUT', token: a.token, body: { hecho: true } });
    let d = await ev;
    check(d.por.nombre === 'Ana' && d.tarea.hechos.some(h => h.nombre === 'Ana') && d.tarea.hechos.length === 1, 'Beto ve en vivo que Ana marcó la tarea (1/2)');

    ev = esperarEvento(sa, 'estado:cambio', d => d.tarea.id === t.data.id && d.por.nombre === 'Beto');
    await api(`/api/tareas/${t.data.id}/estado`, { method: 'PUT', token: b.data.token, body: { ayuda: true } });
    d = await ev;
    check(d.tarea.ayuda.map(x => x.nombre).join() === 'Beto', 'Ana ve en vivo que Beto pide ayuda');

    ev = esperarEvento(sb, 'chat:nuevo', msg => msg.texto === 'Hola clase!');
    sa.emit('chat:enviar', { texto: 'Hola clase!' }, () => {});
    d = await ev; check(d.nombre === 'Ana' && d.tarea_id === null, 'Beto recibe mensaje del chat general de Ana');

    ev = esperarEvento(sa, 'chat:nuevo', msg => msg.tarea_id === t.data.id);
    const ack = await new Promise(r => sb.emit('chat:enviar', { tarea_id: t.data.id, texto: '@Ana me ayudas?' }, r));
    d = await ev; check(ack.ok && d.texto === '@Ana me ayudas?', 'Ana recibe el mensaje de Beto en el hilo de la tarea');
    const vacio = await new Promise(r => sb.emit('chat:enviar', { texto: '   ' }, r));
    check(!vacio.ok, 'mensaje vacío rechazado');

    ev = esperarEvento(sa, 'estado:cambio', x => x.tarea.hechos.length === 2);
    await api(`/api/tareas/${t.data.id}/estado`, { method: 'PUT', token: b.data.token, body: { hecho: true } });
    d = await ev; check(d.tarea.hechos.length === 2 && d.tarea.ayuda.length === 0, 'al marcar hecha se quita el pedido de ayuda (2/2)');

    const gen = (await api('/api/mensajes', { token: b.data.token })).data, hilo = (await api('/api/mensajes?tarea=' + t.data.id, { token: a.token })).data;
    check(gen.length === 1 && hilo.length === 1, 'mensajes persistidos en SQLite (general e hilo separados)');
    check((await api('/api/materias', { token: a.token })).data.find(x => x.id === m.data.id).mis_hechas === 1, 'contador "Hice X/Y" en materias');

    ev = esperarEvento(sb, 'datos:cambio', e => e.eliminado);
    check((await api('/api/tareas/' + t.data.id, { method: 'DELETE', token: a.token })).status === 200, 'eliminar tarea');
    await ev; check(true, 'eliminar notifica a otros clientes');
    check((await api('/api/materias/' + m.data.id, { method: 'DELETE', token: a.token })).status === 200, 'eliminar materia');
    check((await api('/api/materias/' + m.data.id, { token: a.token })).status === 404, 'materia eliminada → 404');

    console.log('Ajustes de quien creó la clase');
    check((await api('/api/clase', { method: 'PUT', token: b.data.token, body: { nombre: 'Hack' } })).status === 403, 'quien no creó la clase no la renombra');
    ev = esperarEvento(sb, 'clase:cambio', c => c.nombre === 'Física renovada');
    const ren = await api('/api/clase', { method: 'PUT', token: a.token, body: { nombre: 'Física renovada' } });
    d = await ev;
    check(ren.status === 200 && ren.data.codigo === CODE && d.nombre === 'Física renovada', 'la creadora renombra la clase y Beto lo ve');
    const regen = await api('/api/clase', { method: 'PUT', token: a.token, body: { regenerar: true } });
    check(regen.status === 200 && regen.data.codigo !== CODE && new RegExp(`^[${ALFABETO}]{6}$`).test(regen.data.codigo), 'la creadora regenera el código');
    check((await api('/api/login', { method: 'POST', body: { nombre: 'Ciro', codigo: CODE } })).status === 401, 'el código viejo ya no sirve');
    const ciro = await api('/api/login', { method: 'POST', body: { nombre: 'Ciro', codigo: regen.data.codigo } });
    check(ciro.status === 200, 'el código nuevo sí funciona');

    console.log('Aislamiento entre clases');
    const ca = await api('/api/clases', { method: 'POST', body: { nombre: 'Ana', clase: 'Grupo A' } });
    const cb = await api('/api/clases', { method: 'POST', body: { nombre: 'Ana', clase: 'Grupo B' } });
    check(ca.status === 201 && cb.status === 201 && ca.data.usuario.id !== cb.data.usuario.id, 'el mismo nombre en otra clase es otro usuario');
    check((await api('/api/materias', { token: ca.data.token })).data.length === 0 && (await api('/api/materias', { token: cb.data.token })).data.length === 0, 'ninguna clase creada trae materias de ejemplo');
    const luis = await api('/api/login', { method: 'POST', body: { nombre: 'Luis', codigo: ca.data.clase.codigo } });
    const mA = await api('/api/materias', { method: 'POST', token: ca.data.token, body: { nombre: 'Química' } });
    const tA = await api(`/api/materias/${mA.data.id}/tareas`, { method: 'POST', token: ca.data.token, body: { titulo: 'Lab 1', fecha_entrega: '2026-11-01' } });
    const mB = await api('/api/materias', { method: 'POST', token: cb.data.token, body: { nombre: 'Historia' } });
    check((await api('/api/materias', { token: cb.data.token })).data.every(x => x.nombre === 'Historia'), 'la clase B no ve las materias de A');
    check((await api('/api/tareas/' + tA.data.id, { token: cb.data.token })).status === 404, 'tarea de otra clase → 404');
    check((await api(`/api/tareas/${tA.data.id}/estado`, { method: 'PUT', token: cb.data.token, body: { hecho: true } })).status === 404, 'no se puede marcar una tarea de otra clase');
    check((await api('/api/mensajes?tarea=' + tA.data.id, { token: cb.data.token })).status === 404, 'el chat de una tarea ajena → 404');

    const sA = io(BASE, { auth: { token: luis.data.token } }), sB = io(BASE, { auth: { token: cb.data.token } });
    sockets.push(sA, sB);
    await Promise.all([new Promise(r => sA.on('connect', r)), new Promise(r => sB.on('connect', r))]);
    let spy = espia(sB, 'estado:cambio');
    ev = esperarEvento(sA, 'estado:cambio', x => x.tarea.id === tA.data.id && x.por.nombre === 'Ana');
    await api(`/api/tareas/${tA.data.id}/estado`, { method: 'PUT', token: ca.data.token, body: { hecho: true } });
    await ev; await wait(350);
    check(spy.hits.length === 0, 'el check de la clase A no llega a la clase B');
    spy.off();

    const sAna = io(BASE, { auth: { token: ca.data.token } });
    sockets.push(sAna);
    await new Promise(r => sAna.on('connect', r));
    spy = espia(sB, 'chat:nuevo');
    ev = esperarEvento(sA, 'chat:nuevo', msg => msg.texto === 'solo grupo A' && msg.tarea_id === null);
    sAna.emit('chat:enviar', { texto: 'solo grupo A' }, () => {});
    d = await ev; await wait(350);
    check(d.nombre === 'Ana' && spy.hits.length === 0, 'el chat general de A no llega a B');
    spy.off();

    ev = esperarEvento(sA, 'chat:nuevo', msg => msg.tarea_id === tA.data.id);
    spy = espia(sB, 'chat:nuevo');
    sAna.emit('chat:enviar', { tarea_id: tA.data.id, texto: 'duda del lab' }, () => {});
    d = await ev; await wait(350);
    check(d.texto === 'duda del lab' && spy.hits.length === 0, 'el chat de la tarea de A no llega a B');
    spy.off();

    const leakA = espia(sA, 'chat:nuevo');
    ev = esperarEvento(sB, 'chat:nuevo', msg => msg.texto === 'solo grupo B');
    const sBetoB = io(BASE, { auth: { token: cb.data.token } });
    sockets.push(sBetoB);
    await new Promise(r => sBetoB.on('connect', r));
    sBetoB.emit('chat:enviar', { texto: 'solo grupo B' }, () => {});
    await ev; await wait(350);
    check(leakA.hits.length === 0, 'el chat de B no llega a A');
    leakA.off();

    const msgsA = (await api('/api/mensajes', { token: ca.data.token })).data;
    const msgsB = (await api('/api/mensajes', { token: cb.data.token })).data;
    check(msgsA.some(x => x.texto === 'solo grupo A') && !msgsA.some(x => x.texto === 'solo grupo B'), 'A solo lee su chat general');
    check(msgsB.some(x => x.texto === 'solo grupo B') && !msgsB.some(x => x.texto === 'solo grupo A') && !msgsB.some(x => x.texto === 'duda del lab'), 'B no lee mensajes de A');
    const listaA = (await api('/api/materias', { token: ca.data.token })).data;
    check(listaA.some(x => x.id === mA.data.id) && !listaA.some(x => x.id === mB.data.id), 'A no lista la materia de B');

    console.log('Límite de creación');
    let limitado = false, creadas = 0;
    for (let i = 0; i < 15; i++) {
      const r = await api('/api/clases', { method: 'POST', body: { nombre: 'Tasa ' + i, clase: 'Clase tasa ' + i } });
      if (r.status === 429) { limitado = true; break; }
      if (r.status === 201) creadas++;
    }
    check(limitado && creadas >= 1, 'límite de creación de clases por IP');
  } finally {
    sockets.forEach(s => s.close());
    await detener(srv, dataDir);
  }
}

async function pruebaSeedAislado() {
  console.log('Datos de ejemplo');
  const PORT = 4002, BASE = `http://localhost:${PORT}`;
  const { srv, dataDir, ready } = arrancar({ PORT: String(PORT), SEED: 'true', CLASS_CODE: 'DEMOTEST' });
  const api = hacerApi(BASE);
  await ready;
  try {
    const nueva = await api('/api/clases', { method: 'POST', body: { nombre: 'Ana', clase: 'Sin ejemplos' } });
    const propias = (await api('/api/materias', { token: nueva.data.token })).data;
    check(nueva.status === 201 && propias.length === 0, 'con SEED=true la clase creada sigue vacía');
    const demo = await api('/api/login', { method: 'POST', body: { nombre: 'Ana', codigo: 'demotest' } });
    const ms = (await api('/api/materias', { token: demo.data.token })).data;
    check(demo.status === 200 && demo.data.usuario.id !== nueva.data.usuario.id, 'entrar a la demo no reutiliza el usuario de otra clase');
    check(ms.length === 2 && ms.every(m => m.ejemplo === 1 && m.nombre.includes('[EJEMPLO]')), 'la clase demo (SEED=true) sí trae ejemplos marcados');
  } finally {
    await detener(srv, dataDir);
  }
}

async function pruebaMigracion() {
  console.log('Migración');
  const Database = require('better-sqlite3');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clase-migra-'));
  const legacy = new Database(path.join(dataDir, 'clase.db'));
  legacy.exec(`
    CREATE TABLE usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color TEXT NOT NULL DEFAULT '#6366f1',
      creado TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sesiones (
      token TEXT PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      creado TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE materias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      docente TEXT DEFAULT '',
      color TEXT DEFAULT '#6366f1',
      ejemplo INTEGER NOT NULL DEFAULT 0,
      creado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      creado TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tareas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
      titulo TEXT NOT NULL,
      descripcion TEXT DEFAULT '',
      fecha_entrega TEXT,
      ejemplo INTEGER NOT NULL DEFAULT 0,
      creado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      creado TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE estados (
      tarea_id INTEGER NOT NULL REFERENCES tareas(id) ON DELETE CASCADE,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      hecho INTEGER NOT NULL DEFAULT 0,
      ayuda INTEGER NOT NULL DEFAULT 0,
      actualizado TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tarea_id, usuario_id)
    );
    CREATE TABLE mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarea_id INTEGER REFERENCES tareas(id) ON DELETE CASCADE,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      creado TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE meta (clave TEXT PRIMARY KEY, valor TEXT);
  `);
  const uid = legacy.prepare("INSERT INTO usuarios (nombre, color) VALUES ('Ana', '#6366f1')").run().lastInsertRowid;
  const mid = legacy.prepare("INSERT INTO materias (nombre, docente, color, ejemplo, creado_por) VALUES ('Historia', 'Lic. Paz', '#6366f1', 0, ?)").run(uid).lastInsertRowid;
  legacy.prepare("INSERT INTO tareas (materia_id, titulo, descripcion, fecha_entrega, ejemplo, creado_por) VALUES (?, 'Ensayo', 'La colonia', '2026-10-20', 0, ?)").run(mid, uid);
  legacy.prepare("INSERT INTO mensajes (tarea_id, usuario_id, texto) VALUES (NULL, ?, 'hola viejo')").run(uid);
  legacy.prepare("INSERT INTO meta (clave, valor) VALUES ('seed', '1')").run();
  legacy.close();

  const PORT = 4001, BASE = `http://localhost:${PORT}`;
  const { srv, ready } = arrancar({ PORT: String(PORT), DATA_DIR: dataDir, CLASS_CODE: 'MIGRA1', SEED: 'false' });
  const api = hacerApi(BASE);
  await ready;
  try {
    const ana = await api('/api/login', { method: 'POST', body: { nombre: 'ana', codigo: 'migra1' } });
    const materias = (await api('/api/materias', { token: ana.data.token })).data;
    const msgs = (await api('/api/mensajes', { token: ana.data.token })).data;
    check(ana.status === 200 && ana.data.usuario.id === 1 && ana.data.usuario.es_creador, 'la base antigua se abre con el código de migración');
    check(materias.length === 1 && materias[0].nombre === 'Historia' && materias[0].total_tareas === 1, 'materias y tareas viejas siguen en esa clase');
    check(msgs.length === 1 && msgs[0].texto === 'hola viejo', 'el chat general viejo se conserva');
    const otra = await api('/api/clases', { method: 'POST', body: { nombre: 'Ana', clase: 'Nueva' } });
    check((await api('/api/materias', { token: otra.data.token })).data.length === 0, 'una clase nueva junto a datos migrados nace vacía');
    check((await api('/api/login', { method: 'POST', body: { nombre: 'Beto', codigo: 'NO-ES' } })).status === 401, 'un código que no existe sigue siendo rechazado');
  } finally {
    await detener(srv, dataDir);
  }
}

async function pruebaLimiteUnion() {
  console.log('Límite de unión');
  const PORT = 4003, BASE = `http://localhost:${PORT}`;
  const { srv, dataDir, ready } = arrancar({ PORT: String(PORT), RATE_JOIN_MAX: '3', RATE_CREATE_MAX: '10' });
  const api = hacerApi(BASE);
  await ready;
  try {
    const estados = [];
    for (let i = 0; i < 3; i++) estados.push((await api('/api/login', { method: 'POST', body: { nombre: 'Ana', codigo: 'NOEXISTE' } })).status);
    check(estados.every(s => s === 401), 'tres códigos incorrectos → 401');
    check((await api('/api/login', { method: 'POST', body: { nombre: 'Ana', codigo: 'OTRO' } })).status === 429, 'demasiados intentos de unión → 429');
  } finally {
    await detener(srv, dataDir);
  }
}

(async () => {
  try { await pruebaApp(); } catch (e) { fail++; console.error('ERROR', e); }
  try { await pruebaSeedAislado(); } catch (e) { fail++; console.error('ERROR seed', e); }
  try { await pruebaMigracion(); } catch (e) { fail++; console.error('ERROR migracion', e); }
  try { await pruebaLimiteUnion(); } catch (e) { fail++; console.error('ERROR limite', e); }
  console.log(`\nResultado: ${ok} OK, ${fail} fallos`);
  process.exit(fail ? 1 : 0);
})();
