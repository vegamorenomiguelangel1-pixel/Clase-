// Almacén Firestore. Cada clase es classes/{id} con subcolecciones propias.
// La cuenta de servicio (Admin SDK) es el único acceso; las reglas del cliente deben negarlo.
const crypto = require('crypto');
const { initializeApp, cert, applicationDefault, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { COLORES, http, generarCodigo, ahora, publicar } = require('./comun');

let firestore;

function claseRef(id) {
  return firestore.collection('classes').doc(String(id));
}

function mapUsuario(id, data) {
  return { id, nombre: data.nombre, color: data.color };
}

function mapClase(id, data) {
  return {
    id,
    nombre: data.nombre,
    codigo: data.codigo,
    creador_id: data.creador_id ?? null,
    demo: data.demo ? 1 : 0,
  };
}

async function leerClase(id) {
  const snap = await claseRef(id).get();
  if (!snap.exists) return null;
  return mapClase(snap.id, snap.data());
}

async function sesionDe(usuario, clase) {
  const token = crypto.randomBytes(24).toString('hex');
  await firestore.collection('sessions').doc(token).set({
    usuario_id: usuario.id,
    clase_id: clase.id,
    creado: ahora(),
  });
  const pub = publicar(usuario, clase);
  return { token, usuario: pub, clase: pub.clase };
}

async function asegurarUsuario(claseId, nombre) {
  const norm = nombre.trim().toLowerCase();
  const col = claseRef(claseId).collection('users');
  const n = (await col.get()).size;
  const color = COLORES[n % COLORES.length];
  let resultado;
  await firestore.runTransaction(async tx => {
    const q = await tx.get(col.where('nombre_norm', '==', norm).limit(1));
    if (!q.empty) {
      const d = q.docs[0];
      resultado = { usuario: mapUsuario(d.id, d.data()), nuevo: false };
      return;
    }
    const ref = col.doc();
    const data = { nombre, nombre_norm: norm, color, creado: ahora() };
    tx.set(ref, data);
    resultado = { usuario: mapUsuario(ref.id, data), nuevo: true };
  });
  return resultado;
}

function ordenTareas(a, b) {
  const va = a.fecha_entrega || '';
  const vb = b.fecha_entrega || '';
  if (!va && vb) return 1;
  if (va && !vb) return -1;
  if (va !== vb) return va < vb ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : 1;
}

async function borrarRefs(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = firestore.batch();
    refs.slice(i, i + 400).forEach(r => batch.delete(r));
    await batch.commit();
  }
}

async function contexto(claseId) {
  const base = claseRef(claseId);
  const [usersSnap, matSnap, tarSnap, estSnap, msgSnap] = await Promise.all([
    base.collection('users').get(),
    base.collection('materias').get(),
    base.collection('tareas').get(),
    base.collection('statuses').get(),
    base.collection('messages').get(),
  ]);
  const users = new Map(usersSnap.docs.map(d => [d.id, mapUsuario(d.id, d.data())]));
  const materias = matSnap.docs.map(d => ({
    id: d.id,
    clase_id: String(claseId),
    nombre: d.data().nombre,
    docente: d.data().docente || '',
    color: d.data().color || '#6366f1',
    ejemplo: d.data().ejemplo || 0,
    creado_por: d.data().creado_por ?? null,
    creado: d.data().creado || '',
  }));
  const tareas = tarSnap.docs.map(d => ({
    id: d.id,
    materia_id: d.data().materia_id,
    titulo: d.data().titulo,
    descripcion: d.data().descripcion || '',
    fecha_entrega: d.data().fecha_entrega || null,
    ejemplo: d.data().ejemplo || 0,
    creado_por: d.data().creado_por ?? null,
    creado: d.data().creado || '',
  }));
  const statuses = estSnap.docs.map(d => ({ ...d.data(), id: d.id }));
  const messages = msgSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  return { claseId: String(claseId), users, materias, tareas, statuses, messages };
}

