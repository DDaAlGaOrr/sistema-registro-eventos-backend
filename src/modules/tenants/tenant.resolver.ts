import { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env';
import { db } from '../../db/client';
import { getContext, TenantInfo } from '../../core/request-context';
import { AppError } from '../../middlewares/errorHandler';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CACHE_TTL_MS = 60_000;

type CacheEntry = { tenant: TenantInfo | null; expires: number };
const cache = new Map<string, CacheEntry>();

/** Para pruebas y para cuando se edite un cliente. */
export const clearTenantCache = () => cache.clear();

async function cached(key: string, load: () => Promise<TenantInfo | null>): Promise<TenantInfo | null> {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.tenant;
    const tenant = await load();
    cache.set(key, { tenant, expires: Date.now() + CACHE_TTL_MS });
    return tenant;
}

const baseQuery = () => db.selectFrom('tenants')
    .select(['tenants.id', 'tenants.slug', 'tenants.name', 'tenants.root_organization_id'])
    .where('tenants.status', '=', 'active');

const toInfo = (row: { id: number; slug: string; name: string; root_organization_id: number } | undefined): TenantInfo | null =>
    row ? { id: row.id, slug: row.slug, name: row.name, rootOrganizationId: row.root_organization_id } : null;

const bySlug = (slug: string) => cached(`slug:${slug}`, async () =>
    toInfo(await baseQuery().where('tenants.slug', '=', slug).executeTakeFirst()));

const byHostname = (hostname: string) => cached(`host:${hostname}`, async () =>
    toInfo(await baseQuery()
        .innerJoin('tenant_domains', 'tenant_domains.tenant_id', 'tenants.id')
        .where('tenant_domains.hostname', '=', hostname)
        .executeTakeFirst()));

export type HostMatch = { kind: 'tenant'; slug: string } | { kind: 'platform' } | { kind: 'none' };

/** "pacific.tuapp.com" → { tenant: pacific }, "app.tuapp.com" → plataforma. */
export function matchHost(hostname: string): HostMatch {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    for (const base of env.APP_BASE_DOMAINS) {
        if (!host.endsWith(`.${base}`)) continue;
        const sub = host.slice(0, -(base.length + 1));
        if (sub === env.PLATFORM_SUBDOMAIN) return { kind: 'platform' };
        if (SLUG_PATTERN.test(sub)) return { kind: 'tenant', slug: sub };
    }
    return { kind: 'none' };
}

const hostOf = (origin: string | undefined): string | null => {
    if (!origin) return null;
    try { return new URL(origin).hostname; } catch { return null; }
};

/**
 * Cliente de la petición, en este orden:
 *   1. Header X-Tenant (slug) — lo manda el Front, que sabe en qué subdominio está.
 *   2. Origin: dominio propio del cliente o {slug}.<dominio base>.
 *   3. Host de la propia API (si se sirve bajo el subdominio del cliente).
 * Solo identifica el cliente; quién puede ver qué lo decide la membresía.
 */
export async function resolveTenant(req: Request): Promise<TenantInfo | null | 'unknown'> {
    const header = req.header('x-tenant')?.trim().toLowerCase();
    if (header) {
        if (!SLUG_PATTERN.test(header)) return 'unknown';
        return (await bySlug(header)) ?? 'unknown';
    }

    for (const hostname of [hostOf(req.header('origin')), req.hostname]) {
        if (!hostname) continue;
        const custom = await byHostname(hostname.toLowerCase());
        if (custom) return custom;
        const match = matchHost(hostname);
        if (match.kind === 'platform') return null;
        if (match.kind === 'tenant') return (await bySlug(match.slug)) ?? 'unknown';
    }
    return null;
}

/** Deja el cliente (si hay) en el contexto. Un slug que no existe → 404. */
export const tenantMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tenant = await resolveTenant(req);
        if (tenant === 'unknown') throw new AppError(404, 'Cliente no encontrado');
        const ctx = getContext();
        if (ctx && tenant) ctx.tenant = tenant;
        next();
    } catch (err) {
        next(err);
    }
};

/** Para rutas que solo tienen sentido dentro de un cliente. */
export const requireTenant = (req: Request, res: Response, next: NextFunction) => {
    if (!getContext()?.tenant) return next(new AppError(400, 'Falta indicar el cliente (header X-Tenant o subdominio)'));
    next();
};
