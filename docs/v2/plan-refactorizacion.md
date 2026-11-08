# Plan de refactorización V1 → V2 (SaaS multitenant)

Fase 3. Depende del esquema en [schema-propuesta.sql](schema-propuesta.sql).
Cada paso termina en algo que se puede probar; ninguno deja el sistema a medias.

## Decisiones técnicas

| Tema | Decisión | Por qué |
|---|---|---|
| Base de datos | **MariaDB local (XAMPP) y MySQL en Railway**, con el subconjunto de SQL que funciona en ambos | Es como ya se trabajó V1. Reglas en "Compatibilidad MariaDB ↔ MySQL" abajo. |
| Acceso a datos | **Kysely** (query builder tipado) sobre `mysql2`, con sus migraciones en TypeScript | Las migraciones viven en el repo: se acaba el `db.sql` desfasado. Escribe SQL explícito, así que se controla qué funciones se usan. Descarté Drizzle porque drizzle-kit no soporta MariaDB oficialmente. |
| Validación | **Zod** | Valida bodies de la API y, generado desde `schema_json`, las respuestas de los formularios dinámicos. |
| Logs del servidor | **pino** + `request_id` | El mismo `request_id` se guarda en `audit_logs`. |
| Correo | Proveedor transaccional (**Resend**, **Postmark** o **SES**) en vez de Gmail | Gmail no permite remitente por cliente y limita envíos. |
| Pruebas | **Vitest + supertest** contra una BD de pruebas en el MariaDB local | Sobre todo aislamiento entre clientes y permisos. |
| Sesión | Access token JWT corto (15 min, en memoria) + refresh token en cookie `httpOnly` | Hoy el token vive en `localStorage` y el rol se lee de ahí. |
| Cliente (tenant) | Se resuelve por el **subdominio** (`pacific.tuapp.com`) en formulario público y admin | Una sola regla; el admin de plataforma entra por `app.tuapp.com`. |
| Idioma | Identificadores de código/BD en inglés; **todo lo que ve el usuario en español e inglés** (`{es, en}` en BD, ngx-translate en el Front) | El idioma interno no afecta al usuario. |
| Front | Se queda Angular 17 (actualizar después, no ahora) | Evitar dos migraciones a la vez. |
| Ramas | Rama `v2` en ambos repos | V1 ya no está en uso; se reemplaza al final. |

## Compatibilidad MariaDB ↔ MySQL

Desarrollo en MariaDB 10.4 (XAMPP), producción en MySQL 9 (Railway). Funciona si se respetan estas reglas:

1. **Collation `utf8mb4_unicode_ci`** en la base y en todas las tablas. `utf8mb4_0900_ai_ci` no existe en MariaDB.
2. **JSON:** declarar columnas `JSON` (MariaDB las guarda como `LONGTEXT` con `CHECK(json_valid)`). En el código, un helper parsea el valor si llega como texto, porque `mysql2` devuelve objeto en MySQL y string en MariaDB.
3. **Funciones permitidas:** `JSON_EXTRACT`, `JSON_UNQUOTE`, `JSON_CONTAINS`, `JSON_OBJECT`, CTEs y funciones de ventana. **No usar** `JSON_TABLE`, `JSON_ARRAYAGG`, `JSON_OBJECTAGG` ni los operadores `->` / `->>` (no existen en MariaDB 10.4).
4. **El esquema se crea con las migraciones** en cada entorno (`npm run migrate`). Exportar/importar como en V1 sirve para los **datos**; si se exporta también la estructura, quitar `DEFINER=...` de los triggers antes de importar en Railway.
5. **Antes de cada salida a producción**, correr las migraciones en una BD de staging en Railway (MySQL 9) para detectar cualquier diferencia antes que los usuarios.

## Matriz de permisos (se valida en la API, el Front solo oculta botones)

