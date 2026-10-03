// Prueba corta contra el emulador de Firestore.
// La lanza `npm run test:firestore` (hace falta Java y firebase-tools).
const { spawn } = require('child_process');
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Falta FIRESTORE_EMULATOR_HOST. Usa: npm run test:firestore');
  process.exit(1);
}

const PORT = 4011;
const BASE = `http://127.0.0.1:${PORT}`;
const proyecto = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'demo-clase';

function api(p, { method = 'GET', body, token } = {}) {
  return fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body && JSON.stringify(body),
  }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));
}

const srv = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    PORT: String(PORT),
    FIREBASE_PROJECT_ID: proyecto,
    FIREBASE_SERVICE_ACCOUNT: '',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    SEED: 'false',
    DATA_DIR: path.join(require('os').tmpdir(), 'clase-firestore-no-usar'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', d => { log += d; });
srv.stderr.on('data', d => { log += d; process.stderr.write(d); });

function fail(msg) {
  console.error('✘', msg);
  console.error(log);
  srv.kill();
  process.exit(1);
}

(async () => {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no arrancó\n' + log)), 15000);
    srv.stdout.on('data', d => { if (String(d).includes('escuchando')) { clearTimeout(t); resolve(); } });
    srv.on('exit', code => { clearTimeout(t); reject(new Error('salió ' + code + '\n' + log)); });
  });
  const salud = await api('/api/salud');
  if (salud.data.almacen !== 'firestore') fail('no está usando Firestore: ' + JSON.stringify(salud.data));
  const a = await api('/api/clases', { method: 'POST', body: { nombre: 'Ana', clase: 'Grupo A' } });
  const b = await api('/api/clases', { method: 'POST', body: { nombre: 'Ana', clase: 'Grupo B' } });
  if (a.status !== 201 || b.status !== 201) fail('no se crearon las clases');
  if (a.data.usuario.id === b.data.usuario.id) fail('el mismo nombre no debe ser el mismo usuario');
  const materia = await api('/api/materias', { method: 'POST', token: a.data.token, body: { nombre: 'Química' } });
  const tarea = await api(`/api/materias/${materia.data.id}/tareas`, { method: 'POST', token: a.data.token, body: { titulo: 'Lab' } });
  await api('/api/mensajes', { method: 'POST', token: a.data.token, body: { texto: 'solo A' } });
  await api('/api/mensajes', { method: 'POST', token: a.data.token, body: { tarea_id: tarea.data.id, texto: 'hilo A' } });
  const materiasB = await api('/api/materias', { token: b.data.token });
  const msgsB = await api('/api/mensajes', { token: b.data.token });
  const ajena = await api('/api/tareas/' + tarea.data.id, { token: b.data.token });
  if (materiasB.data.length !== 0) fail('B ve materias de A');
  if (msgsB.data.some(m => m.texto === 'solo A' || m.texto === 'hilo A')) fail('B ve el chat de A');
  if (ajena.status !== 404) fail('B puede abrir la tarea de A');
  const propias = await api('/api/materias', { token: a.data.token });
  if (!propias.data.some(m => m.nombre === 'Química')) fail('A no ve su materia');
  console.log('Firestore emulator: OK (clases aisladas, ' + a.data.clase.codigo + ' / ' + b.data.clase.codigo + ')');
  srv.kill();
  process.exit(0);
})().catch(e => fail(e.message));
