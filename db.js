// Base de datos SQLite (archivo en DATA_DIR o ./data)
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, 'clase.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#6366f1',
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS materias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  docente TEXT DEFAULT '',
  color TEXT DEFAULT '#6366f1',
  ejemplo INTEGER NOT NULL DEFAULT 0,
  creado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tareas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  descripcion TEXT DEFAULT '',
  fecha_entrega TEXT,
  ejemplo INTEGER NOT NULL DEFAULT 0,
  creado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS estados (
  tarea_id INTEGER NOT NULL REFERENCES tareas(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  hecho INTEGER NOT NULL DEFAULT 0,
  ayuda INTEGER NOT NULL DEFAULT 0,
  actualizado TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tarea_id, usuario_id)
);
CREATE TABLE IF NOT EXISTS mensajes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tarea_id INTEGER REFERENCES tareas(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  texto TEXT NOT NULL,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mensajes_tarea ON mensajes(tarea_id, id);
CREATE TABLE IF NOT EXISTS meta (clave TEXT PRIMARY KEY, valor TEXT);
`);

// Datos de ejemplo (solo la primera vez). Desactivar con SEED=false
const sembrado = db.prepare("SELECT valor FROM meta WHERE clave = 'seed'").get();
if (!sembrado && process.env.SEED !== 'false') {
  const enDias = d => { const f = new Date(); f.setDate(f.getDate() + d); return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`; };
  const tx = db.transaction(() => {
    const m = db.prepare('INSERT INTO materias (nombre, docente, color, ejemplo) VALUES (?, ?, ?, 1)');
    const t = db.prepare('INSERT INTO tareas (materia_id, titulo, descripcion, fecha_entrega, ejemplo) VALUES (?, ?, ?, ?, 1)');
    const m1 = m.run('[EJEMPLO] Cálculo I', 'Lic. Ejemplo', '#6366f1').lastInsertRowid;
    t.run(m1, '[EJEMPLO] Práctica 3: Límites', 'Resolver los ejercicios 1 al 15 de la guía. (Dato de ejemplo: puedes editarlo o eliminarlo.)', enDias(3));
    t.run(m1, '[EJEMPLO] Derivadas por definición', 'Ejercicios impares de la sección 2.1. (Dato de ejemplo.)', enDias(8));
    const m2 = m.run('[EJEMPLO] Programación I', 'Ing. Ejemplo', '#10b981').lastInsertRowid;
    t.run(m2, '[EJEMPLO] Proyecto: Calculadora en Python', 'Calculadora con menú (suma, resta, multiplicación, división). Subir a la plataforma. (Dato de ejemplo.)', enDias(5));
    t.run(m2, '[EJEMPLO] Lectura: Estructuras de control', 'Leer el capítulo 4 y hacer un resumen de una página. (Dato de ejemplo.)', enDias(-1));
    db.prepare("INSERT INTO meta (clave, valor) VALUES ('seed', '1')").run();
  });
  tx();
  console.log('Datos de ejemplo creados (materias marcadas con [EJEMPLO]).');
}

module.exports = db;