| Permiso | owner | finance | staff | viewer | plataforma |
|---|:-:|:-:|:-:|:-:|:-:|
| Ver resumen, registros, logística | ✓ | ✓ | ✓ | ✓ | ✓ |
| Editar datos de un registro | ✓ | – | ✓ | – | ✓ |
| Borrar registro (lógico) | ✓ | – | ✓ | – | ✓ |
| Check-in / entregas | ✓ | – | ✓ | – | ✓ |
| Pagos: registrar, marcar, reembolsar | ✓ | ✓ | – | – | ✓ |
| Eventos y formularios | ✓ | – | – | – | ✓ |
| Usuarios, iglesias, marca, Stripe | ✓ | – | – | – | ✓ |
| Auditoría | ✓ (su cliente) | – | – | – | ✓ (todos) |
| Clientes (alta, suspensión) | – | – | – | – | ✓ |

El **alcance** (`scope_organization_id`) se aplica encima de esta matriz.

---

## Paso 0 — Correcciones críticas en V1

Se hace sobre el código actual porque estas piezas pasan casi tal cual a V2.

1. `updateRegister`: lista blanca de columnas editables por rol (adiós inyección SQL y asignación masiva).
2. `requireAuth` en `/logs`, `/events/stream`, `/events/recent-activity/:id`, `/resumen` y gráficas.
3. Middleware `requireRole([...])` en la API con la matriz de arriba.
4. Registrar `errorHandler` en `index.ts`; `AppError` con 404/409 (ej. "ya tiene check-in").
5. Quitar `return res.status(...)` dentro de `catchAsync` (login, me).
6. JWT: `name: user.nombre`; agregar `JWT_SECRET` y demás variables a `.env-example` y validarlas al arrancar.
7. `getRegistration` (doble `[0]`) y `lastRegisters` (`evento_id = 2` fijo).
8. `helmet`, CORS con lista de orígenes, `express-rate-limit` en login y registro público.
9. Validación Zod del body del registro público.
10. Rotar las contraseñas que comparten hash (developer, finanzas, staff).

## Paso 1 — Fundaciones de la API (rama `v2`)

1. Estructura por módulos:
   ```
   src/
     config/        env validado con Zod
     db/            cliente Kysely, tipos, migrations/, seeds/
     core/          errors, http (catchAsync), logger, request-context (AsyncLocalStorage)
     modules/
       auth/ tenants/ organizations/ users/ events/ forms/
       registrations/ checkin/ payments/ reports/ audit/ email/ public/
   ```
   Cada módulo: `routes → controller → service → repository`.
2. `request-context`: `requestId`, `tenantId`, `user`, `role`, `scope` disponibles en cualquier capa.
3. Pruebas: Vitest + supertest + BD de pruebas; script `npm test` y GitHub Actions (lint + test).

## Paso 2 — Esquema V2 y migración de datos

1. Pasar `schema-propuesta.sql` a migraciones de Kysely (incluidos los triggers de auditoría) y probarlas en MariaDB local y en una BD de staging en Railway.
2. Seeds: `us_states`, Pacific Union y sus 7 asociaciones.
3. Script de migración FEJA (Anexo B del esquema), en modo prueba sobre una copia del dump.
4. Verificación automática: conteos por tabla, registros con playera/comida pagada, totales en dólares.

## Paso 3 — Núcleo: autenticación, clientes, permisos y auditoría ✅ Hecho

Es la pieza de la que depende todo lo demás; va con pruebas desde el inicio.

1. Middleware `resolveTenant` (Host → `tenant_domains`/`slug`) con caché.
2. Auth: login, refresh, logout, `me` (devuelve rol, alcance y permisos), bloqueo tras intentos fallidos. ✅ Hecho. (Invitación y recuperación de contraseña se pasaron al Paso 4, junto con el envío de correos.)
3. `requirePermission('payments.write')` y helper de alcance: si el usuario tiene alcance, toda consulta de registros agrega `conference_organization_id IN (subárbol)`.
4. Repositorios que **exigen** `tenantId` (no se puede consultar sin él).
5. `audit.record(trx, {...})` + helper `diff(antes, después)`; se llama dentro de la transacción del cambio.
6. Pruebas de aislamiento: un usuario del cliente A nunca lee ni modifica datos del cliente B; un viewer con alcance AZ no ve registros de CA.

## Paso 4 — Administración básica ✅ Hecho

