// Punto único de datos: Firestore si hay credenciales, SQLite si no.
const { elegir } = require('./config');

function abrir() {
  const modo = elegir();
  if (modo.tipo === 'firestore') {
    const donde = modo.emulator ? `emulador ${modo.emulator}` : modo.projectId;
    console.log(`Almacén: Firestore (${donde})`);
    return require('./firestore').abrir(modo);
  }
  console.log('Almacén: SQLite');
  return Promise.resolve(require('./sqlite').abrir());
}

module.exports = abrir();
