import { db } from '../../db/client';
import type { Locale } from '../../db/types';
import { diff, recordAudit } from '../../core/audit';
import { getContext } from '../../core/request-context';
import { AppError } from '../../middlewares/errorHandler';
import type { Branding } from '../users/user-emails';
import { clearTenantCache } from './tenant.resolver';

export interface TenantSettings {
    id: number;
    slug: string;
    name: string;
    status: string;
    defaultLocale: Locale;
    timezone: string;
    logoUrl: string | null;
    primaryColor: string | null;
    secondaryColor: string | null;
    emailFromName: string | null;
    emailReplyTo: string | null;
    rootOrganization: { id: number; name: string; type: string };
}

export async function getTenantSettings(tenantId: number): Promise<TenantSettings> {
    const t = await db.selectFrom('tenants')
        .innerJoin('organizations as root', 'root.id', 'tenants.root_organization_id')
        .select([
            'tenants.id', 'tenants.slug', 'tenants.name', 'tenants.status', 'tenants.default_locale', 'tenants.timezone',
            'tenants.logo_url', 'tenants.primary_color', 'tenants.secondary_color',
            'tenants.email_from_name', 'tenants.email_reply_to',
            'root.id as root_id', 'root.name as root_name', 'root.type as root_type',
        ])
        .where('tenants.id', '=', tenantId)
        .executeTakeFirst();
    if (!t) throw new AppError(404, 'Cliente no encontrado');
    return {
        id: t.id, slug: t.slug, name: t.name, status: t.status, defaultLocale: t.default_locale, timezone: t.timezone,
        logoUrl: t.logo_url, primaryColor: t.primary_color, secondaryColor: t.secondary_color,
        emailFromName: t.email_from_name, emailReplyTo: t.email_reply_to,
        rootOrganization: { id: t.root_id, name: t.root_name, type: t.root_type },
    };
}

/** Lo que el Front muestra antes del login (pantalla de login, formulario público). */
export async function getPublicBranding(tenantId: number) {
    const s = await getTenantSettings(tenantId);
    return {
        slug: s.slug, name: s.name, defaultLocale: s.defaultLocale,
        logoUrl: s.logoUrl, primaryColor: s.primaryColor, secondaryColor: s.secondaryColor,
    };
}

export async function getBranding(tenantId: number | null): Promise<{ brand: Branding | null; locale: Locale; slug: string | null }> {
    if (!tenantId) return { brand: null, locale: 'es', slug: null };
    const s = await getTenantSettings(tenantId);
    return {
        brand: { name: s.name, logoUrl: s.logoUrl, primaryColor: s.primaryColor, fromName: s.emailFromName, replyTo: s.emailReplyTo },
        locale: s.defaultLocale,
        slug: s.slug,
    };
}

export interface TenantSettingsUpdate {
    name?: string;
    defaultLocale?: Locale;
    timezone?: string;
    logoUrl?: string | null;
    primaryColor?: string | null;
    secondaryColor?: string | null;
    emailFromName?: string | null;
    emailReplyTo?: string | null;
}

const COLUMN: Record<keyof TenantSettingsUpdate, string> = {
    name: 'name', defaultLocale: 'default_locale', timezone: 'timezone', logoUrl: 'logo_url',
    primaryColor: 'primary_color', secondaryColor: 'secondary_color',
    emailFromName: 'email_from_name', emailReplyTo: 'email_reply_to',
};

export async function updateTenantSettings(input: TenantSettingsUpdate): Promise<TenantSettings> {
    const tenant = getContext()?.tenant;
    if (!tenant) throw new AppError(400, 'Falta indicar el cliente');

    const before = await getTenantSettings(tenant.id);
    const changes = diff(before as unknown as Record<string, unknown>, input as Record<string, unknown>);
    if (!changes) return before;

    const values = Object.fromEntries(Object.entries(input).map(([k, v]) => [COLUMN[k as keyof TenantSettingsUpdate], v]));
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('tenants').set(values as any).where('id', '=', tenant.id).execute();
        await recordAudit(trx, { action: 'tenant.settings_updated', entityType: 'tenant', entityId: tenant.id, changes });
    });
    clearTenantCache();
    return getTenantSettings(tenant.id);
}
