# Sistema de registro de eventos — API

API (Express + TypeScript) del sistema de registro de eventos para organizaciones
adventistas hispanas: Unión > Asociación > Iglesia. Se está migrando de V1
(un solo evento, FEJA 2026) a V2 (SaaS multitenant). Diseño y plan en
[docs/v2](docs/v2).

## Requisitos

- Node 20.15+
- MariaDB 10.4+ (XAMPP) en local o MySQL 8/9 (Railway). Ver las reglas de
  compatibilidad en [docs/v2/plan-refactorizacion.md](docs/v2/plan-refactorizacion.md).

## Arranque local

```bash
npm install
cp .env-example .env        # y llenar los valores
npm run migrate             # crea/actualiza las tablas V2
npm run seed                # estados de EE. UU., Pacific Union y asociaciones
npm run dev
```

`GET /api/health` responde `{ api: "up", db: "up" }` si todo está bien.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga automática |
| `npm run build` / `npm start` | Compila a `dist/` y lo ejecuta |
| `npm run typecheck` | Revisa tipos del código y de las pruebas |
| `npm test` | Pruebas (Vitest) contra la BD `<DB_NAME>_test`, que se recrea en cada corrida |
| `npm run migrate` | Aplica migraciones pendientes |
| `npm run migrate:down` | Revierte la última migración |
| `npm run migrate:status` | Lista migraciones aplicadas y pendientes |
| `npm run migrate:prod` | Igual que `migrate`, pero desde `dist/` (producción) |
| `npm run seed` | Carga el catálogo base (idempotente) |
| `npm run import:v1 -- --dry-run` | Simula la migración de FEJA 2026 (V1 → V2), verifica y revierte |
| `npm run import:v1` | Migra FEJA 2026 de V1 a V2 (una sola vez) |

## Base de datos

- Migraciones en `src/db/migrations`. Para agregar una: crear
  `NNN_descripcion.ts` con `up`/`down` y registrarla en
  `src/db/migrations/index.ts`.
