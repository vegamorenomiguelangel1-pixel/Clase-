// Prueba automática: levanta un servidor temporal (BD aparte), prueba la API y
// verifica en tiempo real con dos clientes Socket.io.
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3999, BASE = `http://localhost:${PORT}`, CODE = 'PRUEBA123';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clase-test-'));
let ok = 0, fail = 0;
const check = (cond, msg) => { if (cond) { ok++; console.log('  ✔', msg); } else { fail++; console.log('  ✘', msg); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function api(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
}
function esperarEvento(sock, ev, pred = () => true, ms = 3000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout esperando ' + ev)), ms);
    const h = d => { if (pred(d)) { clearTimeout(t); sock.off(ev, h); res(d); } };
    sock.on(ev, h);
  });
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, CLASS_CODE: CODE, DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  await new Promise(r => srv.stdout.on('data', d => String(d).includes('escuchando') && r()));
  try {
    console.log('Login');
    check((await api('/api/login', { method: 'POST', body: { nombre: 'Ana', codigo: '' } })).status === 400, 'sin código → 400');
    check((await api('/api/login', { method: 'POST', body: { nombre: 'Ana', codigo: 'malo' } })).status === 401, 'código incorrecto → 401');
    const a = (await api('/api/login', { method: 'POST', body: { nombre: 'Ana', codigo: CODE } })).data;
    const b = (await api('/api/login', { method: 'POST', body: { nombre: 'Beto', codigo: CODE.toLowerCase() } })).data;
    check(a.token && b.token, 'Ana y Beto entran con el código');
    const a2 = (await api('/api/login', { method: 'POST', body: { nombre: 'ana', codigo: CODE } })).data;
    check(a2.usuario.id === a.usuario.id, 'mismo nombre (sin importar mayúsculas) = mismo usuario');
    check((await api('/api/materias')).status === 401, 'API sin token → 401');

    console.log('Materias y tareas');
    const ms = (await api('/api/materias', { token: a.token })).data;
    check(ms.length === 2 && ms.every(m => m.ejemplo === 1 && m.nombre.includes('[EJEMPLO]')), 'datos de ejemplo sembrados y marcados');
    const m = await api('/api/materias', { method: 'POST', token: a.token, body: { nombre: 'Física I', docente: 'Ing. X', color: '#ef4444' } });
    check(m.status === 201, 'crear materia');
    check((await api('/api/materias/' + m.data.id, { method: 'PUT', token: b.token, body: { nombre: 'Física General' } })).data.nombre === 'Física General', 'editar materia');
    const t = await api(`/api/materias/${m.data.id}/tareas`, { method: 'POST', token: a.token, body: { titulo: 'Práctica 1', descripcion: 'Ejercicios 1-10', fecha_entrega: '2026-10-10' } });
    check(t.status === 201 && t.data.total_estudiantes === 2, 'crear tarea');
    check((await api(`/api/materias/${m.data.id}/tareas`, { method: 'POST', token: a.token, body: { titulo: 'x', fecha_entrega: 'mañana' } })).status === 400, 'fecha inválida → 400');
    check((await api('/api/tareas/' + t.data.id, { method: 'PUT', token: a.token, body: { titulo: 'Práctica 1 (corregida)' } })).data.titulo === 'Práctica 1 (corregida)', 'editar tarea');
    check((await api('/api/materias/' + m.data.id, { token: a.token })).data.tareas.length === 1, 'listar tareas de la materia');

    console.log('Tiempo real (2 clientes Socket.io)');
    check(await new Promise(r => { const s = io(BASE, { auth: { token: 'falso' }, reconnection: false }); s.on('connect_error', () => { s.close(); r(true); }); s.on('connect', () => { s.close(); r(false); }); }), 'socket con token falso rechazado');
    const sa = io(BASE, { auth: { token: a.token } }), sb = io(BASE, { auth: { token: b.token } });
    await Promise.all([new Promise(r => sa.on('connect', r)), new Promise(r => sb.on('connect', r))]);
    check(true, 'ambos clientes conectados');

    let ev = esperarEvento(sb, 'estado:cambio', d => d.tarea.id === t.data.id);
    await api(`/api/tareas/${t.data.id}/estado`, { method: 'PUT', token: a.token, body: { hecho: true } });
    let d = await ev;
    check(d.por.nombre === 'Ana' && d.tarea.hechos.some(h => h.nombre === 'Ana') && d.tarea.hechos.length === 1, 'Beto ve en vivo que Ana marcó la tarea (1/2)');

    ev = esperarEvento(sa, 'estado:cambio', d => d.tarea.id === t.data.id && d.por.nombre === 'Beto');
    await api(`/api/tareas/${t.data.id}/estado`, { method: 'PUT', token: b.token, body: { ayuda: true } });
    d = await ev;
    check(d.tarea.ayuda.map(x => x.nombre).join() === 'Beto', 'Ana ve en vivo que Beto pide ayuda');

    ev = esperarEvento(sb, 'chat:nuevo', m => m.texto === 'Hola clase!');
    sa.emit('chat:enviar', { texto: 'Hola clase!' }, () => {});
    d = await ev; check(d.nombre === 'Ana' && d.tarea_id === null, 'Beto recibe mensaje del chat general de Ana');

    ev = esperarEvento(sa, 'chat:nuevo', m => m.tarea_id === t.data.id);
    const ack = await new Promise(r => sb.emit('chat:enviar', { tarea_id: t.data.id, texto: '@Ana me ayudas?' }, r));
    d = await ev; check(ack.ok && d.texto === '@Ana me ayudas?', 'Ana recibe el mensaje de Beto en el hilo de la tarea');
    const vacio = await new Promise(r => sb.emit('chat:enviar', { texto: '   ' }, r));
    check(!vacio.ok, 'mensaje vacío rechazado');

    ev = esperarEvento(sa, 'estado:cambio', d => d.tarea.hechos.length === 2);
    await api(`/api/tareas/${t.data.id}/estado`, { method: 'PUT', token: b.token, body: { hecho: true } });
    d = await ev; check(d.tarea.hechos.length === 2 && d.tarea.ayuda.length === 0, 'al marcar hecha se quita el pedido de ayuda (2/2)');

    const gen = (await api('/api/mensajes', { token: b.token })).data, hilo = (await api('/api/mensajes?tarea=' + t.data.id, { token: a.token })).data;
    check(gen.length === 1 && hilo.length === 1, 'mensajes persistidos en SQLite (general e hilo separados)');
    check((await api('/api/materias', { token: a.token })).data.find(x => x.id === m.data.id).mis_hechas === 1, 'contador "Hice X/Y" en materias');

    ev = esperarEvento(sb, 'datos:cambio', e => e.eliminado);
    check((await api('/api/tareas/' + t.data.id, { method: 'DELETE', token: a.token })).status === 200, 'eliminar tarea');
    await ev; check(true, 'eliminar notifica a otros clientes');
    check((await api('/api/materias/' + m.data.id, { method: 'DELETE', token: a.token })).status === 200, 'eliminar materia');
    check((await api('/api/materias/' + m.data.id, { token: a.token })).status === 404, 'materia eliminada → 404');
    sa.close(); sb.close();
  } catch (e) { fail++; console.error('ERROR', e); }
  srv.kill(); fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\nResultado: ${ok} OK, ${fail} fallos`);
  process.exit(fail ? 1 : 0);
})();
