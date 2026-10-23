# Ski Valet — Flask + PostgreSQL (Railway)

Gestión de guardaesquís: tarjetas de habitación → habitación → ubicación → equipo.
Los datos viven en PostgreSQL; el navegador ya no guarda nada (ni datos, ni contraseñas, ni PIN).

## Estructura

```
app.py             Backend Flask: API, sesiones, esquema de base de datos
static/index.html  App del valet
static/admin.html  Consola de administración
static/sync.js     Sincronización con el servidor (compartida por las dos páginas)
requirements.txt   Procfile   railway.json
```

## Despliegue en Railway

1. Sube el repositorio a GitHub y crea un proyecto en Railway desde ese repo.
2. Añade un servicio **PostgreSQL** al proyecto.
3. En el servicio web, crea estas variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (referencia al servicio de Postgres)
   - `ADMIN_PASSWORD` = contraseña del admin (**defínela antes del primer arranque**)
   - Opcionales: `ADMIN_USERNAME` (por defecto `Admin`), `STAFF_PIN` (4 dígitos), `SECRET_KEY`, `SESSION_HOURS` (por defecto 12)
4. Genera un dominio público (Settings → Networking). Web NFC necesita HTTPS, que Railway ya da.

Las tablas se crean solas al arrancar. `ADMIN_PASSWORD`, `ADMIN_USERNAME` y `STAFF_PIN` solo se usan
la primera vez; después se cambian desde la app (Access). Si no defines `ADMIN_PASSWORD`, se usa el
login de admin que ya venía por defecto en la versión anterior.
Si no defines `SECRET_KEY`, se genera una y se guarda en la base de datos.

## Primer uso (base de datos vacía)

1. Abre `/` → **Admin sign in**.
2. Cuenta → **Access & staff**: pon el PIN del personal y añade los nombres.
3. El mapa de ubicaciones ya viene creado (vacío), una zona por tipo de equipo:
   Boots 1–4 (`B1-01`…), Snowboard (`SB-`), Ski 1–2 (`S1-`, `S2-`), Kids (`K-`) y VIP (`V-`).
   Están colocadas como en el plano del guardaesquís:
   ```
   [ Boots 1 ] [ Boots 2 ] [ Snowboard | Ski 1 ]   ┃ Ski 2
                                                  ┃ (pared derecha)
   [ Boots 3 ] [ Boots 4 ] [ VIP | Kids ]
   ```
   La numeración está en `HALL_LAYOUT`, al principio de `app.py` (por ahora 20 por zona, 10 en VIP).
   El dibujo del plano que muestra la app está en `HALL_PLAN` (`static/index.html`); usa los mismos
   nombres de zona, así que si renombras una zona hay que cambiarlo también allí. Si borras alguna, **Hall setup** (app)
   o **Storage map** (/admin) muestran *Restore default layout* para volver a crear las que falten.
4. Cada valet entra con su **PIN personal** (Admin → Staff & access → *Set PIN*), sin elegir nombre:
   así nadie puede trabajar con el nombre de otro. Quien aún no tenga PIN personal entra con el PIN
   compartido y toca su nombre.

La consola de administración está en `/admin` (misma sesión que la app).

## En local

```bash
pip install -r requirements.txt
export DATABASE_URL=postgresql://usuario:clave@localhost/skivalet
export COOKIE_SECURE=0          # solo en local (http)
export ADMIN_PASSWORD=unaclave123
python app.py                   # http://localhost:5000
```

## Check-in y storage

- Solo se guardan **boots**, **skis (con sus poles)** y **snowboards**.
- Cada equipo va a **su propia ubicación**, en la zona de su tipo: un cliente con una snowboard y
  un par de boots usa dos ubicaciones. La app propone la primera libre de cada zona y el valet
  puede cambiarla. Los skis y snowboards marcados *Kids use* van a *Kids* (si está llena, a su
  zona normal); los clientes VIP usan la zona *VIP* (y, si está llena, la zona normal).
- En el check-in cada equipo solo lleva **foto** y **storage**. La foto se toma con la cámara del
  dispositivo dentro de la app (hace falta HTTPS y dar permiso a la cámara); si el navegador no
  la permite, se abre la cámara/galería del sistema.
- Cada zona tiene un tipo (*Holds*): se elige al crear la fila en Hall setup / Storage map
  o con el selector de cada zona. Las zonas sin tipo no se usan en la asignación automática.