function armarTarea(t, ctx) {
  const materia = ctx.materias.find(m => m.id === t.materia_id);
  if (!materia) return null;
  const est = ctx.statuses
    .filter(e => e.tarea_id === t.id && (e.hecho || e.ayuda))
    .sort((a, b) => String(a.actualizado || '').localeCompare(String(b.actualizado || '')));
  const persona = e => {
    const u = ctx.users.get(e.usuario_id);
    return u ? { usuario_id: u.id, nombre: u.nombre, color: u.color } : null;
  };
  const hechos = est.filter(e => e.hecho).map(persona).filter(Boolean);
  const ayuda = est.filter(e => e.ayuda).map(persona).filter(Boolean);
  const creador = t.creado_por ? ctx.users.get(t.creado_por) : null;
  return {
    ...t,
    materia_nombre: materia.nombre,
    materia_color: materia.color,
    clase_id: ctx.claseId,
    creador: creador ? creador.nombre : null,
    num_mensajes: ctx.messages.filter(m => m.tarea_id === t.id).length,
    hechos,
    ayuda,
    total_estudiantes: ctx.users.size,
  };
}

function resumirMaterias(ctx, usuarioId) {
  return ctx.materias
    .map(m => {
      const tareas = ctx.tareas.filter(t => t.materia_id === m.id);
      const mis = tareas.filter(t => ctx.statuses.some(e => e.tarea_id === t.id && e.usuario_id === usuarioId && e.hecho)).length;
      const ayuda = ctx.statuses.filter(e => e.ayuda && tareas.some(t => t.id === e.tarea_id)).length;
      const creador = m.creado_por ? ctx.users.get(m.creado_por) : null;
      return { ...m, creador: creador ? creador.nombre : null, total_tareas: tareas.length, mis_hechas: mis, pedidos_ayuda: ayuda };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
}

function mensajePlano(id, data, usuario) {
  return {
    id,
    tarea_id: data.tarea_id ?? null,
    texto: data.texto,
    creado: data.creado,
    clase_id: data.clase_id,
    usuario_id: usuario.id,
    nombre: usuario.nombre,
    color: usuario.color,
  };
}

async function sembrarDemo() {
  if (process.env.SEED !== 'true') return;
  const meta = firestore.collection('meta').doc('seed');
  if ((await meta.get()).exists) return;

  let codigo = String(process.env.CLASS_CODE || '').trim().toUpperCase();
  let claseId = null;
  if (codigo && !codigo.includes('/')) {
    const codeSnap = await firestore.collection('codigos').doc(codigo).get();
    if (codeSnap.exists) {
      const existente = await leerClase(codeSnap.data().clase_id);
      if (existente && existente.demo) claseId = existente.id;
      else codigo = '';
    }
  } else codigo = '';

  if (!claseId) {
    for (let i = 0; i < 8 && !claseId; i++) {
      if (!codigo) codigo = generarCodigo();
      const codeRef = firestore.collection('codigos').doc(codigo);
      const clase = firestore.collection('classes').doc();
      try {
        await firestore.runTransaction(async tx => {
          if ((await tx.get(codeRef)).exists) throw new Error('COLISION');
          tx.set(codeRef, { clase_id: clase.id });
          tx.set(clase, { nombre: 'Clase de ejemplo', codigo, creador_id: null, demo: 1, creado: ahora() });
        });
        claseId = clase.id;
      } catch (e) {
        if (!/COLISION/.test(String(e.message))) throw e;
        codigo = '';
      }
    }
  }
  if (!claseId) throw new Error('No se pudo crear la clase de ejemplo.');

  const base = claseRef(claseId);
  if (!(await base.collection('materias').limit(1).get()).empty) {
    await meta.set({ valor: '1' });
    return;
  }
  const enDias = d => {
    const f = new Date(); f.setDate(f.getDate() + d);
    return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
  };
  const batch = firestore.batch();
  const m1 = base.collection('materias').doc();
  const m2 = base.collection('materias').doc();
  batch.set(m1, { nombre: '[EJEMPLO] Cálculo I', docente: 'Lic. Ejemplo', color: '#6366f1', ejemplo: 1, creado_por: null, creado: ahora() });
  batch.set(m2, { nombre: '[EJEMPLO] Programación I', docente: 'Ing. Ejemplo', color: '#10b981', ejemplo: 1, creado_por: null, creado: ahora() });
  const tareas = [
    [m1.id, '[EJEMPLO] Práctica 3: Límites', 'Resolver los ejercicios 1 al 15 de la guía. (Dato de ejemplo: puedes editarlo o eliminarlo.)', enDias(3)],
    [m1.id, '[EJEMPLO] Derivadas por definición', 'Ejercicios impares de la sección 2.1. (Dato de ejemplo.)', enDias(8)],
    [m2.id, '[EJEMPLO] Proyecto: Calculadora en Python', 'Calculadora con menú (suma, resta, multiplicación, división). Subir a la plataforma. (Dato de ejemplo.)', enDias(5)],
    [m2.id, '[EJEMPLO] Lectura: Estructuras de control', 'Leer el capítulo 4 y hacer un resumen de una página. (Dato de ejemplo.)', enDias(-1)],
  ];
  for (const [materiaId, titulo, descripcion, fecha] of tareas) {
    batch.set(base.collection('tareas').doc(), {
      materia_id: materiaId, titulo, descripcion, fecha_entrega: fecha, ejemplo: 1, creado_por: null, creado: ahora(),
    });
  }
  batch.set(meta, { valor: '1' });
  await batch.commit();
  console.log(`Clase de ejemplo creada en Firestore (solo porque SEED=true). Código: ${codigo}`);
}

async function abrir(modo) {
  if (!getApps().length) {
    const opts = { projectId: modo.projectId };
    if (modo.serviceAccount) opts.credential = cert(modo.serviceAccount);
    else if (modo.archivo) opts.credential = applicationDefault();
    initializeApp(opts);
  }
  firestore = getFirestore();
  firestore.settings({ ignoreUndefinedProperties: true });
  await firestore.collection('meta').doc('seed').get();
  await sembrarDemo();

  return {
    driver: 'firestore',

    async crearClase({ nombreClase, nombreUsuario }) {
      for (let i = 0; i < 8; i++) {
        const codigo = generarCodigo();
        const codeRef = firestore.collection('codigos').doc(codigo);
        const clase = firestore.collection('classes').doc();
        const userRef = clase.collection('users').doc();
        const user = { nombre: nombreUsuario, nombre_norm: nombreUsuario.trim().toLowerCase(), color: COLORES[0], creado: ahora() };
        try {
          await firestore.runTransaction(async tx => {
            if ((await tx.get(codeRef)).exists) throw new Error('COLISION');
            tx.set(codeRef, { clase_id: clase.id });
            tx.set(clase, { nombre: nombreClase, codigo, creador_id: userRef.id, demo: 0, creado: ahora() });
            tx.set(userRef, user);
          });
          const claseObj = { id: clase.id, nombre: nombreClase, codigo, creador_id: userRef.id };
          return sesionDe({ id: userRef.id, ...user }, claseObj);
        } catch (e) {
          if (!/COLISION/.test(String(e.message))) throw e;
        }
      }
      throw new Error('No se pudo generar un código. Intenta de nuevo.');
    },

    async unirse({ codigo, nombre }) {
      const codeSnap = await firestore.collection('codigos').doc(codigo).get();
      if (!codeSnap.exists) return null;
      const clase = await leerClase(codeSnap.data().clase_id);
      if (!clase) return null;
      const { usuario, nuevo } = await asegurarUsuario(clase.id, nombre);
      const sesion = await sesionDe(usuario, clase);
      return { ...sesion, nuevo };
    },

    async usuarioPorToken(token) {
      if (!token) return null;
      const ses = await firestore.collection('sessions').doc(token).get();
      if (!ses.exists) return null;
      const { usuario_id, clase_id } = ses.data();
      const clase = await leerClase(clase_id);
      if (!clase) return null;
      const userSnap = await claseRef(clase.id).collection('users').doc(String(usuario_id)).get();
      if (!userSnap.exists) return null;
      return publicar(mapUsuario(userSnap.id, userSnap.data()), clase);
    },

    async cerrarSesion(token) {
      await firestore.collection('sessions').doc(token).delete();
    },

    async listarUsuarios(claseId) {
      const snap = await claseRef(claseId).collection('users').get();
      return snap.docs
        .map(d => mapUsuario(d.id, d.data()))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
    },

    async actualizarClase(claseId, usuarioId, { nombre, regenerar }) {
      const ref = claseRef(claseId);
      for (let i = 0; i < 8; i++) {
        const codigoNuevo = regenerar ? generarCodigo() : null;
        try {
          return await firestore.runTransaction(async tx => {
            const snap = await tx.get(ref);
            if (!snap.exists) throw http(404, 'Clase no encontrada.');
            const data = snap.data();
            if (data.creador_id !== usuarioId) throw http(403, 'Solo quien creó la clase puede cambiarla.');
            const nuevoNombre = nombre == null ? data.nombre : nombre;
            let codigo = data.codigo;
            if (regenerar) {
              const nuevoRef = firestore.collection('codigos').doc(codigoNuevo);
              if ((await tx.get(nuevoRef)).exists) throw new Error('COLISION');
              tx.delete(firestore.collection('codigos').doc(data.codigo));
              tx.set(nuevoRef, { clase_id: snap.id });
              codigo = codigoNuevo;
            }
            tx.update(ref, { nombre: nuevoNombre, codigo });
            return { id: snap.id, nombre: nuevoNombre, codigo };
          });
        } catch (e) {
          if (e.status) throw e;
          if (!/COLISION/.test(String(e.message))) throw e;
        }
      }
      throw new Error('No se pudo generar un código. Intenta de nuevo.');
    },

    async listarMaterias(claseId, usuarioId) {
      return resumirMaterias(await contexto(claseId), usuarioId);
    },

    async crearMateria(claseId, usuarioId, { nombre, docente, color }) {
      const ref = claseRef(claseId).collection('materias').doc();
      const data = { nombre, docente, color, ejemplo: 0, creado_por: usuarioId, creado: ahora() };
      await ref.set(data);
      return { id: ref.id, clase_id: String(claseId), ...data };
    },

    async actualizarMateria(claseId, materiaId, { nombre, docente, color }) {
      const ref = claseRef(claseId).collection('materias').doc(String(materiaId));
      const snap = await ref.get();
      if (!snap.exists) return null;
      await ref.update({ nombre, docente, color });
      return { id: snap.id, clase_id: String(claseId), ...snap.data(), nombre, docente, color };
    },

    async eliminarMateria(claseId, materiaId) {
      const base = claseRef(claseId);
      const ref = base.collection('materias').doc(String(materiaId));
      if (!(await ref.get()).exists) return false;
      const tareas = await base.collection('tareas').where('materia_id', '==', String(materiaId)).get();
      const borrar = [ref];
      for (const t of tareas.docs) {
        borrar.push(t.ref);
        const [est, msgs] = await Promise.all([
          base.collection('statuses').where('tarea_id', '==', t.id).get(),
          base.collection('messages').where('tarea_id', '==', t.id).get(),
        ]);
        est.docs.forEach(d => borrar.push(d.ref));
        msgs.docs.forEach(d => borrar.push(d.ref));
      }
      await borrarRefs(borrar);
      return true;
    },

    async obtenerMateria(claseId, materiaId) {
      const ctx = await contexto(claseId);
      const m = ctx.materias.find(x => x.id === String(materiaId));
      if (!m) return null;
      m.tareas = ctx.tareas.filter(t => t.materia_id === m.id).sort(ordenTareas).map(t => armarTarea(t, ctx));
      return m;
    },

    async listarTareas(claseId) {
      const ctx = await contexto(claseId);
      return ctx.tareas.slice().sort(ordenTareas).map(t => armarTarea(t, ctx)).filter(Boolean);
    },

    async obtenerTarea(claseId, tareaId) {
      const ctx = await contexto(claseId);
      const t = ctx.tareas.find(x => x.id === String(tareaId));
      if (!t) return null;
      return armarTarea(t, ctx);
    },

    async crearTarea(claseId, materiaId, usuarioId, { titulo, descripcion, fecha }) {
      const base = claseRef(claseId);
      const materia = await base.collection('materias').doc(String(materiaId)).get();
      if (!materia.exists) return null;
      const ref = base.collection('tareas').doc();
      await ref.set({
        materia_id: materia.id,
        titulo,
        descripcion,
        fecha_entrega: fecha || null,
        ejemplo: 0,
        creado_por: usuarioId,
        creado: ahora(),
      });
      return this.obtenerTarea(claseId, ref.id);
    },

    async actualizarTarea(claseId, tareaId, { titulo, descripcion, fecha }) {
      const ref = claseRef(claseId).collection('tareas').doc(String(tareaId));
      if (!(await ref.get()).exists) return null;
      await ref.update({ titulo, descripcion, fecha_entrega: fecha || null });
      return this.obtenerTarea(claseId, tareaId);
    },

    async eliminarTarea(claseId, tareaId) {
      const base = claseRef(claseId);
      const ref = base.collection('tareas').doc(String(tareaId));
      const snap = await ref.get();
      if (!snap.exists) return null;
      const [est, msgs] = await Promise.all([
        base.collection('statuses').where('tarea_id', '==', ref.id).get(),
        base.collection('messages').where('tarea_id', '==', ref.id).get(),
      ]);
      await borrarRefs([ref, ...est.docs.map(d => d.ref), ...msgs.docs.map(d => d.ref)]);
      return { id: ref.id, materia_id: snap.data().materia_id };
    },

    async marcarEstado(claseId, tareaId, usuarioId, body) {
      const base = claseRef(claseId);
      const tarea = await base.collection('tareas').doc(String(tareaId)).get();
      if (!tarea.exists) return null;
      const ref = base.collection('statuses').doc(`${tarea.id}_${usuarioId}`);
      await firestore.runTransaction(async tx => {
        const prevSnap = await tx.get(ref);
        const prev = prevSnap.exists ? prevSnap.data() : { hecho: 0, ayuda: 0 };
        let hecho = body.hecho === undefined ? prev.hecho : (body.hecho ? 1 : 0);
        let ayuda = body.ayuda === undefined ? prev.ayuda : (body.ayuda ? 1 : 0);
        if (body.hecho && hecho) ayuda = 0;
        tx.set(ref, { tarea_id: tarea.id, usuario_id: usuarioId, hecho, ayuda, actualizado: ahora() });
      });
      return this.obtenerTarea(claseId, tarea.id);
    },

    async listarMensajes(claseId, tareaId) {
      const base = claseRef(claseId);
      if (tareaId && !(await base.collection('tareas').doc(String(tareaId)).get()).exists) {
        throw http(404, 'Tarea no encontrada.');
      }
      const snap = await base.collection('messages').get();
      const users = new Map((await base.collection('users').get()).docs.map(d => [d.id, mapUsuario(d.id, d.data())]));
      return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(m => tareaId ? m.tarea_id === String(tareaId) : m.tarea_id == null)
        .sort((a, b) => String(a.creado).localeCompare(String(b.creado)) || String(a.id).localeCompare(String(b.id)))
        .slice(-200)
        .map(m => mensajePlano(m.id, m, users.get(m.usuario_id) || { id: m.usuario_id, nombre: '?', color: '#6366f1' }));
    },

    async crearMensaje(usuario, tareaId, texto) {
      const base = claseRef(usuario.clase_id);
      if (tareaId && !(await base.collection('tareas').doc(String(tareaId)).get()).exists) {
        throw http(404, 'Tarea no encontrada.');
      }
      const ref = base.collection('messages').doc();
      const data = {
        tarea_id: tareaId ? String(tareaId) : null,
        usuario_id: usuario.id,
        texto,
        creado: ahora(),
        clase_id: String(usuario.clase_id),
      };
      await ref.set(data);
      return mensajePlano(ref.id, data, usuario);
    },
  };
}

module.exports = { abrir };
