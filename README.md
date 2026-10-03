# 📚 Clase App — materias, tareas y chat de la clase

App web para nuestro curso donde podemos:

- 📘 Ver, crear, editar y eliminar **materias**.
- 📝 Ver, crear, editar y eliminar **tareas** de cada materia (título, descripción y fecha de entrega).
- ✅ Marcar si **hiciste la tarea**. Todos ven quién la hizo (avatares y progreso, por ejemplo `7/20 la hicieron`).
- 🙋 Marcar **"Necesito ayuda"** en una tarea. Así los demás lo ven y tú ves quién ya la hizo para pedirle ayuda (botón **"Pedir ayuda"**).
- 💬 **Chat general** de la clase en tiempo real, y un **chat por tarea** para dudas de esa tarea.
- ⚡ Todo se actualiza **en tiempo real** en los celulares y compus de todos (Socket.io).
- 📱 Diseño adaptado a celular (barra de navegación abajo).

> Es un **prototipo**: simple, sin cuentas externas. Para entrar solo necesitas tu **nombre** y el **código de la clase**.

## Capturas

| Materias | Detalle de tarea + chat | Celular |
|---|---|---|
| ![](screenshots/02-materias.png) | ![](screenshots/05-detalle-tarea-y-chat.png) | ![](screenshots/09-movil-tarea.png) |

Hay más capturas en la carpeta [`screenshots/`](screenshots/).

## Tecnologías

- **Node.js + Express** (servidor y API REST)
- **Socket.io** (tiempo real: marcas y chat)
- **SQLite** con `better-sqlite3` (un solo archivo de base de datos, sin instalar nada aparte)
- Frontend en **HTML + CSS + JavaScript puro** (`public/`), sin compilación

## Cómo correrlo en tu compu

