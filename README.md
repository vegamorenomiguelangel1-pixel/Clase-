# 📚 Clase App — materias, tareas y chat de la clase

App web para un curso, pensada para que **cualquier grupo** la use a la vez:

- 🆕 **Crear una clase** con tu nombre y el nombre de la clase. La app genera un **código único** (6 letras o dígitos, fáciles de dictar) para compartirlo.
- 🔑 **Unirte a una clase** con ese código y tu nombre.
- 📘 Ver, crear, editar y eliminar **materias**.
- 📝 Ver, crear, editar y eliminar **tareas** de cada materia (título, descripción y fecha de entrega).
- ✅ Marcar si **hiciste la tarea**. En tu clase todos ven quién la hizo (avatares y progreso, por ejemplo `7/20 la hicieron`).
- 🙋 Marcar **"Necesito ayuda"** en una tarea. Así los demás lo ven y tú ves quién ya la hizo para pedirle ayuda (botón **"Pedir ayuda"**).
- 💬 **Chat general** de la clase en tiempo real, y un **chat por tarea** para dudas de esa tarea.
- ⚡ Todo se actualiza **en tiempo real** solo dentro de tu clase (Socket.io, una sala por clase).
- 📱 Diseño adaptado a celular (barra de navegación abajo).

> Es un **prototipo**: simple, sin cuentas externas. Cada clase está aislada: materias, tareas, marcas, usuarios y mensajes no se mezclan con los de otra clase. El mismo nombre en dos clases son dos personas distintas.

Una clase nueva **empieza vacía**. No hay materias de ejemplo: quien la crea ve una guía para agregar la primera.

## Capturas

| Materias | Detalle de tarea + chat | Celular |
|---|---|---|
| ![](screenshots/02-materias.png) | ![](screenshots/05-detalle-tarea-y-chat.png) | ![](screenshots/09-movil-tarea.png) |

Hay más capturas en la carpeta [`screenshots/`](screenshots/).

## Tecnologías

- **Node.js + Express** (servidor y API REST)
- **Socket.io** (tiempo real: marcas y chat, por clase)
- **SQLite** con `better-sqlite3` (un solo archivo de base de datos, sin instalar nada aparte)
- Frontend en **HTML + CSS + JavaScript puro** (`public/`), sin compilación

## Cómo correrlo en tu compu