1. Organizaciones: árbol del cliente; iglesias pendientes → aprobar, editar o fusionar (al fusionar se reasignan los registros y se audita).
2. Usuarios del cliente: invitar (correo con enlace), recuperar contraseña, cambiar rol/alcance, desactivar.
3. Eventos: CRUD, estados draft/published/closed/archived, zona horaria.
4. Marca del cliente: logo, colores, remitente.
5. Panel de plataforma: alta de clientes (invita a su owner), suspender, catálogo de uniones y asociaciones.
6. Pendiente para cuando un cliente pida dominio propio: CORS para `tenant_domains` y `TRUST_PROXY` configurable (rewrite de Vercel).

## Paso 5 — Formularios dinámicos (API) ✅ Hecho

1. Meta-esquema Zod que valida `schema_json` (tipos de campo, `{es,en}` obligatorios, `visible_when` apuntando a campos existentes, `item` apuntando a `form_items` existentes).
2. CRUD de formularios, ítems y variantes; precios en centavos.
3. Versiones: editar = borrador; publicar = versión inmutable y la anterior pasa a `superseded`; auditoría `form.version_published` con el diff.
4. Generador `schema_json → validador Zod` para las respuestas (respeta `visible_when` y `required`).

## Paso 6 — Registro público (API) ✅ Hecho

1. `GET /public/events/:slug` → evento, formulario vigente, ítems, iglesias verificadas de cada asociación.
2. `POST /public/events/:slug/registrations`:
   - valida fechas de apertura/cierre, cupo y respuestas;
   - "mi iglesia no está" → crea iglesia `pending` (no visible hasta aprobar);
   - crea registro + `registration_items` con precio congelado + `total_cents`;
   - si hay pago en línea → estado `pending_payment` y devuelve URL de Stripe Checkout; si no → `confirmed`;
   - audita `registration.created` (actor = participante) y encola el correo.
3. Captcha opcional (Cloudflare Turnstile) y rate limit por IP.
4. Worker de correos: procesa `email_messages`, reintenta, plantillas `{es,en}` con la marca del cliente y el QR (`public_code`).

## Paso 7 — Operación del evento (API) ✅ Hecho

1. Registros: lista paginada y filtrada en el servidor (búsqueda, asociación, iglesia, estatus de pago, check-in), detalle, edición con diff auditado, borrado lógico.
2. Check-in por `public_code` (QR) o manual; deshacer; responde en una sola llamada lo que staff necesita ver (productos pagados/pendientes, si ya entró).
3. Entregas: marcar playera entregada / comida canjeada.
4. Reportes en una consulta cada uno: KPIs, registros por semana, por asociación, tallas (pagadas/pendientes/entregadas), dietas, ingresos por método.
5. Exportación CSV/PDF desde el servidor (respeta alcance).
6. Tiempo real: se eligió **consulta periódica** (`GET /events/:id/activity?after=`) en lugar de SSE: funciona igual detrás de los proxies de Vercel/Railway y no requiere mandar el token en la URL.

## Paso 8 — Pagos (API) ✅ Hecho

1. Pagos manuales: finanzas registra efectivo/cheque/Zelle por conceptos → actualiza `registration_items` y totales, en una transacción auditada.
2. Stripe Connect: endpoint de onboarding (Account Link) y retorno; webhook `account.updated` para `charges_enabled`.
3. Checkout: sesión creada en la cuenta del cliente con los conceptos pendientes; expira si no se paga.
4. Webhook `/webhooks/stripe` (body crudo + firma): `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`; idempotente vía `stripe_webhook_events`.
5. Reembolsos totales o parciales desde el panel (si se habilitan).
6. Todo primero en modo prueba de Stripe.

## Paso 9 — Fundaciones del Front

1. Al arrancar, carga la configuración del cliente por subdominio (logo, colores como variables CSS, idioma por defecto).
2. Auth nueva: token en memoria, refresh por cookie, interceptor que renueva en 401; guards y directiva `*appCan="'payments.write'"` con los permisos de `/me`.
3. Layout admin con selector de evento; rutas `/admin/events/:eventId/...`.
4. Panel admin también bilingüe.
5. Borrar servicios mock (`dashboard.json`, `logs.json`, `registered.json`) y tipos de rol duplicados.

