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

**Correos.** Sin `EMAIL_USER`/`EMAIL_PASS` no se envían: el contenido (con el
enlace) se escribe en el log, para probar invitaciones en local. Los enlaces
apuntan a `FRONT_URL_TEMPLATE`. En `email_messages` queda el registro de cada
envío, sin el cuerpo (los enlaces llevan tokens).

## CI

GitHub Actions corre typecheck, pruebas y build contra MariaDB 10.4, MySQL 8.4
y MySQL 9 en cada push a `main` y en cada pull request.
