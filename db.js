// Base de datos SQLite (archivo en DATA_DIR o ./data).
// Cada clase es un espacio aparte: usuarios, materias, tareas, marcas y chat.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, 'clase.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Sin 0/O/1/I/L para que el código se pueda dictar y copiar sin confusiones.
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generarCodigo() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += ALFABETO[bytes[i] % ALFABETO.length];
  return s;
}
db.generarCodigo = generarCodigo;

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function hasColumn(table, col) {
  if (!tableExists(table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
function setMeta(clave, valor) {
  db.prepare(`INSERT INTO meta (clave, valor) VALUES (?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`).run(clave, valor);
}

const ESQUEMA = `
CREATE TABLE clases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  codigo TEXT NOT NULL UNIQUE COLLATE NOCASE,
  creador_id INTEGER,
  demo INTEGER NOT NULL DEFAULT 0,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clase_id INTEGER NOT NULL REFERENCES clases(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (clase_id, nombre COLLATE NOCASE)
);
CREATE TABLE sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE materias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clase_id INTEGER NOT NULL REFERENCES clases(id) ON DELETE CASCADE,
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
  clase_id INTEGER NOT NULL REFERENCES clases(id) ON DELETE CASCADE,
  tarea_id INTEGER REFERENCES tareas(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  texto TEXT NOT NULL,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mensajes_clase ON mensajes(clase_id, tarea_id, id);
CREATE INDEX idx_materias_clase ON materias(clase_id);
CREATE TABLE meta (clave TEXT PRIMARY KEY, valor TEXT);
`;

function createFresh() {
  db.exec(ESQUEMA);
  setMeta('schema', '2');
}

// Bases creadas por la versión de una sola clase: se conservan dentro de una clase.
function migrateLegacy() {
  const codigo = (process.env.CLASS_CODE || 'CLASE2026').trim().toUpperCase() || 'CLASE2026';
  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(`CREATE TABLE clases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        codigo TEXT NOT NULL UNIQUE COLLATE NOCASE,
        creador_id INTEGER,
        demo INTEGER NOT NULL DEFAULT 0,
        creado TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      const claseId = db.prepare('INSERT INTO clases (nombre, codigo, demo) VALUES (?, ?, 0)').run('Mi clase', codigo).lastInsertRowid;

      db.exec(`CREATE TABLE usuarios_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clase_id INTEGER NOT NULL REFERENCES clases(id) ON DELETE CASCADE,
        nombre TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#6366f1',
        creado TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (clase_id, nombre COLLATE NOCASE)
      )`);
      db.prepare(`INSERT INTO usuarios_new (id, clase_id, nombre, color, creado)
        SELECT id, ?, nombre, color, creado FROM usuarios`).run(claseId);
      db.exec('DROP TABLE usuarios');
      db.exec('ALTER TABLE usuarios_new RENAME TO usuarios');

      const primero = db.prepare('SELECT id FROM usuarios WHERE clase_id = ? ORDER BY id LIMIT 1').get(claseId);
      if (primero) db.prepare('UPDATE clases SET creador_id = ? WHERE id = ?').run(primero.id, claseId);

      db.exec(`CREATE TABLE materias_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clase_id INTEGER NOT NULL REFERENCES clases(id) ON DELETE CASCADE,
        nombre TEXT NOT NULL,
        docente TEXT DEFAULT '',
        color TEXT DEFAULT '#6366f1',
        ejemplo INTEGER NOT NULL DEFAULT 0,
        creado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        creado TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.prepare(`INSERT INTO materias_new (id, clase_id, nombre, docente, color, ejemplo, creado_por, creado)
        SELECT id, ?, nombre, COALESCE(docente, ''), color, ejemplo, creado_por, creado FROM materias`).run(claseId);
      db.exec('DROP TABLE materias');
      db.exec('ALTER TABLE materias_new RENAME TO materias');
      db.exec('CREATE INDEX idx_materias_clase ON materias(clase_id)');

      db.exec(`CREATE TABLE mensajes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clase_id INTEGER NOT NULL REFERENCES clases(id) ON DELETE CASCADE,
        tarea_id INTEGER REFERENCES tareas(id) ON DELETE CASCADE,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        texto TEXT NOT NULL,
        creado TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.prepare(`INSERT INTO mensajes_new (id, clase_id, tarea_id, usuario_id, texto, creado)
        SELECT id, ?, tarea_id, usuario_id, texto, creado FROM mensajes`).run(claseId);
      db.exec('DROP TABLE mensajes');
      db.exec('ALTER TABLE mensajes_new RENAME TO mensajes');
      db.exec('CREATE INDEX idx_mensajes_clase ON mensajes(clase_id, tarea_id, id)');

      if (!tableExists('meta')) db.exec('CREATE TABLE meta (clave TEXT PRIMARY KEY, valor TEXT)');
      setMeta('schema', '2');
    });
    tx();
    console.log(`Base antigua migrada a una clase. Código para entrar: ${codigo}`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

if (!tableExists('usuarios')) createFresh();
else if (!hasColumn('usuarios', 'clase_id')) migrateLegacy();

function codigoLibre() {
  for (let i = 0; i < 12; i++) {
    const codigo = generarCodigo();
    if (!db.prepare('SELECT 1 FROM clases WHERE codigo = ?').get(codigo)) return codigo;
  }
  throw new Error('No se pudo generar un código para la clase de ejemplo.');
}

// Solo si SEED=true de forma explícita. Nunca se copian materias a clases creadas por la gente.
function ensureDemo() {
  if (process.env.SEED !== 'true') return;
  if (db.prepare("SELECT valor FROM meta WHERE clave = 'seed'").get()) return;

  let codigo = (process.env.CLASS_CODE || '').trim().toUpperCase();
  let clase = codigo ? db.prepare('SELECT * FROM clases WHERE codigo = ? COLLATE NOCASE').get(codigo) : null;
  if (clase && !clase.demo) {
    codigo = '';
    clase = null;
  }
  if (!clase) {
    if (!codigo) codigo = codigoLibre();
    const id = db.prepare("INSERT INTO clases (nombre, codigo, demo) VALUES ('Clase de ejemplo', ?, 1)").run(codigo).lastInsertRowid;
    clase = { id, codigo };
  }

  const ya = db.prepare('SELECT COUNT(*) c FROM materias WHERE clase_id = ?').get(clase.id).c;
  if (!ya) {
    const enDias = d => {
      const f = new Date(); f.setDate(f.getDate() + d);
      return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
    };
    const tx = db.transaction(() => {
      const m = db.prepare('INSERT INTO materias (clase_id, nombre, docente, color, ejemplo) VALUES (?, ?, ?, ?, 1)');
      const t = db.prepare('INSERT INTO tareas (materia_id, titulo, descripcion, fecha_entrega, ejemplo) VALUES (?, ?, ?, ?, 1)');
      const m1 = m.run(clase.id, '[EJEMPLO] Cálculo I', 'Lic. Ejemplo', '#6366f1').lastInsertRowid;
      t.run(m1, '[EJEMPLO] Práctica 3: Límites', 'Resolver los ejercicios 1 al 15 de la guía. (Dato de ejemplo: puedes editarlo o eliminarlo.)', enDias(3));
      t.run(m1, '[EJEMPLO] Derivadas por definición', 'Ejercicios impares de la sección 2.1. (Dato de ejemplo.)', enDias(8));
      const m2 = m.run(clase.id, '[EJEMPLO] Programación I', 'Ing. Ejemplo', '#10b981').lastInsertRowid;
      t.run(m2, '[EJEMPLO] Proyecto: Calculadora en Python', 'Calculadora con menú (suma, resta, multiplicación, división). Subir a la plataforma. (Dato de ejemplo.)', enDias(5));
      t.run(m2, '[EJEMPLO] Lectura: Estructuras de control', 'Leer el capítulo 4 y hacer un resumen de una página. (Dato de ejemplo.)', enDias(-1));
    });
    tx();
  }
  setMeta('seed', '1');
  console.log(`Clase de ejemplo creada (solo porque SEED=true). Código: ${clase.codigo}`);
}

ensureDemo();

module.exports = db;