## Paso 10 — Formulario público dinámico (Front) ✅ Hecho

1. `DynamicFormComponent`: construye los `FormGroup` desde `schema_json`, muestra/oculta por `visible_when`, textos según idioma.
2. Componentes de campo: texto, número, fecha, checkbox, radio, select, consentimiento, selector estado→asociación, selector de iglesia con "no está en la lista", producto + variante.
3. Paso de resumen generado automáticamente, con total a pagar.
4. Pago: redirección a Stripe Checkout o "pagaré en efectivo"; páginas de éxito/cancelado.
5. Confirmación con QR descargable.
6. Reemplaza los componentes fijos `step1` a `step5`. ✅ Se retiró el formulario de V1; los enlaces viejos (`/registro/2`) llevan al inicio del cliente.
7. Pendiente: captcha (Turnstile) en el formulario; solo hace falta si se activa en la API.

## Paso 11 — Vistas admin consolidadas (Front)

| Vista | Propósito | Qué tiene |
|---|---|---|
| **Resumen** | Ver cómo va el evento | KPIs y gráficas; sin tablas de personas |
| **Registros** | Directorio y edición | Tabla paginada en servidor + panel lateral del registro (datos, productos y pagos, historial de auditoría de ese registro) |
| **Check-in** | Operación en la puerta | Escáner QR, búsqueda rápida, alerta de pagos pendientes, entregas; pensado para celular |
| **Logística** | Lo que hay que comprar/entregar | Totales por talla y dieta (pagado / pendiente / entregado), listas exportables por proveedor |
| **Pagos** | Finanzas | Movimientos, registrar pago manual, reembolsos, totales por método |
| **Auditoría** | Quién hizo qué | Filtros por usuario, acción, registro y fecha |

Un solo componente de edición de registro (hoy está copiado en Registrados y Check-in).

**Avance (se entrega en tres partes):**
- **11a ✅ Resumen y Registros.** Resumen con KPIs, gráficas y actividad en vivo; Registros con filtros, paginación en servidor, exportación CSV y panel lateral (datos editables, respuestas con sus etiquetas, productos/entregas/talla, pagos, historial, papelera). El panel (`registration-panel`) es el componente único que reutilizará Check-in.
- **11b ✅ Check-in y Logística.** Check-in pensado para celular: escáner QR (cámara), búsqueda por nombre/código, ficha con saldo pendiente, entregas y registro de entrada, con aviso de "ya hizo check-in" o cancelado. Logística: totales por producto y talla (pagado / sin pagar / entregado / por entregar), respuestas con opciones (dieta) y CSV para proveedor o lista de personas por producto/talla.
- **11c ⏳ Pagos (registrar pago manual y reembolsos desde la vista y desde el panel) y Auditoría.**

## Paso 12 — Constructor de formularios (Front)

1. Lista de pasos y campos con arrastrar y soltar (Angular CDK).
2. Panel de propiedades: etiquetas `{es, en}` lado a lado, obligatorio, opciones, condición "mostrar si…".
3. Productos y variantes con precio.
4. Vista previa usando el mismo `DynamicFormComponent`.
5. Guardar borrador / publicar versión; aviso si ya hay registros con la versión anterior.

Va al final a propósito: mientras tanto, el formulario de FEJA migrado (y los de prueba) se cargan como JSON.

## Paso 13 — Configuración del cliente (Front)

Usuarios y roles, moderación de iglesias, marca, conexión con Stripe.

## Paso 14 — Salida a producción

1. Migración real de FEJA sobre la BD nueva y verificación de totales.
2. DNS comodín `*.tuapp.com` + certificado (verificar soporte en Railway y en el hosting del Front).
3. Staging con Stripe en modo prueba → producción.
4. V1 queda de solo lectura como respaldo.

## Fuera de alcance por ahora

Registro grupal, cobro de suscripción a los clientes (Stripe Billing), política de retención de datos de menores (el esquema ya permite borrado lógico y anonimizar después).
