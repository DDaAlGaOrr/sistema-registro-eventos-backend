-- =====================================================================
--  PROPUESTA DE ESQUEMA V2 (multitenant) — BORRADOR PARA REVISIÓN
--  Fase 2. NO es una migración: sirve para discutir y aprobar el diseño.
--
--  Convenciones:
--   * Compatible con MariaDB 10.4+ (desarrollo local, XAMPP) y MySQL 8/9
--     (producción, Railway). Probado en MariaDB 10.4.32: crea las 22 tablas
--     y los triggers sin errores.
--   * Collation utf8mb4_unicode_ci (existe en ambos; ignora acentos y
--     mayúsculas: "jose" = "José"). NO usar utf8mb4_0900_ai_ci: MariaDB no
--     la tiene.
--   * Columnas JSON: en MySQL son JSON nativo; en MariaDB son LONGTEXT con
--     CHECK(json_valid). La API las trata igual (las parsea si llegan como
--     texto). En consultas usar solo JSON_EXTRACT / JSON_UNQUOTE /
--     JSON_CONTAINS; NO usar JSON_TABLE, JSON_ARRAYAGG, JSON_OBJECTAGG ni
--     los operadores -> y ->> (no existen en MariaDB 10.4).
--   * Todas las fechas en UTC (DATETIME). Cada evento guarda su zona horaria
--     y el Front convierte para mostrar.
--   * Dinero en centavos (INT), nunca DECIMAL/FLOAT.
--   * Toda tabla de datos de cliente lleva tenant_id. Las relaciones críticas
--     usan FKs compuestas (id, tenant_id) para que la BD impida mezclar datos
--     de dos clientes aunque la API tenga un bug.
--   * IDs internos INT AUTO_INCREMENT; hacia afuera (URLs, QR) se usan
--     códigos públicos no adivinables (ULID).
-- =====================================================================

-- La base nueva se crea con:
--   CREATE DATABASE ... CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- =====================================================================
-- 1. CATÁLOGOS GLOBALES (compartidos por todos los clientes)
-- =====================================================================

CREATE TABLE us_states (
  id    SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code  CHAR(2)     NOT NULL UNIQUE,          -- 'AZ', 'CA'
  name  VARCHAR(60) NOT NULL
);

-- Jerarquía adventista en una sola tabla:
--   union (Union Conference) > conference (Asociación / Misión) > church
-- El catálogo es global: la Pacific Union existe sea o no cliente, y las
-- iglesias que se vayan capturando sirven para todos.
CREATE TABLE organizations (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  parent_id       INT UNSIGNED NULL,
  type            ENUM('union','conference','church') NOT NULL,
  name            VARCHAR(200) NOT NULL,
  short_name      VARCHAR(30)  NULL,              -- 'PUC', 'AZ', 'SECC'
  city            VARCHAR(120) NULL,              -- solo iglesias
  state_id        SMALLINT UNSIGNED NULL,         -- solo iglesias
  -- Catálogo de iglesias que se construye solo:
  --   verified : aparece en el select del formulario
  --   pending  : la escribió un participante ("mi iglesia no está"),
  --              espera que un admin la apruebe o la fusione
  --   merged   : era un duplicado/typo, apunta a la canónica
  status          ENUM('verified','pending','merged','inactive') NOT NULL DEFAULT 'verified',
  merged_into_id  INT UNSIGNED NULL,
  source          ENUM('seed','admin','registration') NOT NULL DEFAULT 'admin',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_org_name (parent_id, type, name),  -- ai_ci: evita "Shalom SDA" vs "shalom sda"
  KEY idx_org_children (parent_id, type, status),
  CONSTRAINT fk_org_parent FOREIGN KEY (parent_id)      REFERENCES organizations(id),
  CONSTRAINT fk_org_merged FOREIGN KEY (merged_into_id) REFERENCES organizations(id),
  CONSTRAINT fk_org_state  FOREIGN KEY (state_id)       REFERENCES us_states(id)
);

-- Estados que cubre cada asociación (reemplaza conferencia_estado).
-- Sirve para el filtro estado → asociación del formulario.
CREATE TABLE organization_states (
  organization_id INT UNSIGNED      NOT NULL,
  state_id        SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (organization_id, state_id),
  KEY idx_os_state (state_id),
  CONSTRAINT fk_os_org   FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_os_state FOREIGN KEY (state_id)        REFERENCES us_states(id)
);

