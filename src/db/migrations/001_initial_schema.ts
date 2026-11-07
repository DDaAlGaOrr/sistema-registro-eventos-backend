import { Kysely, sql } from 'kysely';

/**
 * Esquema inicial V2 (multitenant). Generado a partir de
 * docs/v2/schema-propuesta.sql (revisado y aprobado en la Fase 2).
 *
 * Compatible con MariaDB 10.4+ y MySQL 8/9: collation utf8mb4_unicode_ci
 * explícita en cada tabla para que no dependa del default del servidor.
 */
const UP: string[] = [
    `CREATE TABLE us_states (
       id    SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       code  CHAR(2)     NOT NULL UNIQUE,
       name  VARCHAR(60) NOT NULL
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE organizations (
       id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       parent_id       INT UNSIGNED NULL,
       type            ENUM('union','conference','church') NOT NULL,
       name            VARCHAR(200) NOT NULL,
       short_name      VARCHAR(30)  NULL,
       city            VARCHAR(120) NULL,
       state_id        SMALLINT UNSIGNED NULL,
       status          ENUM('verified','pending','merged','inactive') NOT NULL DEFAULT 'verified',
       merged_into_id  INT UNSIGNED NULL,
       source          ENUM('seed','admin','registration') NOT NULL DEFAULT 'admin',
       created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uq_org_name (parent_id, type, name),
       KEY idx_org_children (parent_id, type, status),
       CONSTRAINT fk_org_parent FOREIGN KEY (parent_id)      REFERENCES organizations(id),
       CONSTRAINT fk_org_merged FOREIGN KEY (merged_into_id) REFERENCES organizations(id),
       CONSTRAINT fk_org_state  FOREIGN KEY (state_id)       REFERENCES us_states(id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE organization_states (
       organization_id INT UNSIGNED      NOT NULL,
       state_id        SMALLINT UNSIGNED NOT NULL,
       PRIMARY KEY (organization_id, state_id),
       KEY idx_os_state (state_id),
       CONSTRAINT fk_os_org   FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
       CONSTRAINT fk_os_state FOREIGN KEY (state_id)        REFERENCES us_states(id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE tenants (
       id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       root_organization_id INT UNSIGNED NOT NULL,
       name                 VARCHAR(150) NOT NULL,
       slug                 VARCHAR(63)  NOT NULL UNIQUE,
       status               ENUM('active','suspended','cancelled') NOT NULL DEFAULT 'active',
       default_locale       ENUM('es','en') NOT NULL DEFAULT 'es',
       timezone             VARCHAR(40)  NOT NULL DEFAULT 'America/Los_Angeles',
       logo_url             VARCHAR(500) NULL,
       primary_color        CHAR(7)      NULL,
       secondary_color      CHAR(7)      NULL,
       email_from_name      VARCHAR(120) NULL,
       email_reply_to       VARCHAR(150) NULL,
       created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uq_tenant_root (root_organization_id),
       CONSTRAINT fk_tenant_root FOREIGN KEY (root_organization_id) REFERENCES organizations(id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE tenant_domains (
       id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       tenant_id   INT UNSIGNED NOT NULL,
       hostname    VARCHAR(253) NOT NULL UNIQUE,
       is_primary  TINYINT(1)   NOT NULL DEFAULT 0,
       verified_at DATETIME     NULL,
       created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT fk_td_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE tenant_payment_accounts (
       id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       tenant_id           INT UNSIGNED NOT NULL,
       provider            ENUM('stripe') NOT NULL DEFAULT 'stripe',
       external_account_id VARCHAR(64)  NOT NULL,
       livemode            TINYINT(1)   NOT NULL,
       charges_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
       payouts_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
       details_submitted   TINYINT(1)   NOT NULL DEFAULT 0,
       created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uq_tpa_external (provider, external_account_id),
       UNIQUE KEY uq_tpa_tenant   (tenant_id, provider, livemode),
       CONSTRAINT fk_tpa_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE users (
       id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       name                 VARCHAR(120) NOT NULL,
       email                VARCHAR(150) NOT NULL UNIQUE,
       password_hash        VARCHAR(255) NOT NULL,
       is_platform_admin    TINYINT(1)   NOT NULL DEFAULT 0,
       is_active            TINYINT(1)   NOT NULL DEFAULT 1,
       must_change_password TINYINT(1)   NOT NULL DEFAULT 0,
       failed_login_count   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
       locked_until         DATETIME NULL,
       last_login_at        DATETIME NULL,
       created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE tenant_memberships (
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
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE user_tokens (
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
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE events (
       id                        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       tenant_id                 INT UNSIGNED NOT NULL,
       organizer_organization_id INT UNSIGNED NOT NULL,
       slug                      VARCHAR(80)  NOT NULL,
       name                      JSON NOT NULL,
       description               JSON NULL,
       venue                     VARCHAR(200) NULL,
       starts_at                 DATETIME NOT NULL,
       ends_at                   DATETIME NOT NULL,
       timezone                  VARCHAR(40)  NOT NULL,
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
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE forms (
       id                     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       tenant_id              INT UNSIGNED NOT NULL,
       event_id               INT UNSIGNED NOT NULL,
       title                  JSON NOT NULL,
       status                 ENUM('draft','open','closed') NOT NULL DEFAULT 'draft',
       published_version_id   INT UNSIGNED NULL,
       opens_at               DATETIME NULL,
       closes_at              DATETIME NULL,
       max_registrations      INT UNSIGNED NULL,
       payments_enabled       TINYINT(1) NOT NULL DEFAULT 0,
       allow_online_payment   TINYINT(1) NOT NULL DEFAULT 0,
       allow_offline_payment  TINYINT(1) NOT NULL DEFAULT 1,
       currency               CHAR(3)    NOT NULL DEFAULT 'usd',
       settings               JSON NULL,
       created_by             INT UNSIGNED NULL,
       created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uq_form_tenant (id, tenant_id),
       KEY idx_form_event (event_id),
       CONSTRAINT fk_form_event FOREIGN KEY (event_id, tenant_id) REFERENCES events(id, tenant_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE form_versions (
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
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `ALTER TABLE forms
       ADD CONSTRAINT fk_form_published_version
       FOREIGN KEY (published_version_id) REFERENCES form_versions(id)`,

    `CREATE TABLE form_items (
       id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       tenant_id            INT UNSIGNED NOT NULL,
       form_id              INT UNSIGNED NOT NULL,
       code                 VARCHAR(40) NOT NULL,
       kind                 ENUM('registration_fee','product') NOT NULL,
       name                 JSON NOT NULL,
       description          JSON NULL,
       price_cents          INT UNSIGNED NOT NULL DEFAULT 0,
       is_required          TINYINT(1) NOT NULL DEFAULT 0,
       max_per_registration SMALLINT UNSIGNED NOT NULL DEFAULT 1,
       sort_order           SMALLINT NOT NULL DEFAULT 0,
       is_active            TINYINT(1) NOT NULL DEFAULT 1,
       created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uq_item_code (form_id, code),
       CONSTRAINT fk_item_form FOREIGN KEY (form_id, tenant_id) REFERENCES forms(id, tenant_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE form_item_variants (
       id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       item_id              INT UNSIGNED NOT NULL,
       code                 VARCHAR(20) NOT NULL,
       label                JSON NOT NULL,
       price_cents_override INT UNSIGNED NULL,
       stock                INT UNSIGNED NULL,
       sort_order           SMALLINT NOT NULL DEFAULT 0,
       is_active            TINYINT(1) NOT NULL DEFAULT 1,
       UNIQUE KEY uq_variant_code (item_id, code),
       CONSTRAINT fk_variant_item FOREIGN KEY (item_id) REFERENCES form_items(id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE registrations (
       id                         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       public_code                CHAR(26) NOT NULL UNIQUE,
       tenant_id                  INT UNSIGNED NOT NULL,
       event_id                   INT UNSIGNED NOT NULL,
       form_id                    INT UNSIGNED NOT NULL,
       form_version_id            INT UNSIGNED NOT NULL,
       conference_organization_id INT UNSIGNED NULL,
       church_organization_id     INT UNSIGNED NULL,
       church_name_raw            VARCHAR(200) NULL,
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
       checked_in_at              DATETIME NULL,
       checked_in_by              INT UNSIGNED NULL,
       checked_in_method          ENUM('qr','manual') NULL,
       source                    ENUM('public_form','admin','import') NOT NULL DEFAULT 'public_form',
       created_at                 DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       updated_at                 DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       deleted_at                 DATETIME NULL,
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
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE registration_items (
       id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       registration_id  INT UNSIGNED NOT NULL,
       item_id          INT UNSIGNED NOT NULL,
       variant_id       INT UNSIGNED NULL,
       quantity         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
       unit_price_cents INT UNSIGNED NOT NULL,
       payment_status   ENUM('not_required','unpaid','paid','refunded') NOT NULL DEFAULT 'unpaid',
       delivered_at     DATETIME NULL,
       delivered_by     INT UNSIGNED NULL,
       created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uq_reg_item (registration_id, item_id),
       KEY idx_ri_item (item_id, variant_id, payment_status),
       CONSTRAINT fk_ri_reg     FOREIGN KEY (registration_id) REFERENCES registrations(id),
       CONSTRAINT fk_ri_item    FOREIGN KEY (item_id)         REFERENCES form_items(id),
       CONSTRAINT fk_ri_variant FOREIGN KEY (variant_id)      REFERENCES form_item_variants(id),
       CONSTRAINT fk_ri_deliver FOREIGN KEY (delivered_by)    REFERENCES users(id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE payments (
       id                         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       tenant_id                  INT UNSIGNED NOT NULL,
       event_id                   INT UNSIGNED NOT NULL,
       registration_id            INT UNSIGNED NOT NULL,
       method                     ENUM('stripe','cash','check','zelle','other','legacy') NOT NULL,
       status                     ENUM('pending','succeeded','failed','canceled','refunded','partially_refunded') NOT NULL,
       amount_cents               INT UNSIGNED NOT NULL,
       refunded_cents             INT UNSIGNED NOT NULL DEFAULT 0,
       currency                   CHAR(3) NOT NULL DEFAULT 'usd',
       stripe_account_id          VARCHAR(64)  NULL,
       stripe_checkout_session_id VARCHAR(255) NULL UNIQUE,
       stripe_payment_intent_id   VARCHAR(255) NULL UNIQUE,
       reference                  VARCHAR(120) NULL,
       notes                      VARCHAR(500) NULL,
       recorded_by                INT UNSIGNED NULL,
       paid_at                    DATETIME NULL,
       created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       KEY idx_pay_reg (registration_id),
       KEY idx_pay_event (event_id, status, paid_at),
       CONSTRAINT fk_pay_reg  FOREIGN KEY (registration_id, tenant_id) REFERENCES registrations(id, tenant_id),
       CONSTRAINT fk_pay_user FOREIGN KEY (recorded_by) REFERENCES users(id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE payment_items (
       payment_id           INT UNSIGNED NOT NULL,
       registration_item_id INT UNSIGNED NOT NULL,
       amount_cents         INT UNSIGNED NOT NULL,
       PRIMARY KEY (payment_id, registration_item_id),
       CONSTRAINT fk_pi_payment FOREIGN KEY (payment_id)           REFERENCES payments(id),
       CONSTRAINT fk_pi_item    FOREIGN KEY (registration_item_id) REFERENCES registration_items(id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE refunds (
       id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       payment_id       INT UNSIGNED NOT NULL,
       amount_cents     INT UNSIGNED NOT NULL,
       reason           VARCHAR(255) NULL,
       status           ENUM('pending','succeeded','failed','canceled') NOT NULL,
       stripe_refund_id VARCHAR(255) NULL UNIQUE,
       created_by       INT UNSIGNED NULL,
       created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       CONSTRAINT fk_refund_payment FOREIGN KEY (payment_id) REFERENCES payments(id),
       CONSTRAINT fk_refund_user    FOREIGN KEY (created_by) REFERENCES users(id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE stripe_webhook_events (
       id                VARCHAR(255) PRIMARY KEY,
       type              VARCHAR(100) NOT NULL,
       stripe_account_id VARCHAR(64)  NULL,
       livemode          TINYINT(1)   NOT NULL,
       payload           JSON NOT NULL,
       received_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       processed_at      DATETIME(3) NULL,
       error             TEXT NULL,
       KEY idx_swe_pending (processed_at, received_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE email_messages (
       id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       tenant_id           INT UNSIGNED NOT NULL,
       registration_id     INT UNSIGNED NULL,
       template            VARCHAR(60)  NOT NULL,
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
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE audit_logs (
       id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       tenant_id     INT UNSIGNED NULL,
       event_id      INT UNSIGNED NULL,
       actor_type    ENUM('user','participant','system','stripe') NOT NULL,
       actor_user_id INT UNSIGNED NULL,
       actor_name    VARCHAR(120) NULL,
       action        VARCHAR(60)  NOT NULL,
       entity_type   VARCHAR(40)  NOT NULL,
       entity_id     VARCHAR(40)  NULL,
       changes       JSON NULL,
       metadata      JSON NULL,
       ip            VARBINARY(16) NULL,
       user_agent    VARCHAR(255)  NULL,
       request_id    CHAR(26)      NULL,
       created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       KEY idx_audit_tenant_time (tenant_id, created_at),
       KEY idx_audit_event_time  (event_id, created_at),
       KEY idx_audit_entity      (entity_type, entity_id, created_at),
       KEY idx_audit_actor       (actor_user_id, created_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

/** Orden inverso de creación (respeta las FKs). */
const TABLES = ["us_states","organizations","organization_states","tenants","tenant_domains","tenant_payment_accounts","users","tenant_memberships","user_tokens","events","forms","form_versions","form_items","form_item_variants","registrations","registration_items","payments","payment_items","refunds","stripe_webhook_events","email_messages","audit_logs"];

export async function up(db: Kysely<any>): Promise<void> {
    for (const statement of UP) {
        await sql.raw(statement).execute(db);
    }
}

export async function down(db: Kysely<any>): Promise<void> {
    // forms ↔ form_versions se referencian entre sí
    await sql.raw('ALTER TABLE forms DROP FOREIGN KEY fk_form_published_version').execute(db);
    for (const table of [...TABLES].reverse()) {
        await sql.raw(`DROP TABLE IF EXISTS ${table}`).execute(db);
    }
}
