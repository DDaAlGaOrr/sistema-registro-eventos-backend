import { db } from '../../db/client';
import type { Locale } from '../../db/types';
import { recordAudit } from '../../core/audit';
import { getContext } from '../../core/request-context';
import { AppError } from '../../middlewares/errorHandler';
import { findOrCreateOrganization } from '../../db/seeds/seed';
import { clearTenantCache } from '../tenants/tenant.resolver';
import { inviteUser } from '../users/users.service';

export async function listTenants() {
    const rows = await db.selectFrom('tenants as t')
        .innerJoin('organizations as root', 'root.id', 't.root_organization_id')
        .select([
            't.id', 't.slug', 't.name', 't.status', 't.created_at',
            'root.id as root_id', 'root.name as root_name', 'root.type as root_type',
            eb => eb.selectFrom('tenant_memberships as m').select(eb2 => eb2.fn.countAll<number>().as('n'))
                .whereRef('m.tenant_id', '=', 't.id').where('m.is_active', '=', 1).as('members'),
            eb => eb.selectFrom('events as e').select(eb2 => eb2.fn.countAll<number>().as('n'))
                .whereRef('e.tenant_id', '=', 't.id').where('e.deleted_at', 'is', null).as('events'),
        ])
        .orderBy('t.name').execute();
    return rows.map(r => ({
        id: r.id, slug: r.slug, name: r.name, status: r.status, createdAt: new Date(r.created_at),
        rootOrganization: { id: r.root_id, name: r.root_name, type: r.root_type },
        members: Number(r.members ?? 0), events: Number(r.events ?? 0),
    }));
}

export interface NewTenantInput {
    name: string;
    slug: string;
    rootOrganizationId: number;
    defaultLocale: Locale;
    timezone: string;
    owner: { email: string; name: string };
}

/**
 * Alta de un cliente: crea el tenant y le manda la invitación al owner.
 * Si la invitación falla, el tenant (todavía vacío) se elimina.
 */
export async function createTenant(input: NewTenantInput) {
    const root = await db.selectFrom('organizations').select(['id', 'type', 'status'])
        .where('id', '=', input.rootOrganizationId).executeTakeFirst();
    if (!root || root.status !== 'verified') throw new AppError(404, 'Organización no encontrada');
    if (root.type === 'church') throw new AppError(400, 'El cliente debe ser una unión o una asociación');

    let tenantId: number;
    try {
        tenantId = await db.transaction().execute(async (trx) => {
            const res = await trx.insertInto('tenants').values({
                root_organization_id: input.rootOrganizationId, name: input.name, slug: input.slug,
                default_locale: input.defaultLocale, timezone: input.timezone,
                logo_url: null, primary_color: null, secondary_color: null, email_from_name: null, email_reply_to: null,
            }).executeTakeFirstOrThrow();
            const id = Number(res.insertId);
            await recordAudit(trx, {
                tenantId: id, action: 'tenant.created', entityType: 'tenant', entityId: id,
                metadata: { name: input.name, slug: input.slug, rootOrganizationId: input.rootOrganizationId, owner: input.owner.email },
            });
            return id;
        });
    } catch (err: any) {
        if (err?.code === 'ER_DUP_ENTRY') {
            throw new AppError(409, String(err.message).includes('slug')
                ? 'Ya existe un cliente con ese slug'
                : 'Esa organización ya es cliente');
        }
        throw err;
    }
    clearTenantCache();

    // La invitación usa el cliente del contexto: se apunta al nuevo mientras tanto
    const ctx = getContext()!;
    const previous = ctx.tenant;
    ctx.tenant = { id: tenantId, slug: input.slug, name: input.name, rootOrganizationId: input.rootOrganizationId };
    try {
        await inviteUser({ email: input.owner.email, name: input.owner.name, role: 'owner', scopeOrganizationId: null });
    } catch (err) {
        await db.deleteFrom('tenants').where('id', '=', tenantId).execute().catch(() => undefined);
        throw err;
    } finally {
        ctx.tenant = previous;
    }
    return (await listTenants()).find(t => t.id === tenantId)!;
}

export async function setTenantStatus(tenantId: number, status: 'active' | 'suspended' | 'cancelled') {
    const tenant = await db.selectFrom('tenants').select(['id', 'status']).where('id', '=', tenantId).executeTakeFirst();
    if (!tenant) throw new AppError(404, 'Cliente no encontrado');
    if (tenant.status === status) return;
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('tenants').set({ status }).where('id', '=', tenantId).execute();
        await recordAudit(trx, {
            tenantId, action: 'tenant.status_changed', entityType: 'tenant', entityId: tenantId,
            changes: { status: { from: tenant.status, to: status } },
        });
    });
    clearTenantCache();
}

/** Catálogo global de uniones y asociaciones. */
export async function listCatalog() {
    const rows = await db.selectFrom('organizations as o')
        .leftJoin('organizations as p', 'p.id', 'o.parent_id')
        .leftJoin('tenants as t', 't.root_organization_id', 'o.id')
        .select(['o.id', 'o.type', 'o.name', 'o.short_name', 'o.parent_id', 'p.name as parent_name', 't.slug as tenant_slug'])
        .where('o.type', 'in', ['union', 'conference'])
        .orderBy('o.type', 'desc').orderBy('o.name').execute();
    return rows.map(r => ({
        id: r.id, type: r.type, name: r.name, shortName: r.short_name,
        parent: r.parent_id ? { id: r.parent_id, name: r.parent_name } : null,
        tenantSlug: r.tenant_slug,
    }));
}

export async function createCatalogOrganization(input: {
    type: 'union' | 'conference'; name: string; shortName: string | null; parentId: number | null; stateCodes: string[];
}) {
    if (input.type === 'conference' && !input.parentId) throw new AppError(400, 'Una asociación necesita su unión (parentId)');
    if (input.type === 'union' && input.parentId) throw new AppError(400, 'Una unión no tiene padre');
    if (input.parentId) {
        const parent = await db.selectFrom('organizations').select('type').where('id', '=', input.parentId).executeTakeFirst();
        if (parent?.type !== 'union') throw new AppError(400, 'El padre de una asociación debe ser una unión');
    }
    const states = input.stateCodes.length
        ? await db.selectFrom('us_states').select(['id', 'code']).where('code', 'in', input.stateCodes.map(c => c.toUpperCase())).execute()
        : [];
    if (states.length !== input.stateCodes.length) throw new AppError(400, 'Hay estados desconocidos');

    return db.transaction().execute(async (trx) => {
        const { id, created } = await findOrCreateOrganization(trx, {
            parentId: input.parentId, type: input.type, name: input.name, shortName: input.shortName, source: 'admin',
        });
        if (!created) throw new AppError(409, 'Ya existe una organización con ese nombre');
        if (states.length) {
            await trx.insertInto('organization_states').ignore()
                .values(states.map(s => ({ organization_id: id, state_id: s.id }))).execute();
        }
        await recordAudit(trx, {
            tenantId: null, action: 'organization.created', entityType: 'organization', entityId: id,
            metadata: { type: input.type, name: input.name, parentId: input.parentId },
        });
        return { id, type: input.type, name: input.name };
    });
}
