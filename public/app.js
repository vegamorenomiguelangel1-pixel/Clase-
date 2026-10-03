/* Clase App — frontend (JS puro, sin compilación) */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLORES = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#ef4444', '#0ea5e9', '#f97316', '#64748b'];

  let token = localStorage.getItem('clase_token');
  let yo = JSON.parse(localStorage.getItem('clase_usuario') || 'null');
  let socket = null;
  let conectados = [];
  let usuarios = [];
  let noLeidos = 0;
  let filtroTareas = 'pendientes';
  let rutaActual = {};

  // ---------- Utilidades ----------
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/api/login' && url !== '/api/clases') { salir(); throw new Error(data.error || 'Sesión expirada'); }
    if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
    return data;
  }
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  const iniciales = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();
  const avatar = (u, cls = '') => `<span class="av ${cls}" style="background:${esc(u.color)}" title="${esc(u.nombre)}">${esc(iniciales(u.nombre))}</span>`;
  function fechaInfo(f) {
    if (!f) return { txt: 'Sin fecha', cls: '' };
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const d = new Date(f.slice(0, 10) + 'T00:00:00');
    const dias = Math.round((d - hoy) / 86400000);
    const bonita = d.toLocaleDateString('es-BO', { weekday: 'short', day: 'numeric', month: 'short' });
    if (dias < 0) return { txt: `Venció ${bonita}`, cls: 'late', dias };
    if (dias === 0) return { txt: 'Vence HOY', cls: 'late', dias };
    if (dias === 1) return { txt: 'Vence mañana', cls: 'warn', dias };
    if (dias <= 3) return { txt: `En ${dias} días · ${bonita}`, cls: 'warn', dias };
    return { txt: `📅 ${bonita}`, cls: '', dias };
  }
  function hora(iso) {
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    const hoy = new Date().toDateString() === d.toDateString();
    return hoy ? d.toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString('es-BO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  const mismoId = (a, b) => String(a) === String(b);
  const yaHice = t => t.hechos.some(h => h.usuario_id === yo.id);
  const pidoAyuda = t => t.ayuda.some(h => h.usuario_id === yo.id);

  // ---------- Login ----------
  function modoLogin(crear) {
    $('#tabCreate').classList.toggle('on', crear);
    $('#tabJoin').classList.toggle('on', !crear);
    $('#createForm').classList.toggle('hidden', !crear);
    $('#joinForm').classList.toggle('hidden', crear);
  }
  $('#tabJoin').onclick = () => modoLogin(false);
  $('#tabCreate').onclick = () => modoLogin(true);

  function guardarSesion(r) {
    token = r.token; yo = r.usuario;
    localStorage.setItem('clase_token', token);
    localStorage.setItem('clase_usuario', JSON.stringify(yo));
    localStorage.setItem('clase_ultimo_nombre', yo.nombre);
  }
  async function copiarTexto(texto) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(texto);
      else throw new Error('sin clipboard');
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = texto; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove();
        return ok;
      } catch { return false; }
    }
  }
  function textoInvitacion() {
    return `Únete a la clase "${yo.clase.nombre}" en Clase App. Código: ${yo.clase.codigo}`;
  }
  async function compartirClase() {
    const texto = textoInvitacion();
    if (navigator.share) {
      try { await navigator.share({ title: yo.clase.nombre, text: texto }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const ok = await copiarTexto(texto);
    toast(ok ? 'Invitación copiada' : 'No se pudo copiar');
  }
  function mostrarCodigoCreado() {
    $('#login').classList.add('hidden');
    $('#creada').classList.remove('hidden');
    $('#creadaNombre').textContent = yo.clase.nombre;
    $('#bigCode').textContent = yo.clase.codigo;
  }
  function mostrarLogin() {
    $('#app').classList.add('hidden');
    $('#creada').classList.add('hidden');
    $('#classbar').classList.add('hidden');
    $('#login').classList.remove('hidden');
    document.title = 'Clase App · Materias, tareas y chat';
    const ult = localStorage.getItem('clase_ultimo_nombre');
    if (ult) document.querySelectorAll('#login input[name="nombre"]').forEach(i => { if (!i.value) i.value = ult; });
  }
  $('#joinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target; $('#joinError').textContent = '';
    try {
      const r = await api('/api/login', { method: 'POST', body: { nombre: f.nombre.value, codigo: f.codigo.value } });
      guardarSesion(r);
      f.codigo.value = '';
      iniciar();
    } catch (err) { $('#joinError').textContent = err.message; }
  });
  $('#createForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target; $('#createError').textContent = '';
    try {
      const r = await api('/api/clases', { method: 'POST', body: { nombre: f.nombre.value, clase: f.clase.value } });
      guardarSesion(r);
      f.clase.value = '';
      mostrarCodigoCreado();
    } catch (err) { $('#createError').textContent = err.message; }
  });
  $('#copyBig').onclick = async () => {
    const ok = await copiarTexto(yo.clase.codigo);
    toast(ok ? 'Código copiado' : 'No se pudo copiar');
  };
  $('#shareBig').onclick = compartirClase;
  $('#enterClass').onclick = () => { $('#creada').classList.add('hidden'); iniciar(); };
  function salir() {
    if (token) fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
    token = null; yo = null; localStorage.removeItem('clase_token'); localStorage.removeItem('clase_usuario');
    if (socket) { socket.disconnect(); socket = null; }
    mostrarLogin();
  }
  $('#logoutBtn').addEventListener('click', salir);
  $('#switchClass').addEventListener('click', salir);

  // ---------- Inicio ----------
  async function iniciar() {
    try { yo = await api('/api/me'); } catch { return; }
    $('#login').classList.add('hidden'); $('#creada').classList.add('hidden'); $('#app').classList.remove('hidden');
    pintarClase();
    $('#meAvatar').innerHTML = avatar(yo);
    usuarios = await api('/api/usuarios');
    conectarSocket();
    if (!location.hash) location.hash = '#/';
    router();
  }

  function conectarSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });
    socket.on('connect_error', err => { if (err.message === 'no autorizado') salir(); });
    socket.on('presencia', ids => {
      conectados = ids;
      $('#onlineCount').textContent = `● ${ids.length} en línea`;
      document.querySelectorAll('[data-dot]').forEach(d => d.classList.toggle('on', ids.some(id => mismoId(id, d.dataset.dot))));
    });
    socket.on('usuarios:cambio', async () => { usuarios = await api('/api/usuarios'); if (rutaActual.vista === 'chat') pintarConectados(); if (rutaActual.vista === 'materias') router(true); });
    socket.on('clase:cambio', clase => {
      if (!yo?.clase) return;
      const cambio = yo.clase.nombre !== clase.nombre || yo.clase.codigo !== clase.codigo;
      yo.clase = { ...yo.clase, ...clase };
      localStorage.setItem('clase_usuario', JSON.stringify(yo));
      pintarClase();
      if (cambio) toast('Se actualizó el nombre o el código de la clase');
    });
    socket.on('datos:cambio', ev => {
      const r = rutaActual;
      if (ev.eliminado && r.vista === 'materia' && ev.tipo === 'materia' && mismoId(r.id, ev.id)) { toast('Esta materia fue eliminada'); location.hash = '#/'; return; }
      if (ev.eliminado && r.vista === 'tarea' && ev.tipo === 'tarea' && mismoId(r.id, ev.id)) { toast('Esta tarea fue eliminada'); location.hash = '#/materia/' + encodeURIComponent(ev.materia_id); return; }
      if (r.vista === 'tarea') { if (mismoId(ev.id, r.id)) cargarInfoTarea(); return; }
      if (r.vista !== 'chat') router(true);
    });
    socket.on('estado:cambio', ({ tarea, por }) => {
      if (por.id !== yo.id) {
        if (tarea.ayuda.some(a => a.usuario_id === por.id) && !tarea.hechos.some(a => a.usuario_id === por.id))
          toast(`🙋 ${por.nombre} pide ayuda en "${tarea.titulo}"`);
      }
      actualizarTareaEnPantalla(tarea);
    });
    socket.on('chat:nuevo', msg => {
      const r = rutaActual;
      const sala = msg.tarea_id || null;
      const abierta = (r.vista === 'chat' && sala === null) || (r.vista === 'tarea' && mismoId(sala, r.id));
      if (abierta) agregarMensaje(msg);
      else if (sala === null && msg.usuario_id !== yo.id) { noLeidos++; pintarBadge(); }
      if (r.vista === 'tarea' && mismoId(sala, r.id)) $('#escribiendo') && ($('#escribiendo').textContent = '');
    });
    socket.on('escribiendo', ({ usuario, tarea_id }) => {
      const r = rutaActual; const el = $('#escribiendo'); if (!el) return;
      if ((r.vista === 'chat' && !tarea_id) || (r.vista === 'tarea' && mismoId(tarea_id, r.id))) {
        el.textContent = `${usuario.nombre} está escribiendo…`;
        clearTimeout(el._t); el._t = setTimeout(() => (el.textContent = ''), 2500);
      }
    });
  }
  function pintarClase() {
    if (!yo?.clase) return;
    $('#classbar').classList.remove('hidden');
    $('#className').textContent = yo.clase.nombre;
    $('#classCode').textContent = yo.clase.codigo;
    $('#classSettings').classList.toggle('hidden', !yo.es_creador);
    document.title = `${yo.clase.nombre} · Clase App`;
  }
  $('#copyCode').onclick = async () => {
    if (!yo?.clase) return;
    const ok = await copiarTexto(yo.clase.codigo);
    const label = $('#copyCode .copy-label');
    if (ok) { label.textContent = 'Copiado'; setTimeout(() => { label.textContent = 'Copiar'; }, 1600); }
    toast(ok ? 'Código copiado' : 'No se pudo copiar');
  };
  $('#shareCode').onclick = compartirClase;
  $('#classSettings').onclick = () => {
    if (!yo?.es_creador) return;
    abrirModal('Ajustes de la clase', `
      <label>Nombre de la clase
        <input name="nombre" required minlength="2" maxlength="80" value="${esc(yo.clase.nombre)}">
      </label>
      <p class="muted">Código actual: <strong>${esc(yo.clase.codigo)}</strong></p>
      <label class="checkline"><input type="checkbox" name="regenerar"> Generar un código nuevo (el anterior dejará de funcionar)</label>`,
      async f => {
        if (f.regenerar.checked && !confirm('El código actual dejará de funcionar. Quien aún no haya entrado necesitará el nuevo. ¿Continuar?')) return false;
        const body = { nombre: f.nombre.value };
        if (f.regenerar.checked) body.regenerar = true;
        const clase = await api('/api/clase', { method: 'PUT', body });
        yo.clase = { ...yo.clase, ...clase };
        localStorage.setItem('clase_usuario', JSON.stringify(yo));
        pintarClase();
        toast(body.regenerar ? 'Código nuevo: ' + clase.codigo : 'Nombre actualizado');
      });
  };
  function pintarBadge() {
    ['#chatBadge', '#chatBadge2'].forEach(s => { const b = $(s); b.textContent = noLeidos; b.classList.toggle('hidden', !noLeidos); });
  }

  // ---------- Router ----------
  window.addEventListener('hashchange', () => router());
  async function router(silencioso) {
    if (!token) return mostrarLogin();
    const h = location.hash.replace(/^#/, '') || '/';
    let m;
    const idRuta = s => { const d = decodeURIComponent(s); return /^\d+$/.test(d) ? Number(d) : d; };
    if ((m = h.match(/^\/materia\/([^/?#]+)/))) rutaActual = { vista: 'materia', id: idRuta(m[1]) };
    else if ((m = h.match(/^\/tarea\/([^/?#]+)/))) rutaActual = { vista: 'tarea', id: idRuta(m[1]) };
    else if (h.startsWith('/tareas')) rutaActual = { vista: 'tareas' };
    else if (h.startsWith('/chat')) rutaActual = { vista: 'chat' };
    else rutaActual = { vista: 'materias' };
    const tab = { materias: 'materias', materia: 'materias', tarea: 'tareas', tareas: 'tareas', chat: 'chat' }[rutaActual.vista];
    document.querySelectorAll('[data-tab]').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
    if (!silencioso) window.scrollTo(0, 0);
    try {
      if (rutaActual.vista === 'materias') await vistaMaterias();
      else if (rutaActual.vista === 'materia') await vistaMateria(rutaActual.id);
      else if (rutaActual.vista === 'tareas') await vistaTareas();
      else if (rutaActual.vista === 'tarea') await vistaTarea(rutaActual.id);
      else if (rutaActual.vista === 'chat') await vistaChat();
    } catch (e) {
      $('#view').innerHTML = `<div class="empty"><div class="big">😕</div><p>${esc(e.message)}</p><a class="btn" href="#/">Volver al inicio</a></div>`;
    }
  }

  // ---------- Vista: Materias ----------
  function vacioMaterias() {
    if (yo.es_creador) {
      return `<div class="empty empty-hero">
        <div class="big">📘</div>
        <h2>Tu clase está vacía</h2>
        <p>Empieza de cero: no hay materias de ejemplo. Crea la primera para que el grupo tenga tareas, marcas y chat.</p>
        <ol class="steps">
          <li>Crea la primera materia (por ejemplo, Cálculo I o Programación).</li>
          <li>Agrégale tareas con fecha de entrega.</li>
          <li>Comparte el código <strong>${esc(yo.clase.codigo)}</strong> para que tus compañeros entren y marquen lo que ya hicieron.</li>
        </ol>
        <button class="btn primary" data-nueva-materia>＋ Crear la primera materia</button>
      </div>`;
    }
    return `<div class="empty empty-hero">
      <div class="big">📘</div>
      <h2>Todavía no hay materias</h2>
      <p>Esta clase empieza vacía. Cuando se cree la primera materia, todo el grupo la verá aquí. Si quieres, puedes empezar tú.</p>
      <button class="btn primary" data-nueva-materia>＋ Crear la primera materia</button>
    </div>`;
  }
  async function vistaMaterias() {
    const materias = await api('/api/materias');
    const personas = usuarios.length === 1 ? '1 persona en la clase' : `${usuarios.length} personas en la clase`;
    $('#view').innerHTML = `
      <div class="page-head">
        <div><h1>Materias</h1><div class="muted">Hola, ${esc(yo.nombre)} 👋 · ${personas}</div></div>
        ${materias.length ? '<button class="btn primary" data-nueva-materia>＋ Nueva materia</button>' : ''}
      </div>
      ${materias.length ? `<div class="grid">${materias.map(m => `
        <a class="card materia" href="#/materia/${encodeURIComponent(m.id)}" style="--c:${esc(m.color)}">
          <div class="actions">
            <button class="icon-btn" data-edit="${m.id}" title="Editar">✏️</button>
            <button class="icon-btn" data-del="${m.id}" title="Eliminar">🗑️</button>
          </div>
          <h3>${esc(m.nombre)}</h3>
          <div class="muted">${m.docente ? '👩‍🏫 ' + esc(m.docente) : '&nbsp;'}</div>
          <div class="stats">
            ${m.ejemplo ? '<span class="chip ex">Ejemplo</span>' : ''}
            <span class="chip">📝 ${m.total_tareas} tarea${m.total_tareas === 1 ? '' : 's'}</span>
            <span class="chip ${m.total_tareas && m.mis_hechas === m.total_tareas ? 'ok' : ''}">✅ Hice ${m.mis_hechas}/${m.total_tareas}</span>
            ${m.pedidos_ayuda ? `<span class="chip warn">🙋 ${m.pedidos_ayuda} ${m.pedidos_ayuda === 1 ? "pide" : "piden"} ayuda</span>` : ''}
          </div>
        </a>`).join('')}</div>`
      : vacioMaterias()}`;
    document.querySelectorAll('[data-nueva-materia]').forEach(b => b.onclick = () => formMateria());
    document.querySelectorAll('[data-edit]').forEach(b => b.onclick = e => { e.preventDefault(); formMateria(materias.find(m => m.id == b.dataset.edit)); });
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = e => { e.preventDefault(); borrarMateria(materias.find(m => m.id == b.dataset.del)); });
  }
  function formMateria(m) {
    const color = m?.color || COLORES[Math.floor(Math.random() * COLORES.length)];
    abrirModal(m ? 'Editar materia' : 'Nueva materia', `
      <label>Nombre de la materia<input name="nombre" required maxlength="80" value="${esc(m?.nombre || '')}" placeholder="Ej: Álgebra Lineal"></label>
      <label>Docente (opcional)<input name="docente" maxlength="80" value="${esc(m?.docente || '')}" placeholder="Ej: Lic. Pérez"></label>
      <label>Color<div class="colors">${COLORES.map(c => `<label><input type="radio" name="color" value="${c}" ${c === color ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div></label>`,
      async f => {
        const body = { nombre: f.nombre.value, docente: f.docente.value, color: f.color.value };
        if (m) await api('/api/materias/' + m.id, { method: 'PUT', body }); else await api('/api/materias', { method: 'POST', body });
        toast(m ? 'Materia actualizada' : 'Materia creada'); router(true);
      });
  }
  async function borrarMateria(m) {
    if (!confirm(`¿Eliminar la materia "${m.nombre}" y todas sus tareas? Esto lo verá toda la clase.`)) return;
    try { await api('/api/materias/' + m.id, { method: 'DELETE' }); toast('Materia eliminada'); if (rutaActual.vista !== 'materias') location.hash = '#/'; else router(true); }
    catch (e) { toast(e.message); }
  }

  // ---------- Tarjeta de tarea ----------
  function tarjetaTarea(t, conMateria) {
    const f = fechaInfo(t.fecha_entrega);
    const pct = t.total_estudiantes ? Math.round(t.hechos.length / t.total_estudiantes * 100) : 0;
    const hice = yaHice(t), ayuda = pidoAyuda(t);
    return `<div class="card tarea ${hice ? 'done' : ''}" data-tarea="${t.id}">
      <div class="top">
        <div>
          ${conMateria ? `<div class="crumbs"><span class="mat-dot" style="--c:${esc(t.materia_color)}"></span>${esc(t.materia_nombre)}</div>` : ''}
          <h3><a href="#/tarea/${encodeURIComponent(t.id)}">${esc(t.titulo)}</a></h3>
          <div class="row">
            <span class="chip ${hice ? '' : f.cls}">${f.txt}</span>
            ${t.ejemplo ? '<span class="chip ex">Ejemplo</span>' : ''}
            ${t.num_mensajes ? `<span class="chip">💬 ${t.num_mensajes}</span>` : ''}
          </div>
        </div>
        <div class="row" style="flex-wrap:nowrap">
          <button class="icon-btn" data-tedit="${t.id}" title="Editar">✏️</button>
          <button class="icon-btn" data-tdel="${t.id}" title="Eliminar">🗑️</button>
        </div>
      </div>
      ${t.descripcion ? `<div class="desc">${esc(t.descripcion.length > 220 ? t.descripcion.slice(0, 220) + '…' : t.descripcion)}</div>` : ''}
      <div class="progress"><div class="bar"><i style="width:${pct}%"></i></div><b>${t.hechos.length}/${t.total_estudiantes} la hicieron</b></div>
      <div class="avatars">${t.hechos.map(u => avatar(u)).join('') || '<span class="muted" style="font-size:.85rem">Nadie la marcó todavía</span>'}</div>
      ${t.ayuda.length ? `<div class="help-banner">🙋 Piden ayuda: <b>${t.ayuda.map(u => esc(u.nombre)).join(', ')}</b></div>` : ''}
      <div class="row" style="margin-top:.75rem">
        <button class="btn ok ${hice ? 'on' : ''}" data-hecho="${t.id}">${hice ? '✅ ¡La hice!' : '☐ Marcar como hecha'}</button>
        ${hice ? '' : `<button class="btn help ${ayuda ? 'on' : ''}" data-ayuda="${t.id}">${ayuda ? '🙋 Pediste ayuda' : '🙋 Necesito ayuda'}</button>`}
        <span class="spacer"></span>
        <a class="btn ghost small" href="#/tarea/${encodeURIComponent(t.id)}">Ver detalle →</a>
      </div>
    </div>`;
  }
  let tareasCache = new Map();
  const guardarTarea = t => { tareasCache.set(String(t.id), t); return t; };
  const tomarTarea = id => tareasCache.get(String(id));
  function enlazarTarjetas(root = document) {
    root.querySelectorAll('[data-hecho]').forEach(b => b.onclick = () => { const t = tomarTarea(b.dataset.hecho); if (t) marcar(t.id, { hecho: !yaHice(t) }); });
    root.querySelectorAll('[data-ayuda]').forEach(b => b.onclick = () => { const t = tomarTarea(b.dataset.ayuda); if (t) marcar(t.id, { ayuda: !pidoAyuda(t) }); });
    root.querySelectorAll('[data-tedit]').forEach(b => b.onclick = () => { const t = tomarTarea(b.dataset.tedit); if (t) formTarea(t.materia_id, t); });
    root.querySelectorAll('[data-tdel]').forEach(b => b.onclick = () => { const t = tomarTarea(b.dataset.tdel); if (t) borrarTarea(t); });
  }
  async function marcar(id, body) {
    try {
      const t = await api(`/api/tareas/${id}/estado`, { method: 'PUT', body });
      actualizarTareaEnPantalla(t);
      if (body.hecho) toast('¡Bien! Tus compañeros ya lo ven ✅');
      if (body.ayuda) toast('Tus compañeros verán que necesitas ayuda 🙋');
    } catch (e) { toast(e.message); }
  }
  function actualizarTareaEnPantalla(t) {
    guardarTarea(t);
    const el = document.querySelector(`[data-tarea="${t.id}"]`);
    if (el && rutaActual.vista !== 'tarea') {
      if (rutaActual.vista === 'tareas' && !pasaFiltro(t)) { el.remove(); return; }
      const tmp = document.createElement('div'); tmp.innerHTML = tarjetaTarea(t, rutaActual.vista === 'tareas');
      const nuevo = tmp.firstElementChild; el.replaceWith(nuevo); enlazarTarjetas(nuevo);
    }
    if (rutaActual.vista === 'tarea' && mismoId(rutaActual.id, t.id)) pintarInfoTarea(t);
  }
  function formTarea(materiaId, t) {
    abrirModal(t ? 'Editar tarea' : 'Nueva tarea', `
      <label>Título<input name="titulo" required maxlength="120" value="${esc(t?.titulo || '')}" placeholder="Ej: Práctica 4 – Matrices"></label>
      <label>Descripción<textarea name="descripcion" maxlength="4000" placeholder="¿Qué hay que hacer? Ejercicios, páginas, formato de entrega…">${esc(t?.descripcion || '')}</textarea></label>
      <label>Fecha de entrega<input type="date" name="fecha_entrega" value="${esc((t?.fecha_entrega || '').slice(0, 10))}"></label>`,
      async f => {
        const body = { titulo: f.titulo.value, descripcion: f.descripcion.value, fecha_entrega: f.fecha_entrega.value };
        if (t) await api('/api/tareas/' + t.id, { method: 'PUT', body }); else await api(`/api/materias/${materiaId}/tareas`, { method: 'POST', body });
        toast(t ? 'Tarea actualizada' : 'Tarea creada'); router(true);
      });
  }
  async function borrarTarea(t) {
    if (!confirm(`¿Eliminar la tarea "${t.titulo}"? Se borrarán también sus marcas y mensajes.`)) return;
    try { await api('/api/tareas/' + t.id, { method: 'DELETE' }); toast('Tarea eliminada'); if (rutaActual.vista === 'tarea') location.hash = '#/materia/' + encodeURIComponent(t.materia_id); else router(true); }
    catch (e) { toast(e.message); }
  }

  // ---------- Vista: Materia ----------
  async function vistaMateria(id) {
    const m = await api('/api/materias/' + id);
    m.tareas.forEach(guardarTarea);
    $('#view').innerHTML = `
      <div class="crumbs"><a href="#/">Materias</a> ›</div>
      <div class="page-head">
        <div><h1><span class="mat-dot" style="--c:${esc(m.color)}"></span>${esc(m.nombre)}</h1>${m.docente ? `<div class="muted">👩‍🏫 ${esc(m.docente)}</div>` : ''}</div>
        <div class="row">
          <button class="btn ghost small" id="editM">✏️ Editar</button>
          <button class="btn primary" id="nuevaT">＋ Nueva tarea</button>
        </div>
      </div>
      <div id="lista">${m.tareas.map(t => tarjetaTarea(t)).join('') || `<div class="empty"><div class="big">📝</div><p>No hay tareas en esta materia.</p></div>`}</div>`;
    $('#nuevaT').onclick = () => formTarea(m.id);
    $('#editM').onclick = () => formMateria(m);
    enlazarTarjetas();
  }

  // ---------- Vista: Todas las tareas ----------
  function pasaFiltro(t) {
    if (filtroTareas === 'pendientes') return !yaHice(t);
    if (filtroTareas === 'hechas') return yaHice(t);
    if (filtroTareas === 'ayuda') return t.ayuda.length > 0;
    return true;
  }
  async function vistaTareas() {
    const tareas = await api('/api/tareas');
    tareas.forEach(guardarTarea);
    const lista = tareas.filter(pasaFiltro);
    const pend = tareas.filter(t => !yaHice(t)).length;
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Todas las tareas</h1><div class="muted">Te faltan ${pend} de ${tareas.length}</div></div></div>
      <div class="filters">
        ${[['pendientes', '⏳ Pendientes'], ['todas', 'Todas'], ['hechas', '✅ Hechas por mí'], ['ayuda', '🙋 Piden ayuda']].map(([k, l]) => `<button data-f="${k}" class="${filtroTareas === k ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <div id="lista">${lista.map(t => tarjetaTarea(t, true)).join('') || `<div class="empty"><div class="big">🎉</div><p>${filtroTareas === 'pendientes' ? '¡No tienes tareas pendientes!' : 'Nada por aquí.'}</p></div>`}</div>`;
    document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filtroTareas = b.dataset.f; vistaTareas(); });
    enlazarTarjetas();
  }

  // ---------- Vista: Detalle de tarea ----------
  async function vistaTarea(id) {
    const t = await api('/api/tareas/' + id);
    guardarTarea(t);
    $('#view').innerHTML = `
      <div class="crumbs"><a href="#/">Materias</a> › <a href="#/materia/${encodeURIComponent(t.materia_id)}">${esc(t.materia_nombre)}</a> ›</div>
      <div id="tareaInfo"></div>
      <div class="section-title">💬 Conversación de esta tarea</div>
      ${cajaChat('thread')}`;
    pintarInfoTarea(t);
    await cargarMensajes(t.id);
  }
  async function cargarInfoTarea() { try { pintarInfoTarea(await api('/api/tareas/' + rutaActual.id)); } catch {} }
  function pintarInfoTarea(t) {
    guardarTarea(t);
    const f = fechaInfo(t.fecha_entrega);
    const hice = yaHice(t), ayuda = pidoAyuda(t);
    const pct = t.total_estudiantes ? Math.round(t.hechos.length / t.total_estudiantes * 100) : 0;
    const hechosIds = new Set(t.hechos.map(h => h.usuario_id));
    const ayudaIds = new Set(t.ayuda.map(h => h.usuario_id));
    const faltan = usuarios.filter(u => !hechosIds.has(u.id));
    $('#tareaInfo').innerHTML = `
      <div class="card tarea ${hice ? 'done' : ''}">
        <div class="top">
          <div>
            <h1 style="margin:.1rem 0 .4rem;font-size:1.4rem">${esc(t.titulo)}</h1>
            <div class="row"><span class="chip ${hice ? '' : f.cls}">${f.txt}</span>${t.ejemplo ? '<span class="chip ex">Ejemplo</span>' : ''}${t.creador ? `<span class="muted" style="font-size:.8rem">Creada por ${esc(t.creador)}</span>` : ''}</div>
          </div>
          <div class="row" style="flex-wrap:nowrap">
            <button class="icon-btn" id="tEdit" title="Editar">✏️</button>
            <button class="icon-btn" id="tDel" title="Eliminar">🗑️</button>
          </div>
        </div>
        ${t.descripcion ? `<div class="desc">${esc(t.descripcion)}</div>` : '<div class="desc muted">Sin descripción.</div>'}
        <div class="progress"><div class="bar"><i style="width:${pct}%"></i></div><b>${t.hechos.length}/${t.total_estudiantes} la hicieron (${pct}%)</b></div>
        <div class="row" style="margin-top:.5rem">
          <button class="btn ok ${hice ? 'on' : ''}" id="tHecho">${hice ? '✅ ¡La hice!' : '☐ Marcar como hecha'}</button>
          ${hice ? '' : `<button class="btn help ${ayuda ? 'on' : ''}" id="tAyuda">${ayuda ? '🙋 Pediste ayuda' : '🙋 Necesito ayuda'}</button>`}
        </div>
        ${t.ayuda.length ? `<div class="section-title">🙋 Necesitan ayuda (${t.ayuda.length})</div>
          <div class="people">${t.ayuda.map(u => `<div class="person">${avatar(u, 'help')}<span class="name">${esc(u.nombre)}</span></div>`).join('')}</div>` : ''}
        <div class="section-title">✅ Ya la hicieron (${t.hechos.length}) — ¡pídeles ayuda!</div>
        ${t.hechos.length ? `<div class="people">${t.hechos.map(u => `<div class="person">${avatar(u)}<span class="name">${esc(u.nombre)}${u.usuario_id === yo.id ? ' (tú)' : ''}</span>
            ${u.usuario_id !== yo.id ? `<button class="btn small help" data-pedir="${esc(u.nombre)}" title="Escribirle en el chat de la tarea">Pedir ayuda</button>` : ''}</div>`).join('')}</div>`
          : '<p class="muted">Todavía nadie la marcó como hecha.</p>'}
        ${faltan.length ? `<div class="section-title">⏳ Aún no la marcan (${faltan.length})</div>
          <div class="avatars">${faltan.map(u => avatar(u, ayudaIds.has(u.id) ? 'help' : '')).join('')}</div>` : ''}
      </div>`;
    $('#tHecho').onclick = () => marcar(t.id, { hecho: !hice });
    $('#tAyuda') && ($('#tAyuda').onclick = () => marcar(t.id, { ayuda: !ayuda }));
    $('#tEdit').onclick = () => formTarea(t.materia_id, t);
    $('#tDel').onclick = () => borrarTarea(t);
    document.querySelectorAll('[data-pedir]').forEach(b => b.onclick = () => {
      const inp = $('#chatInput'); inp.value = `@${b.dataset.pedir} ¿me ayudas con esta tarea? 🙏 `; inp.focus();
      inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // ---------- Chat ----------
  function cajaChat(tipo) {
    return `<div class="chat ${tipo === 'thread' ? 'thread' : ''}">
      <div class="msgs" id="msgs"><div class="empty">Cargando…</div></div>
      <div class="typing" id="escribiendo"></div>
      <form id="chatForm" autocomplete="off">
        <input id="chatInput" maxlength="2000" placeholder="${tipo === 'thread' ? 'Pregunta o ayuda sobre esta tarea…' : 'Escribe a toda la clase…'}">
        <button class="btn primary" type="submit">Enviar</button>
      </form>
    </div>`;
  }
  async function cargarMensajes(tareaId) {
    const msgs = await api('/api/mensajes' + (tareaId ? '?tarea=' + tareaId : ''));
    const box = $('#msgs'); box.innerHTML = '';
    if (!msgs.length) box.innerHTML = `<div class="empty" id="vacio"><div class="big">💬</div><p>${tareaId ? 'Nadie escribió sobre esta tarea. ¡Pregunta lo que necesites!' : 'Sé el primero en saludar a la clase 👋'}</p></div>`;
    msgs.forEach(agregarMensaje);
    let ultimo = 0;
    $('#chatForm').onsubmit = e => {
      e.preventDefault();
      const inp = $('#chatInput'); const texto = inp.value.trim(); if (!texto) return;
      socket.emit('chat:enviar', { tarea_id: tareaId || null, texto }, r => { if (!r.ok) toast(r.error); });
      inp.value = '';
    };
    $('#chatInput').oninput = () => { const n = Date.now(); if (n - ultimo > 1500) { ultimo = n; socket.emit('escribiendo', { tarea_id: tareaId || null }); } };
  }
  function agregarMensaje(m) {
    const box = $('#msgs'); if (!box) return;
    $('#vacio')?.remove();
    if (box.querySelector(`[data-msg="${m.id}"]`)) return;
    const mio = m.usuario_id === yo.id;
    const cerca = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const div = document.createElement('div');
    div.className = 'msg' + (mio ? ' mine' : ''); div.dataset.msg = m.id;
    div.innerHTML = `${avatar(m)}<div class="bubble">${mio ? '' : `<div class="who" style="color:${esc(m.color)}">${esc(m.nombre)}</div>`}${esc(m.texto)}<span class="time">${hora(m.creado)}</span></div>`;
    box.appendChild(div);
    if (cerca || mio) box.scrollTop = box.scrollHeight;
  }
  async function vistaChat() {
    noLeidos = 0; pintarBadge();
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Chat de la clase</h1><div class="muted">Todos los mensajes se guardan. Para dudas de una tarea usa el chat dentro de cada tarea.</div></div></div>
      <div class="chat-layout">
        ${cajaChat('general')}
        <aside class="card side"><div class="section-title" style="margin-top:0">Compañeros</div><div id="listaConectados"></div></aside>
      </div>`;
    pintarConectados();
    await cargarMensajes(null);
    $('#msgs').scrollTop = $('#msgs').scrollHeight;
  }
  function pintarConectados() {
    const el = $('#listaConectados'); if (!el) return;
    const enLinea = id => conectados.some(x => mismoId(x, id));
    const orden = [...usuarios].sort((a, b) => enLinea(b.id) - enLinea(a.id));
    el.innerHTML = orden.map(u => `<div class="person"><span class="dot ${enLinea(u.id) ? 'on' : ''}" data-dot="${esc(u.id)}"></span>${avatar(u)}<span class="name">${esc(u.nombre)}</span></div>`).join('');
  }

  // ---------- Modal ----------
  function abrirModal(titulo, html, onSubmit) {
    $('#modalTitle').textContent = titulo;
    const f = $('#modalForm');
    f.innerHTML = html + `<p class="error" id="modalError"></p><div class="modal-actions"><button type="button" class="btn ghost" id="cancelar">Cancelar</button><button class="btn primary" type="submit">Guardar</button></div>`;
    $('#modal').classList.remove('hidden');
    setTimeout(() => f.querySelector('input,textarea')?.focus(), 50);
    const cerrar = () => $('#modal').classList.add('hidden');
    $('#cancelar').onclick = cerrar;
    $('#modal').onclick = e => { if (e.target.id === 'modal') cerrar(); };
    f.onsubmit = async e => { e.preventDefault(); try { const r = await onSubmit(f); if (r !== false) cerrar(); } catch (err) { $('#modalError').textContent = err.message; } };
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });

  // Arranque
  if (token) iniciar(); else mostrarLogin();
})();