- Acceso a datos V2 con [Kysely](https://kysely.dev) (`src/db/client.ts`),
  tipos en `src/db/types.ts`. Todo se guarda en UTC.
- Columnas JSON: escribir con `toJson()` y leer con `fromJson()`
  (`src/db/json.ts`), porque MariaDB las devuelve como texto y MySQL como objeto.
- `audit_logs` es solo de inserción: la BD bloquea `UPDATE` y `DELETE`.
- Las tablas de V1 (`registros`, `admins`, ...) conviven en la misma BD hasta
  que se retire V1; las de V2 tienen nombres distintos.

## API V2 (`/api/v2`)

Convive con V1 (`/api`) hasta que el Front migre.

**Cliente (tenant).** Cada petición dice a qué cliente va, en este orden:
header `X-Tenant: <slug>` → subdominio del `Origin` → subdominio del `Host`
(`pacific.tuapp.com`; en local `pacific.localhost`). Solo identifica el
cliente: lo que cada quien puede ver lo decide su membresía.

**Sesión.**

| Endpoint | Qué hace |
|---|---|
| `POST /api/v2/auth/login` | `{ email, password }` → `accessToken` (15 min) + cookie httpOnly `rt` |
| `POST /api/v2/auth/refresh` | Con la cookie `rt` → nuevo access token; rota la cookie |
| `POST /api/v2/auth/logout` | Invalida la cookie `rt` |
| `GET /api/v2/auth/me` | Usuario, cliente, rol, permisos y alcance |

El access token va en `Authorization: Bearer <token>`. Usuario y membresía
se revisan en la BD en cada petición (quitar acceso aplica de inmediato).
5 intentos fallidos bloquean la cuenta 15 min. Reusar un refresh token ya
rotado cierra todas las sesiones del usuario.

**Permisos** (`src/core/permissions.ts`): owner = todo; finance = lectura +
pagos; staff = lectura, editar, borrar, check-in; viewer = lectura; admin de
plataforma = todo en cualquier cliente.

**Alcance** (`src/core/access-scope.ts`): un usuario limitado a una
asociación ve los eventos de su asociación completos, los de la Unión solo
con los registrados de su asociación, y no ve los de otras asociaciones.
Los repositorios reciben un `TenantScope` obligatorio.

**Auditoría** (`src/core/audit.ts`): `recordAudit(trx, {...})` toma cliente,
usuario, IP, navegador y `request_id` del contexto; `diff(antes, después)`
arma los cambios campo por campo.

| Endpoint | Qué hace |
|---|---|
| `GET /api/v2/events` | Eventos que el usuario puede ver |
| `GET /api/v2/events/:id/registrations?page&pageSize` | Registros paginados, filtrados por alcance |

**Administración** (Paso 4). Todo cambio queda en `audit_logs` con antes y
después. Un owner limitado a una asociación solo administra lo de su rama.

| Endpoint | Permiso | Qué hace |
|---|---|---|
| `POST /api/v2/auth/invitation/accept` | público | `{ token, password }` crea la contraseña e inicia sesión |
| `POST /api/v2/auth/password/forgot` | público | `{ email }` manda enlace (misma respuesta exista o no) |
| `POST /api/v2/auth/password/reset` | público | `{ token, password }` cambia la contraseña y cierra todas las sesiones |
| `GET /api/v2/users` | users.manage | Miembros del cliente |
| `POST /api/v2/users/invite` | users.manage | `{ email, name, role, scopeOrganizationId? }` |
| `POST /api/v2/users/:id/resend-invitation` | users.manage | Reenvía la invitación pendiente |
| `PATCH /api/v2/users/:id` | users.manage | `{ role?, scopeOrganizationId?, isActive? }` (siempre queda un owner) |
| `GET /api/v2/organizations/tree` | lectura | Árbol unión → asociaciones → iglesias |
| `GET/POST /api/v2/organizations/churches` | organizations.manage | Listar (filtros `status`, `conferenceId`, `q`) / crear |
| `PATCH /api/v2/organizations/churches/:id` | organizations.manage | Editar, aprobar (`status: verified`) o desactivar |
| `POST /api/v2/organizations/churches/:id/merge` | organizations.manage | `{ intoId }` fusiona un duplicado (mueve los registros) |
| `GET /api/v2/events/:id` | lectura | Detalle del evento |
| `POST /api/v2/events`, `PATCH /api/v2/events/:id` | events.manage | Crear / editar (`name` y `description` en `{es, en}`) |
| `POST /api/v2/events/:id/status` | events.manage | draft → published → closed; cualquiera → archived |
| `DELETE /api/v2/events/:id` | events.manage | Solo sin registros (si no, archivar) |
| `GET /api/v2/tenant/public` | público | Marca del cliente (login y formulario) |
| `GET/PATCH /api/v2/tenant/settings` | tenant.settings | Nombre, idioma, zona horaria, logo, colores, remitente |
| `GET/POST /api/v2/platform/tenants` | admin de plataforma | Listar / dar de alta un cliente (invita a su owner) |
| `PATCH /api/v2/platform/tenants/:id/status` | admin de plataforma | Activar / suspender |
| `GET/POST /api/v2/platform/organizations` | admin de plataforma | Catálogo de uniones y asociaciones |

**Formularios dinámicos** (Paso 5). La estructura vive en
`form_versions.schema_json` (ver `src/modules/forms/form-schema.ts` y el
Anexo A de `docs/v2/schema-propuesta.sql`):

```jsonc
{ "steps": [ { "key": "personal", "title": { "es": "...", "en": "..." }, "fields": [
  { "key": "first_name", "type": "text", "maps_to": "first_name", "required": true, "label": { "es": "Nombre", "en": "First name" } },
  { "key": "wants_tshirt", "type": "item_toggle", "item": "tshirt", "label": { ... } },
  { "key": "tshirt_size", "type": "item_variant", "item": "tshirt", "required": true,
    "visible_when": { "field": "wants_tshirt", "equals": true }, "label": { ... } }
] } ] }
```

- Tipos: `text`, `textarea`, `email`, `phone`, `number`, `date`, `checkbox`,
  `consent`, `radio`, `select`, `checkbox_group`, y de sistema
  `state_conference_picker`, `church_picker`, `item_toggle`, `item_variant`.
- `maps_to` llena columnas de `registrations` (`first_name`, `last_name`,
  `email`, `phone`, `birth_date`, `gender`); el resto va a `answers`.
- `visible_when` (`equals` / `not_equals` / `in`) solo puede depender de un
  campo anterior. Un campo oculto se ignora y no se exige.
- Para publicar: nombre, apellidos y correo obligatorios y siempre visibles.
- Versiones: se edita un borrador; publicar lo vuelve inmutable y la versión
  anterior queda `superseded`. Cada registro guarda con qué versión se llenó.

| Endpoint | Permiso | Qué hace |
|---|---|---|
| `GET/POST /api/v2/events/:id/forms` | lectura / forms.manage | Formularios del evento / crear (deja borrador v1) |
| `GET /api/v2/forms/:id` | lectura | Configuración, productos, versión publicada y borrador |
| `PATCH /api/v2/forms/:id` | forms.manage | Título, apertura/cierre, cupo, pagos (`paymentsEnabled`, `allowOnlinePayment`, `allowOfflinePayment`), mensaje de confirmación |
| `POST /api/v2/forms/:id/status` | forms.manage | draft → open → closed (abrir requiere versión publicada y evento publicado) |
| `PUT /api/v2/forms/:id/draft` | forms.manage | `{ schema }` guarda el borrador; responde `publishIssues` |
| `POST /api/v2/forms/:id/publish` | forms.manage | Publica el borrador (auditoría con campos agregados/quitados/cambiados) |
| `GET /api/v2/forms/:id/versions[/:versionId]` | lectura | Historial de versiones |
| `POST /api/v2/forms/:id/preview-answers` | forms.manage | Prueba respuestas contra el borrador o la publicada |
| `POST/PATCH /api/v2/forms/:id/items[/:itemId]` | forms.manage | Cuota de inscripción y productos (precio en centavos) |
| `PUT /api/v2/forms/:id/items/:itemId/variants` | forms.manage | Tallas: crea/actualiza por código; las que faltan se desactivan |

**Registro público** (Paso 6). Sin sesión, dentro del cliente de la petición.

| Endpoint | Qué hace |
|---|---|
| `GET /api/v2/public/events` | Inicio del cliente: eventos publicados/cerrados con `availability` y `openFormId` (el formulario abierto, si hay uno solo) |
| `GET /api/v2/public/events/:slug` | Evento publicado/cerrado y sus formularios con disponibilidad (`open`, `not_open_yet`, `closed`, `full`) |
| `GET /api/v2/public/forms/:id` | Versión publicada, productos activos (precio final, `soldOut`) y opciones de pago |
| `GET /api/v2/public/locations` | Estados → asociaciones del cliente |
| `GET /api/v2/public/conferences/:id/churches` | Iglesias verificadas de una asociación |
| `POST /api/v2/public/forms/:id/registrations` | `{ answers, locale, paymentMethod?, captchaToken? }` → `publicCode` |
| `GET /api/v2/public/registrations/:publicCode` | Página de confirmación (sin correo ni teléfono); `canPayOnline` indica si puede pagar con tarjeta ahora |

- Cupo y existencias se revisan con bloqueo de fila: con registros simultáneos
  nunca se pasa del límite.
- "Mi iglesia no está" crea una iglesia pendiente (o reutiliza la pendiente
  escrita igual); no aparece en la lista pública hasta que se apruebe.
- La misma persona (nombre + apellidos + correo) no se registra dos veces en
  el evento; hermanos con el mismo correo sí.
- La cuota de inscripción obligatoria se agrega sola; los precios quedan
  congelados en el registro.
- El correo de confirmación (con QR = `publicCode`, para el check-in) va a
  una bandeja en `email_messages`; un proceso en segundo plano lo envía cada
  `EMAIL_QUEUE_INTERVAL_SECONDS` y lo reintenta hasta 5 veces.
- Captcha opcional con Cloudflare Turnstile (`TURNSTILE_SECRET_KEY`).
- El pago en línea responde "todavía no disponible" hasta el Paso 8 (Stripe).

**Operación del evento** (Paso 7). Todo respeta el alcance: un usuario de
una asociación solo ve y opera los registros de su asociación en eventos de
la Unión. Lista, reporte y CSV comparten la misma regla
(`registrationConditions` en `registrations.repository.ts`).

| Endpoint | Permiso | Qué hace |
|---|---|---|
| `GET /api/v2/events/:id/registrations` | lectura | Paginada. Filtros: `q` (nombre, correo, teléfono o código), `conferenceId`, `churchId`, `status`, `paymentStatus`, `checkedIn`, `itemCode` + `variantCode`, `createdFrom`/`createdTo`, `deleted=only` (papelera); `sort`, `order` |
| `GET /api/v2/events/:id/registrations/export` | lectura | CSV (mismos filtros, `locale`); se audita |
| `GET /api/v2/events/:id/report` | lectura | Totales, por estado/pago/género/asociación/iglesia/día, productos por talla (pagados, pendientes, entregados), respuestas con opciones, cobros por método |
| `GET /api/v2/events/:id/activity?after=` | lectura | Actividad reciente con cursor (para refrescar el panel) |
| `GET /api/v2/events/:id/checkin/:publicCode` | checkin.write | Al escanear: quién es, qué pidió, cuánto debe, si ya entró |
| `POST /api/v2/events/:id/checkin` | checkin.write | `{ publicCode }` → `checked_in` o `already_checked_in` (un solo check-in aunque escaneen a la vez) |
| `GET /api/v2/registrations/:id` | lectura | Detalle completo (respuestas con sus etiquetas, productos, pagos, check-in) |
| `PATCH /api/v2/registrations/:id` | registrations.update | Datos, asociación/iglesia y respuestas (validadas con el formulario); auditoría con antes/después |
| `PATCH /api/v2/registrations/:id/items/:itemId` | registrations.update | Cambiar talla (respeta existencias) |
| `DELETE /api/v2/registrations/:id` / `POST .../restore` | registrations.delete | Papelera (borrado lógico con motivo y copia en la auditoría) / restaurar |
| `POST`/`DELETE /api/v2/registrations/:id/checkin` | checkin.write | Check-in manual / deshacer |
| `POST`/`DELETE /api/v2/registrations/:id/items/:itemId/delivery` | checkin.write | Entregar playera / canjear comida (solo si está pagado) / deshacer |
| `GET /api/v2/registrations/:id/history` | audit.read | Historial del registro |
| `GET /api/v2/audit` | audit.read (sin alcance) | Log del cliente con filtros (`eventId`, `entityType`, `entityId`, `actorUserId`, `action`, `from`, `to`) |

**Pagos** (Paso 8). Cada movimiento es un registro en `payments` (con sus
conceptos en `payment_items`); total, pagado y estado del registro se
recalculan siempre desde ahí (`recalcRegistration`), nunca a mano.

| Endpoint | Permiso | Qué hace |
|---|---|---|
| `POST /api/v2/registrations/:id/payments` | payments.write | Pago manual `{ method: cash\|check\|zelle\|other, itemIds?, reference?, notes? }` (sin `itemIds` = todo lo pendiente) |
| `POST /api/v2/payments/:id/void` | payments.write | Anula un pago manual capturado por error |
| `POST /api/v2/payments/:id/refund` | payments.write | Reembolso total o parcial `{ amountCents?, reason }` (con tarjeta se hace en Stripe) |
| `GET /api/v2/events/:id/payments` | lectura | Movimientos con totales cobrado / reembolsado / neto |
| `GET /api/v2/payments/stripe/account` | tenant.settings | Estado de la cuenta de Stripe del cliente |
| `POST /api/v2/payments/stripe/connect` | tenant.settings | Crea la cuenta conectada y da el enlace de alta en Stripe |
| `POST /api/v2/payments/stripe/refresh` | tenant.settings | Consulta el estado directo a Stripe |
| `POST /api/v2/public/registrations/:code/checkout` | público | Pagar con tarjeta (reintento o después de elegir efectivo) |
| `POST /api/v2/webhooks/stripe` | firma de Stripe | Webhook de Connect |

- **Stripe Connect (cuentas Standard):** cada cliente conecta su cuenta y el
  dinero le llega directo; la plataforma no guarda llaves del cliente.
- Con tarjeta el registro queda `pending_payment` (aparta su lugar) y recibe
  la URL de Checkout. Al pagar, el webhook lo confirma y manda el correo; si
  la sesión vence sin pago, el registro se cancela y libera el lugar.
- El webhook verifica la firma y es idempotente (`stripe_webhook_events`).
  Eventos: `checkout.session.completed`, `checkout.session.expired`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
  `charge.refunded`, `account.updated`.

**Probar Stripe en local (modo prueba):**
1. En tu cuenta de Stripe, activa el **modo de prueba** y habilita **Connect**
   (Settings → Connect).
2. Copia la llave secreta de prueba (`sk_test_...`) a `STRIPE_SECRET_KEY`.
3. Instala la [Stripe CLI](https://stripe.com/docs/stripe-cli) y corre
   `stripe listen --forward-connect-to localhost:3000/api/v2/webhooks/stripe`;
   copia el `whsec_...` que imprime a `STRIPE_WEBHOOK_SECRET`.
4. Como owner: `POST /api/v2/payments/stripe/connect`, abre el enlace y
   completa el alta de prueba. Luego activa `allowOnlinePayment` en el formulario.
5. Paga con la tarjeta de prueba `4242 4242 4242 4242` (cualquier fecha futura y CVC).
6. En producción, crea el webhook en el dashboard ("Eventos en cuentas
   conectadas") apuntando a `https://api.<tu dominio>/api/v2/webhooks/stripe`.

**Correos.** Sin `EMAIL_USER`/`EMAIL_PASS` no se envían: el contenido (con el
enlace) se escribe en el log, para probar invitaciones en local. Los enlaces
apuntan a `FRONT_URL_TEMPLATE`. En `email_messages` queda el registro de cada
envío, sin el cuerpo (los enlaces llevan tokens).

## CI

GitHub Actions corre typecheck, pruebas y build contra MariaDB 10.4, MySQL 8.4
y MySQL 9 en cada push a `main` y en cada pull request.