- **Check in** (inicio → *Check in*) se hace con el número de habitación; la tarjeta es opcional.
  Se puede añadir después desde la página de la habitación, o escaneándola y escribiendo el mismo número.
- Si el guardaesquís queda vacío, al arrancar la nueva versión se crean solas las zonas del plano
  (una vez). También con *Create storage areas* en el inicio o *Restore default layout* en Hall setup.
- **Fotos**: cada equipo puede llevar una foto. Se reduce en el móvil y se guarda en PostgreSQL
  (tabla `photos`); el registro solo guarda su id. Las fotos que ya no usa ningún equipo se
  borran a los `PHOTO_KEEP_DAYS` días (por defecto 90). Las copias de seguridad JSON no incluyen fotos.

## Kiosko: pre-check-in del cliente

- `static/kiosk.html` (ruta `/kiosk`) es la pantalla táctil donde el cliente se pre-registra solo:
  idioma (English, 日本語, 中文, 한국어), habitación, nombre y apellido, fecha de salida (opcional) y
  cuántos boots, skis y snowboards trae. No toma fotos ni elige ubicaciones.
- Cada pantalla se empareja una vez: Admin → **Kiosks** → *Add screen* da un código de 6 dígitos
  (válido 10 minutos) que se escribe en `/kiosk`. La pantalla queda emparejada un año con su propia
  cookie; solo puede enviar pre-registros, no ve ningún dato. *Remove* la desconecta al momento.
- Los pre-registros quedan en la tabla `prechecks` con estado `pending` y llegan a todos los
  dispositivos por la sincronización normal. Los que nadie confirma pasan a `expired` a las
  `PRECHECK_HOURS` horas (por defecto 24) y los terminados se borran a los `PRECHECK_KEEP_DAYS` días (30).
- En la app del valet, el inicio muestra **Pre-check-ins** pendientes. Al tocar uno (o al escribir la
  habitación en *Check in*) el formulario se rellena: habitación, nombre, salida y una línea por equipo
  declarado, con el nombre del cliente como dueño (vacío si declaró más de uno del mismo tipo: es una
  familia y el valet pregunta de quién es cada cosa). El valet cuenta los equipos, toma las fotos, marca
  VIP / Kids y pulsa *Check in*: el pre-registro pasa a `confirmed` y queda en el historial con lo
  declarado. Una familia puede mandar uno por persona y se juntan con *Add too*. *Dismiss* lo descarta
  (`dismissed`) sin guardar nada.
- **Foto de identificación** (opcional): en el kiosko el cliente marca el consentimiento y se toma una
  foto con la cámara frontal (hace falta HTTPS y dar permiso a la cámara en esa pantalla; si no hay
  cámara, el paso se puede saltar). Se guarda en `photos` con `kind = 'face'`, solo la ve el personal con
  sesión, y el navegador no la guarda en caché. Al confirmar, pasa a la habitación
  (`face_photo_ids`) y se muestra en la página de la habitación y en *Hand to guest* / *Check out*.
  El servidor la borra cuando la habitación hace check-out (última recogida), o si el pre-registro
  caduca o se descarta sin confirmar.
- Tras cada registro la pantalla vuelve al inicio a los 10 s; si nadie la toca durante 60 s avisa y
  se reinicia 15 s después, para que el siguiente cliente no vea datos del anterior.

## Cómo funciona la sincronización

- Cada registro tiene una revisión (`rev`). `save()` envía solo los registros que cambiaron.
- Cada dispositivo pide los cambios de los demás cada 5 segundos.
- Si dos dispositivos cambian el mismo registro a la vez, el segundo recibe un aviso,
  recarga los datos y repite la acción. Nada se sobrescribe en silencio.
- Sin conexión, sale un aviso rojo y los cambios se reintentan solos.
- Restaurar una copia, importar un backup o borrar el historial hace que todos los dispositivos recarguen.
- El historial es de solo añadir y siempre registra a la persona con sesión iniciada.
- Las copias de seguridad automáticas (últimas 15, antes de cada cambio en la consola) se guardan en el servidor.

## Seguridad

- Contraseña del admin y PIN del personal guardados como hash (Werkzeug), solo en el servidor.
- Cookie de sesión HttpOnly, Secure y SameSite=Lax; caduca tras 12 h sin uso.
- Límite de 10 intentos fallidos de login por IP cada 10 minutos.
- Cambiar la contraseña del admin cierra las demás sesiones de admin.
- Archivar a un miembro del personal cierra su sesión.
