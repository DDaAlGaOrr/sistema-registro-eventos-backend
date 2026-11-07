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

## CI

GitHub Actions corre typecheck, pruebas y build contra MariaDB 10.4, MySQL 8.4
y MySQL 9 en cada push a `main` y en cada pull request.
