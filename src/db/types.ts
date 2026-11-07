import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Tipos de las tablas V2 para Kysely. Deben coincidir con las migraciones
 * de src/db/migrations.
 *
 * Columnas JSON: se escriben como string (toJson) y al leer pueden llegar
 * como string (MariaDB) u objeto (MySQL); usar fromJson() al leer.
 */
export type Json = ColumnType<unknown, string, string>;
export type JsonNullable = ColumnType<unknown | null, string | null | undefined, string | null>;

/** Columna con DEFAULT en la BD: opcional al insertar. */
type Defaulted<T> = ColumnType<T, T | undefined, T>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type UpdatedAt = ColumnType<Date, Date | string | undefined, Date | string>;
type Bool = ColumnType<number, number | boolean | undefined, number | boolean>;

export type Locale = 'es' | 'en';
export type OrganizationType = 'union' | 'conference' | 'church';
export type MembershipRole = 'owner' | 'finance' | 'staff' | 'viewer';

export interface UsStatesTable {
    id: Generated<number>;
    code: string;
    name: string;
}

export interface OrganizationsTable {
    id: Generated<number>;
    parent_id: number | null;
    type: OrganizationType;
    name: string;
    short_name: string | null;
    city: string | null;
    state_id: number | null;
    status: Defaulted<'verified' | 'pending' | 'merged' | 'inactive'>;
    merged_into_id: number | null;
    source: Defaulted<'seed' | 'admin' | 'registration'>;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
}

export interface OrganizationStatesTable {
    organization_id: number;
    state_id: number;
}

export interface TenantsTable {
    id: Generated<number>;
    root_organization_id: number;
    name: string;
    slug: string;
    status: Defaulted<'active' | 'suspended' | 'cancelled'>;
    default_locale: Defaulted<Locale>;
    timezone: Defaulted<string>;
    logo_url: string | null;
    primary_color: string | null;
    secondary_color: string | null;
    email_from_name: string | null;
    email_reply_to: string | null;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
}

export interface TenantDomainsTable {
    id: Generated<number>;
    tenant_id: number;
    hostname: string;
    is_primary: Bool;
    verified_at: Date | null;
    created_at: CreatedAt;
}

export interface TenantPaymentAccountsTable {
    id: Generated<number>;
    tenant_id: number;
    provider: Defaulted<'stripe'>;
    external_account_id: string;
    livemode: Bool;
    charges_enabled: Bool;
    payouts_enabled: Bool;
    details_submitted: Bool;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
}

export interface UsersTable {
    id: Generated<number>;
    name: string;
    email: string;
    password_hash: string;
    is_platform_admin: Bool;
    is_active: Bool;
    must_change_password: Bool;
    failed_login_count: Defaulted<number>;
    locked_until: Date | null;
    last_login_at: Date | null;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
}

export interface TenantMembershipsTable {
    id: Generated<number>;
    tenant_id: number;
    user_id: number;
    role: MembershipRole;
    scope_organization_id: number | null;
    is_active: Bool;
    created_by: number | null;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
}

export interface UserTokensTable {
    id: Generated<number>;
    user_id: number;
    type: 'refresh' | 'invite' | 'password_reset';
    token_hash: string;
    expires_at: Date | string;
    used_at: Date | null;
    revoked_at: Date | null;
    ip: Buffer | null;
    user_agent: string | null;
    created_at: CreatedAt;
}

export interface EventsTable {
    id: Generated<number>;
    tenant_id: number;
    organizer_organization_id: number;
    slug: string;
    name: Json;
    description: JsonNullable;
    venue: string | null;
    starts_at: Date | string;
    ends_at: Date | string;
    timezone: string;
    status: Defaulted<'draft' | 'published' | 'closed' | 'archived'>;
    cover_image_url: string | null;
    created_by: number | null;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
    deleted_at: Date | null;
}

export interface FormsTable {
    id: Generated<number>;
    tenant_id: number;
    event_id: number;
    title: Json;
    status: Defaulted<'draft' | 'open' | 'closed'>;
    published_version_id: number | null;
    opens_at: Date | string | null;
    closes_at: Date | string | null;
    max_registrations: number | null;
    payments_enabled: Bool;
    allow_online_payment: Bool;
    allow_offline_payment: Bool;
    currency: Defaulted<string>;
    settings: JsonNullable;
    created_by: number | null;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
}

export interface FormVersionsTable {
    id: Generated<number>;
    form_id: number;
    version: number;
    schema_json: Json;
    status: Defaulted<'draft' | 'published' | 'superseded'>;
    published_at: Date | string | null;
    published_by: number | null;
    created_at: CreatedAt;
}

export interface FormItemsTable {
    id: Generated<number>;
    tenant_id: number;
    form_id: number;
    code: string;
    kind: 'registration_fee' | 'product';
    name: Json;
    description: JsonNullable;
    price_cents: Defaulted<number>;
    is_required: Bool;
    max_per_registration: Defaulted<number>;
    sort_order: Defaulted<number>;
    is_active: Bool;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
}

export interface FormItemVariantsTable {
    id: Generated<number>;
    item_id: number;
    code: string;
    label: Json;
    price_cents_override: number | null;
    stock: number | null;
    sort_order: Defaulted<number>;
    is_active: Bool;
}

