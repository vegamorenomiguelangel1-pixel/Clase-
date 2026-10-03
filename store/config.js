// Elige Firestore solo si hay credenciales. Si no, la app sigue en SQLite.
function parsearCuenta(raw) {
  const texto = String(raw || '').trim();
  if (!texto) return null;
  try {
    const json = JSON.parse(texto);
    if (!json || typeof json !== 'object' || !json.client_email || !json.private_key) {
      throw new Error('faltan client_email o private_key');
    }
    return json;
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT no es un JSON de cuenta de servicio válido (' + e.message + ').');
    console.error('No se arranca, para no guardar en SQLite por equivocación.');
    process.exit(1);
  }
}

function elegir() {
  const serviceAccount = parsearCuenta(process.env.FIREBASE_SERVICE_ACCOUNT);
  const archivo = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  const emulator = String(process.env.FIRESTORE_EMULATOR_HOST || '').trim();
  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim() || (serviceAccount && serviceAccount.project_id) || '';
  const hayCredencial = !!(serviceAccount || archivo);

  if ((hayCredencial || emulator) && projectId) {
    return { tipo: 'firestore', projectId, serviceAccount, archivo, emulator };
  }
  if (hayCredencial || emulator) {
    console.warn('[aviso] Hay datos de Firebase pero falta FIREBASE_PROJECT_ID (o project_id dentro del JSON). Se usa SQLite.');
  }
  return { tipo: 'sqlite' };
}

module.exports = { elegir };