Requisitos: [Node.js](https://nodejs.org) 18 o más nuevo (recomendado 20 LTS).

```bash
npm install
npm start
```

Abre **http://localhost:3000** y entra con tu nombre y el código **`CLASE2026`** (es el código por defecto para pruebas locales).

### Elegir tu propio código de la clase

El código de la clase es **obligatorio** para entrar y se configura con la variable de entorno `CLASS_CODE`:

```bash
# Linux / Mac
CLASS_CODE=INGSIS-2B npm start

# Windows (PowerShell)
$env:CLASS_CODE="INGSIS-2B"; npm start
```

Si no defines `CLASS_CODE`, se usa `CLASE2026` y el servidor muestra un aviso. **En internet, define siempre tu propio código** y pásalo solo a tus compañeros (por ejemplo en el grupo de WhatsApp). No importan las mayúsculas/minúsculas.

### Variables de entorno

| Variable | Para qué sirve | Por defecto |
|---|---|---|
| `CLASS_CODE` | Código que hay que escribir para entrar | `CLASE2026` |
| `PORT` | Puerto del servidor | `3000` |
| `DATA_DIR` | Carpeta donde se guarda `clase.db` (SQLite) | `./data` |
| `SEED` | `false` para **no** crear los datos de ejemplo | `true` |

Ver `.env.example`.

### Probar en la red del aula / casa

Si tu compu y los celulares están en el mismo WiFi, tus compañeros pueden entrar con `http://IP-DE-TU-COMPU:3000` (ej. `http://192.168.1.15:3000`).

## Datos de ejemplo

La primera vez que arranca, la app crea 2 materias y 4 tareas **de ejemplo**. Todas tienen el prefijo **`[EJEMPLO]`** y una etiqueta morada "Ejemplo". Puedes editarlas o borrarlas desde la app (🗑️). Si no quieres que se creen, arranca con `SEED=false` antes de la primera ejecución. Para empezar de cero, detén el servidor y borra la carpeta `data/`.

## Publicarlo gratis para que lo use la clase

### Opción A: Render (gratis)

1. Sube esta carpeta a un repositorio de **GitHub** (el `.gitignore` ya excluye `node_modules` y `data`).
2. Entra a [render.com](https://render.com) → **New +** → **Web Service** → conecta tu repo.
3. Configura:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
   - **Environment → Add variable:** `CLASS_CODE` = el código de tu clase
4. **Deploy**. Render te da una URL tipo `https://clase-app.onrender.com` para compartir con la clase.

(También puedes usar **New + → Blueprint**: el archivo `render.yaml` ya trae esta configuración y te pedirá el `CLASS_CODE`.)

⚠️ **Importante con el plan gratis de Render:**
- El servicio "se duerme" tras ~15 min sin visitas; la primera visita tarda ~1 minuto en despertar.
- El disco **no es persistente**: al redesplegar o reiniciar, **se borran** la base de datos (tareas, marcas y mensajes). Sirve para demos. Para uso real, usa un disco persistente (de pago en Render) con `DATA_DIR` apuntando a él, o usa Railway con un volumen (abajo).

### Opción B: Railway (con volumen, los datos se mantienen)

1. Sube el proyecto a GitHub.
2. En [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. En **Variables** agrega `CLASS_CODE=tu-codigo` y `DATA_DIR=/data`.
4. En el servicio → **Settings / Volumes** → **Add Volume** con *mount path* `/data` (así la base SQLite sobrevive a reinicios).
5. En **Settings → Networking** pulsa **Generate Domain** para obtener la URL pública.

Railway da un crédito gratuito de prueba; revisa sus condiciones actuales porque cambian seguido.

> Railway y Render ponen el `PORT` solos; no hace falta configurarlo.

## Pruebas automáticas

```bash
npm test
```

Levanta un servidor temporal (con una base de datos aparte, no toca tus datos) y prueba: el login con código, los permisos, crear/editar/eliminar materias y tareas, y **dos clientes Socket.io** a la vez (uno ve en vivo la marca y el pedido de ayuda del otro, el chat general y el chat por tarea, y que los mensajes se guardan).

Las capturas se generan con `scripts/screenshots.js` (necesita `puppeteer-core` y Google Chrome/Chromium; no está en las dependencias para que `npm install` siga siendo liviano).

## Estructura

```
./
├── server.js          # Express + API REST + Socket.io
├── db.js              # Esquema SQLite + datos de ejemplo
├── public/
│   ├── index.html     # Página única
│   ├── styles.css     # Estilos (responsive)
│   └── app.js         # Lógica del frontend (rutas #/, #/materia/1, #/tarea/1, #/tareas, #/chat)
├── scripts/
│   ├── test.js        # Prueba de API + tiempo real
│   └── screenshots.js # Genera las capturas
├── screenshots/       # Capturas de pantalla
├── render.yaml        # Configuración para Render
└── .env.example
```

### API (resumen)

Todas las rutas (menos login) necesitan `Authorization: Bearer <token>`.

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/login` | `{nombre, codigo}` → `{token, usuario}` |
| GET | `/api/materias` | Lista con contadores |
| POST/PUT/DELETE | `/api/materias[/:id]` | CRUD de materias |
| GET | `/api/materias/:id` | Materia con sus tareas |
| POST | `/api/materias/:id/tareas` | Nueva tarea |
| GET/PUT/DELETE | `/api/tareas/:id` | Ver/editar/eliminar tarea |
| PUT | `/api/tareas/:id/estado` | `{hecho?, ayuda?}` del usuario actual |
| GET | `/api/mensajes[?tarea=id]` | Chat general o de una tarea |

Eventos Socket.io: `chat:enviar` / `chat:nuevo`, `estado:cambio`, `datos:cambio`, `presencia`, `escribiendo`.

## Limitaciones (es un prototipo)

- **Seguridad simple:** cualquiera con el código de la clase puede entrar con *cualquier* nombre, también el de otro compañero, y cualquiera puede editar o borrar materias y tareas. Para una clase de confianza está bien; para algo más serio habría que agregar contraseñas por usuario y roles (por ejemplo, solo el delegado borra).
- No hay notificaciones push al celular ni archivos adjuntos en el chat.
- El "total de estudiantes" del progreso (`x/20`) son las personas que entraron alguna vez a la app.
- SQLite es ideal para una clase (decenas de personas). Para cientos de usuarios conviene PostgreSQL.