export type RegistrationStatus = 'pending_payment' | 'confirmed' | 'cancelled';
export type RegistrationPaymentStatus = 'not_required' | 'unpaid' | 'partially_paid' | 'paid' | 'refunded';

export interface RegistrationsTable {
    id: Generated<number>;
    public_code: string;
    tenant_id: number;
    event_id: number;
    form_id: number;
    form_version_id: number;
    conference_organization_id: number | null;
    church_organization_id: number | null;
    church_name_raw: string | null;
    first_name: string;
    last_name: string;
    email: string;
    phone: string | null;
    birth_date: Date | string | null;
    gender: 'male' | 'female' | 'undisclosed' | null;
    locale: Defaulted<Locale>;
    answers: Json;
    status: Defaulted<RegistrationStatus>;
    payment_status: Defaulted<RegistrationPaymentStatus>;
    total_cents: Defaulted<number>;
    paid_cents: Defaulted<number>;
    checked_in_at: Date | string | null;
    checked_in_by: number | null;
    checked_in_method: 'qr' | 'manual' | null;
    source: Defaulted<'public_form' | 'admin' | 'import'>;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
    deleted_at: Date | string | null;
    deleted_by: number | null;
}

export interface RegistrationItemsTable {
    id: Generated<number>;
    registration_id: number;
    item_id: number;
    variant_id: number | null;
    quantity: Defaulted<number>;
    unit_price_cents: number;
    payment_status: Defaulted<'not_required' | 'unpaid' | 'paid' | 'refunded'>;
    delivered_at: Date | string | null;
    delivered_by: number | null;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
}

export interface PaymentsTable {
    id: Generated<number>;
    tenant_id: number;
    event_id: number;
    registration_id: number;
    method: 'stripe' | 'cash' | 'check' | 'zelle' | 'other' | 'legacy';
    status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'refunded' | 'partially_refunded';
    amount_cents: number;
    refunded_cents: Defaulted<number>;
    currency: Defaulted<string>;
    stripe_account_id: string | null;
    stripe_checkout_session_id: string | null;
    stripe_payment_intent_id: string | null;
    reference: string | null;
    notes: string | null;
    recorded_by: number | null;
    paid_at: Date | string | null;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
}

export interface PaymentItemsTable {
    payment_id: number;
    registration_item_id: number;
    amount_cents: number;
}

export interface RefundsTable {
    id: Generated<number>;
    payment_id: number;
    amount_cents: number;
    reason: string | null;
    status: 'pending' | 'succeeded' | 'failed' | 'canceled';
    stripe_refund_id: string | null;
    created_by: number | null;
    created_at: CreatedAt;
    updated_at: UpdatedAt;
}

export interface StripeWebhookEventsTable {
    id: string;
    type: string;
    stripe_account_id: string | null;
    livemode: Bool;
    payload: Json;
    received_at: CreatedAt;
    processed_at: Date | string | null;
    error: string | null;
}

export interface EmailMessagesTable {
    id: Generated<number>;
    tenant_id: number;
    registration_id: number | null;
    template: string;
    locale: Locale;
    to_email: string;
    status: Defaulted<'queued' | 'sent' | 'failed'>;
    attempts: Defaulted<number>;
    provider_message_id: string | null;
    last_error: string | null;
    created_at: CreatedAt;
    sent_at: Date | string | null;
}

export type AuditActorType = 'user' | 'participant' | 'system' | 'stripe';

export interface AuditLogsTable {
    id: Generated<number>;
    tenant_id: number | null;
    event_id: number | null;
    actor_type: AuditActorType;
    actor_user_id: number | null;
    actor_name: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    changes: JsonNullable;
    metadata: JsonNullable;
    ip: Buffer | null;
    user_agent: string | null;
    request_id: string | null;
    created_at: CreatedAt;
}

export interface Database {
    us_states: UsStatesTable;
    organizations: OrganizationsTable;
    organization_states: OrganizationStatesTable;
    tenants: TenantsTable;
    tenant_domains: TenantDomainsTable;
    tenant_payment_accounts: TenantPaymentAccountsTable;
    users: UsersTable;
    tenant_memberships: TenantMembershipsTable;
    user_tokens: UserTokensTable;
    events: EventsTable;
    forms: FormsTable;
    form_versions: FormVersionsTable;
    form_items: FormItemsTable;
    form_item_variants: FormItemVariantsTable;
    registrations: RegistrationsTable;
    registration_items: RegistrationItemsTable;
    payments: PaymentsTable;
    payment_items: PaymentItemsTable;
    refunds: RefundsTable;
    stripe_webhook_events: StripeWebhookEventsTable;
    email_messages: EmailMessagesTable;
    audit_logs: AuditLogsTable;
}

export type Organization = Selectable<OrganizationsTable>;
export type NewOrganization = Insertable<OrganizationsTable>;
export type User = Selectable<UsersTable>;
export type Registration = Selectable<RegistrationsTable>;
export type NewRegistration = Insertable<RegistrationsTable>;
export type RegistrationUpdate = Updateable<RegistrationsTable>;
export type NewAuditLog = Insertable<AuditLogsTable>;