Requisitos: [Node.js](https://nodejs.org) 18 o más nuevo (recomendado 20 LTS).

```bash
npm install
npm start
```

Abre **http://localhost:3000**.

### Crear una clase o unirte

En la pantalla de inicio hay dos pestañas:

- **Crear una clase:** tu nombre y el nombre de la clase (por ejemplo `Programación I · 2B`). Al crearla verás el código en grande, con botón para copiarlo o compartirlo. Entra y agrega la primera materia. El código también queda en la barra de arriba.
- **Unirme a una clase:** el código que te pasaron y tu nombre. No importan mayúsculas, minúsculas ni espacios.

Dentro de la app, **Cambiar** o **Salir** te devuelve a esa pantalla para entrar a otra clase. Quien creó la clase puede, en **Ajustes**, cambiarle el nombre o **generar un código nuevo** (el anterior deja de servir; quien ya entró sigue dentro).

Si ya entraste antes, usa el **mismo nombre** en esa clase para recuperar tus marcas.

### Variables de entorno

| Variable | Para qué sirve | Por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `DATA_DIR` | Carpeta donde se guarda `clase.db` (SQLite) | `./data` |
| `SEED` | Solo si vale `true` se crea una clase demo con datos de ejemplo. Las clases que cree la gente siguen vacías. | (apagado) |
| `CLASS_CODE` | Opcional. Código de la clase demo cuando `SEED=true`. Si ya tenías una base de la versión anterior, es el código con el que se migra esa clase la primera vez. | `CLASE2026` al migrar; si no, se genera |
| `RATE_CREATE_MAX` | Máximo de clases nuevas por IP en la ventana | `10` |
| `RATE_JOIN_MAX` | Máximo de intentos de unirse por IP en la ventana | `60` |

Ver `.env.example`.

No hace falta definir un código global para publicar la app: cada grupo crea el suyo.

### Probar en la red del aula / casa

Si tu compu y los celulares están en el mismo WiFi, tus compañeros pueden entrar con `http://IP-DE-TU-COMPU:3000` (ej. `http://192.168.1.15:3000`).

## Clases vacías y datos de ejemplo

Por defecto **no** se crea ninguna clase demo ni materias de ejemplo. Cada clase nueva sale en blanco, con una pantalla que le indica a quien la creó cómo agregar la primera materia.

Si quieres una clase de demostración (por ejemplo para capturas), arranca una vez con `SEED=true`. Esa clase lleva el prefijo **`[EJEMPLO]`** y una etiqueta morada "Ejemplo". Puedes elegir su código con `CLASS_CODE`. Esas materias **no** se copian a las clases que cree la gente.

Si ya tenías `data/clase.db` de la versión de una sola clase, al arrancar se convierte en **una** clase. El código de entrada es `CLASS_CODE` si lo defines en ese primer arranque; si no, `CLASE2026`. Conviene fijar `CLASS_CODE` al código que usaban antes, antes de actualizar.

Para empezar de cero, detén el servidor y borra la carpeta `data/`.

## Publicarlo gratis para que lo use la clase

### Opción A: Render (gratis)

1. Sube esta carpeta a un repositorio de **GitHub** (el `.gitignore` ya excluye `node_modules` y `data`).
2. Entra a [render.com](https://render.com) → **New +** → **Web Service** → conecta tu repo.
3. Configura:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
4. **Deploy**. Render te da una URL tipo `https://clase-app.onrender.com`. Compártela: cada grupo crea su clase y pasa su código.

(También puedes usar **New + → Blueprint**: el archivo `render.yaml` ya trae esta configuración, con `SEED=false`.)

⚠️ **Importante con el plan gratis de Render:**
- El servicio "se duerme" tras ~15 min sin visitas; la primera visita tarda ~1 minuto en despertar.
- El disco **no es persistente**: al redesplegar o reiniciar, **se borran** la base de datos (clases, tareas, marcas y mensajes). Sirve para demos. Para uso real, usa un disco persistente (de pago en Render) con `DATA_DIR` apuntando a él, o usa Railway con un volumen (abajo).

### Opción B: Railway (con volumen, los datos se mantienen)

1. Sube el proyecto a GitHub.
2. En [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. En **Variables** agrega `DATA_DIR=/data` (y `SEED=false` si quieres dejarlo explícito).
4. En el servicio → **Settings / Volumes** → **Add Volume** con *mount path* `/data` (así la base SQLite sobrevive a reinicios).
5. En **Settings → Networking** pulsa **Generate Domain** para obtener la URL pública.

Railway da un crédito gratuito de prueba; revisa sus condiciones actuales porque cambian seguido.

> Railway y Render ponen el `PORT` solos; no hace falta configurarlo. Detrás de un proxy la app usa la IP real del visitante para el límite de intentos.

## Pruebas automáticas

```bash
npm test
```

Levanta servidores temporales (con una base de datos aparte, no toca tus datos) y prueba: crear y unirse a una clase, códigos incorrectos, permisos, crear/editar/eliminar materias y tareas, **dos clientes Socket.io** de la misma clase, que **otra clase no ve** marcas ni chat, que una clase nueva nace vacía, la migración de una base antigua y los límites por IP.

Las capturas se generan con `scripts/screenshots.js` (necesita `puppeteer-core` y Google Chrome/Chromium; no está en las dependencias para que `npm install` siga siendo liviano). Ese script arranca con `SEED=true` para tener datos que fotografiar.

## Estructura

```
./
├── server.js          # Express + API REST + Socket.io
├── db.js              # Esquema SQLite, migración y clase demo opcional
├── public/
│   ├── index.html     # Página única
│   ├── styles.css     # Estilos (responsive)
│   └── app.js         # Lógica del frontend (rutas #/, #/materia/1, #/tarea/1, #/tareas, #/chat)
├── scripts/
│   ├── test.js        # Prueba de API + tiempo real + aislamiento
│   └── screenshots.js # Genera las capturas
├── screenshots/       # Capturas de pantalla
├── render.yaml        # Configuración para Render
└── .env.example
```

### API (resumen)

Todas las rutas (menos crear clase, unirse y salud) necesitan `Authorization: Bearer <token>`.

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/clases` | `{nombre, clase}` → crea la clase y entra. `{token, usuario, clase}` |
| POST | `/api/login` | `{nombre, codigo}` → unirse. Código incorrecto: 401 |
| PUT | `/api/clase` | Quien creó la clase: `{nombre?, regenerar?}` |
| GET | `/api/materias` | Materias de **tu** clase, con contadores |
| POST/PUT/DELETE | `/api/materias[/:id]` | CRUD de materias (solo las de tu clase) |
| GET | `/api/materias/:id` | Materia con sus tareas |
| POST | `/api/materias/:id/tareas` | Nueva tarea |
| GET/PUT/DELETE | `/api/tareas/:id` | Ver/editar/eliminar tarea |
| PUT | `/api/tareas/:id/estado` | `{hecho?, ayuda?}` del usuario actual |
| GET | `/api/mensajes[?tarea=id]` | Chat general o de una tarea, de tu clase |

Eventos Socket.io (solo dentro de la sala de la clase): `chat:enviar` / `chat:nuevo`, `estado:cambio`, `datos:cambio`, `clase:cambio`, `presencia`, `escribiendo`.

## Limitaciones (es un prototipo)

- **Seguridad simple:** cualquiera con el código de la clase puede entrar con *cualquier* nombre, también el de otro compañero de **esa** clase, y cualquiera puede editar o borrar materias y tareas. Para una clase de confianza está bien; para algo más serio habría que agregar contraseñas por usuario y roles (por ejemplo, solo quien creó la clase borra).
- Hay un límite de creaciones de clase y de intentos de unión **por IP**, para frenar abusos. En un WiFi compartido (el aula) el de unirse es amplio a propósito.
- No hay notificaciones push al celular ni archivos adjuntos en el chat.
- El "total de estudiantes" del progreso (`x/20`) son las personas que entraron alguna vez **a esa clase**.
- SQLite es ideal para varias clases chicas. Para muchísimos usuarios a la vez conviene PostgreSQL.