-- =====================================================================
-- 2. CLIENTES (TENANTS)
-- =====================================================================

-- El cliente que contrata. Su raíz es una Unión o una Asociación; puede
-- operar eventos de esa organización y de todas sus descendientes.
CREATE TABLE tenants (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  root_organization_id INT UNSIGNED NOT NULL,
  name                 VARCHAR(150) NOT NULL,
  slug                 VARCHAR(63)  NOT NULL UNIQUE,     -- {slug}.tuapp.com
  status               ENUM('active','suspended','cancelled') NOT NULL DEFAULT 'active',
  default_locale       ENUM('es','en') NOT NULL DEFAULT 'es',
  timezone             VARCHAR(40)  NOT NULL DEFAULT 'America/Los_Angeles',
  -- Marca propia
  logo_url             VARCHAR(500) NULL,
  primary_color        CHAR(7)      NULL,                 -- '#4F46E5'
  secondary_color      CHAR(7)      NULL,
  email_from_name      VARCHAR(120) NULL,
  email_reply_to       VARCHAR(150) NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tenant_root (root_organization_id),
  CONSTRAINT fk_tenant_root FOREIGN KEY (root_organization_id) REFERENCES organizations(id)
);

-- Dominios que resuelven a un tenant (subdominio hoy, dominio propio después).
CREATE TABLE tenant_domains (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT UNSIGNED NOT NULL,
  hostname    VARCHAR(253) NOT NULL UNIQUE,   -- 'pacific.tuapp.com'
  is_primary  TINYINT(1)   NOT NULL DEFAULT 0,
  verified_at DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_td_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Cuenta de Stripe de cada cliente (Stripe Connect, cuenta Standard).
-- Nunca guardamos llaves secretas del cliente: solo el acct_... conectado.
CREATE TABLE tenant_payment_accounts (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id           INT UNSIGNED NOT NULL,
  provider            ENUM('stripe') NOT NULL DEFAULT 'stripe',
  external_account_id VARCHAR(64)  NOT NULL,          -- acct_...
  livemode            TINYINT(1)   NOT NULL,
  charges_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  payouts_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  details_submitted   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tpa_external (provider, external_account_id),
  UNIQUE KEY uq_tpa_tenant   (tenant_id, provider, livemode),
  CONSTRAINT fk_tpa_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- =====================================================================
-- 3. USUARIOS Y PERMISOS
-- =====================================================================

-- Identidad global (una persona = un login).
CREATE TABLE users (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                 VARCHAR(120) NOT NULL,
  email                VARCHAR(150) NOT NULL UNIQUE,
  password_hash        VARCHAR(255) NOT NULL,
  is_platform_admin    TINYINT(1)   NOT NULL DEFAULT 0,   -- antes 'developer'
  is_active            TINYINT(1)   NOT NULL DEFAULT 1,
  must_change_password TINYINT(1)   NOT NULL DEFAULT 0,
  failed_login_count   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until         DATETIME NULL,
  last_login_at        DATETIME NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Un rol por persona dentro de un cliente (aplica a todos sus eventos).
--   owner   = superadmin  : todo
--   finance = finanzas    : pagos y finanzas
--   staff   = staff       : editar datos de registrados y check-in
--   viewer  = admin / vicePresident : solo lectura
-- scope_organization_id limita lo que ve:
--   NULL                 → todo el cliente
--   id de una asociación → solo eventos que organiza esa asociación (o sus
--                          iglesias) y, en eventos de la Unión, solo los
--                          registrados de esa asociación.
--   (ej. "Hispanic Coordinator AZ" = viewer con scope = Arizona Conference)
CREATE TABLE tenant_memberships (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id             INT UNSIGNED NOT NULL,
  user_id               INT UNSIGNED NOT NULL,
  role                  ENUM('owner','finance','staff','viewer') NOT NULL,
  scope_organization_id INT UNSIGNED NULL,
  is_active             TINYINT(1) NOT NULL DEFAULT 1,
  created_by            INT UNSIGNED NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_membership (tenant_id, user_id),
  KEY idx_membership_user (user_id),
  CONSTRAINT fk_tm_tenant FOREIGN KEY (tenant_id)             REFERENCES tenants(id),
  CONSTRAINT fk_tm_user   FOREIGN KEY (user_id)               REFERENCES users(id),
  CONSTRAINT fk_tm_scope  FOREIGN KEY (scope_organization_id) REFERENCES organizations(id)
);

-- Tokens de sesión (refresh), invitación y recuperación de contraseña.
-- Se guarda solo el hash SHA-256, nunca el token.
CREATE TABLE user_tokens (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  type        ENUM('refresh','invite','password_reset') NOT NULL,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  revoked_at  DATETIME NULL,
  ip          VARBINARY(16) NULL,
  user_agent  VARCHAR(255)  NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ut_user (user_id, type),
  CONSTRAINT fk_ut_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- =====================================================================
-- 4. EVENTOS Y FORMULARIOS DINÁMICOS
-- =====================================================================

CREATE TABLE events (
  id                        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id                 INT UNSIGNED NOT NULL,
  organizer_organization_id INT UNSIGNED NOT NULL,   -- unión, asociación o iglesia del árbol del cliente
  slug                      VARCHAR(80)  NOT NULL,   -- {tenant}.tuapp.com/{slug}
  name                      JSON NOT NULL,           -- {"es": "...", "en": "..."}
  description               JSON NULL,
  venue                     VARCHAR(200) NULL,
  starts_at                 DATETIME NOT NULL,       -- UTC
  ends_at                   DATETIME NOT NULL,
  timezone                  VARCHAR(40)  NOT NULL,   -- 'America/Phoenix'
  status                    ENUM('draft','published','closed','archived') NOT NULL DEFAULT 'draft',
  cover_image_url           VARCHAR(500) NULL,
  created_by                INT UNSIGNED NULL,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at                DATETIME NULL,
  UNIQUE KEY uq_event_slug   (tenant_id, slug),
  UNIQUE KEY uq_event_tenant (id, tenant_id),
  KEY idx_event_organizer (organizer_organization_id),
  CONSTRAINT fk_event_tenant    FOREIGN KEY (tenant_id)                 REFERENCES tenants(id),
  CONSTRAINT fk_event_organizer FOREIGN KEY (organizer_organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_event_creator   FOREIGN KEY (created_by)                REFERENCES users(id)
);

-- Un evento puede tener uno o más formularios (ej. participantes y staff).
-- El interruptor de pagos vive aquí: no todos los formularios cobran.
CREATE TABLE forms (
  id                     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id              INT UNSIGNED NOT NULL,
  event_id               INT UNSIGNED NOT NULL,
  title                  JSON NOT NULL,
  status                 ENUM('draft','open','closed') NOT NULL DEFAULT 'draft',
  published_version_id   INT UNSIGNED NULL,          -- versión vigente
  opens_at               DATETIME NULL,              -- apertura de registro (UTC)
  closes_at              DATETIME NULL,              -- cierre de registro (UTC)
  max_registrations      INT UNSIGNED NULL,          -- opcional, NULL = sin cupo
  -- Configuración de pagos
  payments_enabled       TINYINT(1) NOT NULL DEFAULT 0,
  allow_online_payment   TINYINT(1) NOT NULL DEFAULT 0,  -- Stripe Checkout
  allow_offline_payment  TINYINT(1) NOT NULL DEFAULT 1,  -- efectivo/otro, lo registra finanzas
  currency               CHAR(3)    NOT NULL DEFAULT 'usd',
  -- Correo de confirmación, mensaje final, etc. ({es, en})
  settings               JSON NULL,
  created_by             INT UNSIGNED NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_form_tenant (id, tenant_id),
  KEY idx_form_event (event_id),
  CONSTRAINT fk_form_event FOREIGN KEY (event_id, tenant_id) REFERENCES events(id, tenant_id)
);

-- La estructura del formulario es un JSON versionado. Una versión publicada
-- es inmutable; editar el formulario crea una versión nueva. Cada registro
-- apunta a la versión con la que se llenó, así nunca se "rompen" respuestas
-- viejas. (Ver ejemplo de schema_json al final del archivo.)
CREATE TABLE form_versions (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  form_id      INT UNSIGNED NOT NULL,
  version      INT UNSIGNED NOT NULL,
  schema_json  JSON NOT NULL,
  status       ENUM('draft','published','superseded') NOT NULL DEFAULT 'draft',
  published_at DATETIME NULL,
  published_by INT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_form_version (form_id, version),
  CONSTRAINT fk_fv_form      FOREIGN KEY (form_id)      REFERENCES forms(id),
  CONSTRAINT fk_fv_publisher FOREIGN KEY (published_by) REFERENCES users(id)
);

ALTER TABLE forms
  ADD CONSTRAINT fk_form_published_version
  FOREIGN KEY (published_version_id) REFERENCES form_versions(id);

-- Conceptos cobrables del formulario: cuota de inscripción y productos
-- (playera, comida...). Reemplaza las columnas fijas pago_camiseta /
-- pago_lunchtime / incluir_camisa / incluir_lunchtime.
CREATE TABLE form_items (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id            INT UNSIGNED NOT NULL,
  form_id              INT UNSIGNED NOT NULL,
  code                 VARCHAR(40) NOT NULL,       -- 'registration_fee', 'tshirt', 'lunch'
  kind                 ENUM('registration_fee','product') NOT NULL,
  name                 JSON NOT NULL,
  description          JSON NULL,
  price_cents          INT UNSIGNED NOT NULL DEFAULT 0,
  is_required          TINYINT(1) NOT NULL DEFAULT 0,   -- la cuota suele ser obligatoria
  max_per_registration SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  sort_order           SMALLINT NOT NULL DEFAULT 0,
  is_active            TINYINT(1) NOT NULL DEFAULT 1,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_item_code (form_id, code),
  CONSTRAINT fk_item_form FOREIGN KEY (form_id, tenant_id) REFERENCES forms(id, tenant_id)
);

-- Variantes de un producto (tallas de playera). Reemplaza tallas_camiseta.
CREATE TABLE form_item_variants (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  item_id              INT UNSIGNED NOT NULL,
  code                 VARCHAR(20) NOT NULL,       -- 'S', 'M', 'L'
  label                JSON NOT NULL,
  price_cents_override INT UNSIGNED NULL,          -- ej. XXL más cara
  stock                INT UNSIGNED NULL,          -- NULL = sin límite
  sort_order           SMALLINT NOT NULL DEFAULT 0,
  is_active            TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_variant_code (item_id, code),
  CONSTRAINT fk_variant_item FOREIGN KEY (item_id) REFERENCES form_items(id)
);

-- =====================================================================
-- 5. REGISTROS
-- =====================================================================

-- Modelo híbrido:
--   * Campos "núcleo" en columnas (nombre, correo, asociación, iglesia...)
--     porque se buscan, filtran, ordenan y aparecen en todos los eventos.
--   * El resto de respuestas del formulario dinámico en `answers` (JSON),
--     validado contra form_versions.schema_json.
--   * Lo cobrable va en registration_items, no en answers.
CREATE TABLE registrations (
  id                         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_code                CHAR(26) NOT NULL UNIQUE,   -- ULID: va en el QR (no adivinable)
  tenant_id                  INT UNSIGNED NOT NULL,
  event_id                   INT UNSIGNED NOT NULL,
  form_id                    INT UNSIGNED NOT NULL,
  form_version_id            INT UNSIGNED NOT NULL,
  conference_organization_id INT UNSIGNED NULL,   -- base del filtro por alcance
  church_organization_id     INT UNSIGNED NULL,
  church_name_raw            VARCHAR(200) NULL,   -- tal cual lo escribió la persona
  first_name                 VARCHAR(100) NOT NULL,
  last_name                  VARCHAR(100) NOT NULL,
  email                      VARCHAR(150) NOT NULL,
  phone                      VARCHAR(30)  NULL,
  birth_date                 DATE NULL,
  gender                     ENUM('male','female','undisclosed') NULL,
  locale                     ENUM('es','en') NOT NULL DEFAULT 'es',
  answers                    JSON NOT NULL,
  status                     ENUM('pending_payment','confirmed','cancelled') NOT NULL DEFAULT 'confirmed',
  payment_status             ENUM('not_required','unpaid','partially_paid','paid','refunded') NOT NULL DEFAULT 'not_required',
  total_cents                INT UNSIGNED NOT NULL DEFAULT 0,
  paid_cents                 INT UNSIGNED NOT NULL DEFAULT 0,
  -- Check-in: uno por evento. El historial (incluido "deshacer") queda en
  -- audit_logs como registration.checked_in / registration.check_in_undone.
  checked_in_at              DATETIME NULL,
  checked_in_by              INT UNSIGNED NULL,
  checked_in_method          ENUM('qr','manual') NULL,
  source                    ENUM('public_form','admin','import') NOT NULL DEFAULT 'public_form',
  created_at                 DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at                 DATETIME NULL,       -- borrado lógico
  deleted_by                 INT UNSIGNED NULL,
  UNIQUE KEY uq_reg_tenant (id, tenant_id),
  KEY idx_reg_event_created  (event_id, deleted_at, created_at),
  KEY idx_reg_event_conf     (event_id, conference_organization_id),
  KEY idx_reg_event_church   (event_id, church_organization_id),
  KEY idx_reg_event_email    (event_id, email),
  KEY idx_reg_event_name     (event_id, last_name, first_name),
  KEY idx_reg_event_checkin  (event_id, checked_in_at),
  KEY idx_reg_event_payment  (event_id, payment_status),
  CONSTRAINT fk_reg_event   FOREIGN KEY (event_id, tenant_id) REFERENCES events(id, tenant_id),
  CONSTRAINT fk_reg_form    FOREIGN KEY (form_id, tenant_id)  REFERENCES forms(id, tenant_id),
  CONSTRAINT fk_reg_version FOREIGN KEY (form_version_id)     REFERENCES form_versions(id),
  CONSTRAINT fk_reg_conf    FOREIGN KEY (conference_organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_reg_church  FOREIGN KEY (church_organization_id)     REFERENCES organizations(id),
  CONSTRAINT fk_reg_checkin_user FOREIGN KEY (checked_in_by)         REFERENCES users(id)
);

-- Productos que pidió cada registrado. El estatus de pago es por concepto
-- porque finanzas puede cobrar la playera hoy y la comida otro día
-- (en FEJA 2026 hay 65 registros con playera pagada y comida pendiente).
CREATE TABLE registration_items (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  registration_id  INT UNSIGNED NOT NULL,
  item_id          INT UNSIGNED NOT NULL,
  variant_id       INT UNSIGNED NULL,
  quantity         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  unit_price_cents INT UNSIGNED NOT NULL,     -- precio congelado al registrarse
  payment_status   ENUM('not_required','unpaid','paid','refunded') NOT NULL DEFAULT 'unpaid',
  delivered_at     DATETIME NULL,             -- playera entregada / comida canjeada
  delivered_by     INT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reg_item (registration_id, item_id),
  KEY idx_ri_item (item_id, variant_id, payment_status),
  CONSTRAINT fk_ri_reg     FOREIGN KEY (registration_id) REFERENCES registrations(id),
  CONSTRAINT fk_ri_item    FOREIGN KEY (item_id)         REFERENCES form_items(id),
  CONSTRAINT fk_ri_variant FOREIGN KEY (variant_id)      REFERENCES form_item_variants(id),
  CONSTRAINT fk_ri_deliver FOREIGN KEY (delivered_by)    REFERENCES users(id)
);

-- =====================================================================
-- 6. PAGOS (Stripe + manuales)
-- =====================================================================

-- Un pago = un cobro (una sesión de Stripe Checkout o un pago en efectivo
-- que registra finanzas). Sin pagos parciales en Stripe: siempre cubre todo
-- lo pendiente del registro.
CREATE TABLE payments (
  id                         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id                  INT UNSIGNED NOT NULL,
  event_id                   INT UNSIGNED NOT NULL,
  registration_id            INT UNSIGNED NOT NULL,
  method                     ENUM('stripe','cash','check','zelle','other','legacy') NOT NULL,
  status                     ENUM('pending','succeeded','failed','canceled','refunded','partially_refunded') NOT NULL,
  amount_cents               INT UNSIGNED NOT NULL,
  refunded_cents             INT UNSIGNED NOT NULL DEFAULT 0,
  currency                   CHAR(3) NOT NULL DEFAULT 'usd',
  stripe_account_id          VARCHAR(64)  NULL,          -- acct_ del cliente
  stripe_checkout_session_id VARCHAR(255) NULL UNIQUE,
  stripe_payment_intent_id   VARCHAR(255) NULL UNIQUE,
  reference                  VARCHAR(120) NULL,          -- folio de recibo, # de cheque
  notes                      VARCHAR(500) NULL,
  recorded_by                INT UNSIGNED NULL,          -- pagos manuales: quién de finanzas
  paid_at                    DATETIME NULL,
  created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pay_reg (registration_id),
  KEY idx_pay_event (event_id, status, paid_at),
  CONSTRAINT fk_pay_reg  FOREIGN KEY (registration_id, tenant_id) REFERENCES registrations(id, tenant_id),
  CONSTRAINT fk_pay_user FOREIGN KEY (recorded_by) REFERENCES users(id)
);

-- Qué conceptos cubrió cada pago.
CREATE TABLE payment_items (
  payment_id           INT UNSIGNED NOT NULL,
  registration_item_id INT UNSIGNED NOT NULL,
  amount_cents         INT UNSIGNED NOT NULL,
  PRIMARY KEY (payment_id, registration_item_id),
  CONSTRAINT fk_pi_payment FOREIGN KEY (payment_id)           REFERENCES payments(id),
  CONSTRAINT fk_pi_item    FOREIGN KEY (registration_item_id) REFERENCES registration_items(id)
);

-- Reembolsos (Stripe los permite totales o parciales, por API o desde el
-- dashboard del cliente; se sincronizan por webhook).
CREATE TABLE refunds (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payment_id       INT UNSIGNED NOT NULL,
  amount_cents     INT UNSIGNED NOT NULL,
  reason           VARCHAR(255) NULL,
  status           ENUM('pending','succeeded','failed','canceled') NOT NULL,
  stripe_refund_id VARCHAR(255) NULL UNIQUE,
  created_by       INT UNSIGNED NULL,     -- NULL si vino del dashboard de Stripe
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_refund_payment FOREIGN KEY (payment_id) REFERENCES payments(id),
  CONSTRAINT fk_refund_user    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Webhooks recibidos: idempotencia (Stripe reintenta) y depuración.
CREATE TABLE stripe_webhook_events (
  id                VARCHAR(255) PRIMARY KEY,   -- evt_...
  type              VARCHAR(100) NOT NULL,
  stripe_account_id VARCHAR(64)  NULL,
  livemode          TINYINT(1)   NOT NULL,
  payload           JSON NOT NULL,
  received_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at      DATETIME(3) NULL,
  error             TEXT NULL,
  KEY idx_swe_pending (processed_at, received_at)
);

-- =====================================================================
-- 7. CORREOS (bandeja de salida con reintentos)
-- =====================================================================
-- Hoy el correo se manda "y si falla, ni modo". Con esta tabla se puede
-- reintentar, reenviar desde el admin y saber qué se mandó.
CREATE TABLE email_messages (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id           INT UNSIGNED NOT NULL,
  registration_id     INT UNSIGNED NULL,
  template            VARCHAR(60)  NOT NULL,   -- 'registration_confirmation', 'payment_receipt'
  locale              ENUM('es','en') NOT NULL,
  to_email            VARCHAR(150) NOT NULL,
  status              ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued',
  attempts            TINYINT UNSIGNED NOT NULL DEFAULT 0,
  provider_message_id VARCHAR(255) NULL,
  last_error          TEXT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at             DATETIME NULL,
  KEY idx_email_queue (status, created_at),
  KEY idx_email_reg (registration_id),
  CONSTRAINT fk_email_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- =====================================================================
-- 8. LOG DE AUDITORÍA V2
-- =====================================================================
-- Reemplaza admin_logs + log_checkins (auditoría) + log_pagos.
--   * Una sola tabla, solo inserción.
--   * Guarda ANTES y DESPUÉS de cada campo cambiado.
--   * Se escribe en la MISMA transacción que el cambio.
--   * Sin FKs a propósito: debe sobrevivir a cualquier borrado.
--   * Quién lo ve: el owner de cada cliente ve la de SU cliente (filtrada por
--     tenant_id); el admin de plataforma (developer) ve la de todos.
-- Acciones (ejemplos):
--   auth.login, auth.login_failed, user.invited, membership.role_changed,
--   event.created, form.version_published, form.settings_changed,
--   registration.created (actor = participant), registration.updated,
--   registration.deleted, registration.checked_in, registration.check_in_undone,
--   item.delivered, payment.recorded, payment.succeeded (actor = stripe),
--   payment.refunded, church.approved, church.merged, tenant.stripe_connected
CREATE TABLE audit_logs (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     INT UNSIGNED NULL,             -- NULL = acción de plataforma
  event_id      INT UNSIGNED NULL,
  actor_type    ENUM('user','participant','system','stripe') NOT NULL,
  actor_user_id INT UNSIGNED NULL,
  actor_name    VARCHAR(120) NULL,             -- copia del nombre al momento
  action        VARCHAR(60)  NOT NULL,
  entity_type   VARCHAR(40)  NOT NULL,         -- 'registration', 'payment', 'form_version'...
  entity_id     VARCHAR(40)  NULL,
  changes       JSON NULL,                     -- {"campo": {"from": x, "to": y}}
  metadata      JSON NULL,                     -- motivo, copia completa al borrar, etc.
  ip            VARBINARY(16) NULL,
  user_agent    VARCHAR(255)  NULL,
  request_id    CHAR(26)      NULL,            -- agrupa todo lo de una misma petición
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_tenant_time (tenant_id, created_at),
  KEY idx_audit_event_time  (event_id, created_at),
  KEY idx_audit_entity      (entity_type, entity_id, created_at),
  KEY idx_audit_actor       (actor_user_id, created_at)
);

-- Solo inserción, reforzado en la BD (además de que la API no exponga
-- UPDATE/DELETE). Alternativa: un usuario MySQL para la app sin esos privilegios.
-- Ojo al exportar desde MariaDB: el dump trae DEFINER=`root`@`localhost` en
-- los triggers; quitarlo antes de importar en Railway (o crearlos con la
-- migración directamente allá).
DELIMITER $$
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs es solo de inserción';
END$$
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs es solo de inserción';
END$$
DELIMITER ;

-- =====================================================================
-- ANEXO A. Ejemplo de form_versions.schema_json (formulario FEJA 2026)
-- =====================================================================
-- Tipos de campo:
--   text, textarea, email, phone, number, date, checkbox, radio, select,
--   consent, y de sistema: state_conference_picker, church_picker,
--   item_toggle (quiero playera/comida), item_variant (talla).
-- "maps_to" indica que el valor va a una columna núcleo de registrations;
-- sin maps_to, el valor se guarda en registrations.answers.
-- "visible_when" es la lógica condicional (y si está oculto no se valida).
--
-- {
--   "steps": [
--     {
--       "key": "personal",
--       "title": {"es": "Datos personales", "en": "Personal information"},
--       "fields": [
--         {"key": "first_name", "type": "text",  "maps_to": "first_name", "required": true,
--          "label": {"es": "Nombre", "en": "First name"}},
--         {"key": "last_name",  "type": "text",  "maps_to": "last_name",  "required": true,
--          "label": {"es": "Apellidos", "en": "Last name"}},
--         {"key": "email",      "type": "email", "maps_to": "email",      "required": true,
--          "label": {"es": "Correo", "en": "Email"}},
--         {"key": "birth_date", "type": "date",  "maps_to": "birth_date", "required": true,
--          "label": {"es": "Fecha de nacimiento", "en": "Date of birth"}},
--         {"key": "location",   "type": "state_conference_picker", "required": true},
--         {"key": "church",     "type": "church_picker", "allow_new": true, "required": true,
--          "label": {"es": "Iglesia", "en": "Church"}},
--         {"key": "is_chaperone", "type": "radio", "required": true,
--          "label": {"es": "¿Eres chaperón?", "en": "Are you a chaperone?"},
--          "options": [{"value": true,  "label": {"es": "Sí", "en": "Yes"}},
--                      {"value": false, "label": {"es": "No", "en": "No"}}]},
--         {"key": "wants_tshirt", "type": "item_toggle", "item": "tshirt",
--          "label": {"es": "Quiero playera", "en": "I want a T-shirt"}},
--         {"key": "tshirt_size",  "type": "item_variant", "item": "tshirt", "required": true,
--          "visible_when": {"field": "wants_tshirt", "equals": true},
--          "label": {"es": "Talla", "en": "Size"}},
--         {"key": "wants_lunch",  "type": "item_toggle", "item": "lunch",
--          "label": {"es": "Agregar comida", "en": "Add lunch"}},
--         {"key": "diet", "type": "select", "required": true,
--          "visible_when": {"field": "wants_lunch", "equals": true},
--          "label": {"es": "Preferencia alimenticia", "en": "Dietary preference"},
--          "options": [{"value": "regular",    "label": {"es": "Normal", "en": "Regular"}},
--                      {"value": "vegetarian", "label": {"es": "Vegetariana", "en": "Vegetarian"}},
--                      {"value": "vegan",      "label": {"es": "Vegana", "en": "Vegan"}},
--                      {"value": "other",      "label": {"es": "Otra", "en": "Other"}}]},
--         {"key": "diet_note", "type": "text",
--          "visible_when": {"field": "diet", "equals": "other"},
--          "label": {"es": "Especifica", "en": "Please specify"}}
--       ]
--     },
--     {
--       "key": "emergency",
--       "title": {"es": "Contacto de emergencia", "en": "Emergency contact"},
--       "fields": [
--         {"key": "emergency_name",  "type": "text",  "required": true, "label": {"es": "Nombre", "en": "Name"}},
--         {"key": "emergency_phone", "type": "phone", "required": true, "label": {"es": "Teléfono", "en": "Phone"}},
--         {"key": "emergency_relationship", "type": "text", "required": true,
--          "label": {"es": "Relación", "en": "Relationship"}}
--       ]
--     }
--   ]
-- }
--
-- registrations.answers resultante:
--   {"is_chaperone": false, "diet": "vegan", "emergency_name": "...",
--    "emergency_phone": "...", "emergency_relationship": "Madre"}
-- registration_items: (tshirt, variant M, 400, unpaid), (lunch, 200, paid)

-- =====================================================================
-- ANEXO B. Mapeo de migración V1 → V2 (FEJA Nivel Unión 2026)
-- =====================================================================
-- tenant            : Pacific Union Conference (raíz = organización union)
-- conferencias (7)  : organizations type='conference', parent = Pacific Union
-- conferencia_estado: organization_states
-- estados           : us_states (se cargan los 50 + DC)
-- iglesia (texto)   : organizations type='church' status='verified' con el
--                     nombre de normalizarIglesia(); church_name_raw = original
-- eventos id=2      : events + forms + form_versions (schema del Anexo A)
-- eventos id=1      : no se migra (prueba)
-- form_items        : tshirt = 400 centavos ($4), variantes XS,S,M,L,XL
--                     lunch  = 200 centavos ($2)
--                     (sin cuota de inscripción en FEJA 2026)
-- registros         : registrations (genero → male/female/undisclosed,
--                     created_at convertido a UTC, public_code nuevo)
--   incluir_camisa/pago_camiseta   → registration_items(tshirt):
--        pagado → paid, pendiente → unpaid, no_aplica → sin item
--   incluir_lunchtime/pago_lunchtime → registration_items(lunch): igual
--   tipo_alimento, alimento_especial_nota, es_chaperon → answers
--   items pagados → payments(method='legacy', status='succeeded') + payment_items
--   checkin_at → checked_in_at (+ checked_in_by desde log_checkins)
-- contactos_emergencia : answers.emergency_*
-- admins            : users + tenant_memberships
--   developer → is_platform_admin=1   superadmin → owner
--   finanzas  → finance               staff      → staff
--   vicePresident → viewer (sin alcance)
--   admin     → viewer con alcance a su asociación (ej. "Hispanic Coordinator AZ")
-- admin_logs + log_checkins : audit_logs (changes solo con "to", no hay "from")
-- Verificación: conteos por tabla y totales de $ pagados deben cuadrar con V1.
