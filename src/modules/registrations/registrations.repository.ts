import { ExpressionBuilder, sql } from 'kysely';
import { db } from '../../db/client';
import type { Database, RegistrationsTable } from '../../db/types';
import { seesWholeEvent, TenantScope } from '../../core/access-scope';
import { findVisibleEvent, EventSummary } from '../events/events.repository';

export interface Page<T> {
    items: T[];
    page: number;
    pageSize: number;
    total: number;
}

export interface RegistrationFilters {
    q?: string;
    conferenceId?: number;
    churchId?: number;
    status?: 'confirmed' | 'pending_payment' | 'cancelled';
    paymentStatus?: 'not_required' | 'unpaid' | 'partially_paid' | 'paid' | 'refunded';
    checkedIn?: boolean;
    itemCode?: string;
    variantCode?: string;
    createdFrom?: Date;
    createdTo?: Date;
    /** exclude (por defecto) | only = papelera */
    deleted?: 'exclude' | 'only';
}

export interface RegistrationItemSummary {
    id: number;
    code: string;
    variantCode: string | null;
    unitPriceCents: number;
    paymentStatus: string;
    deliveredAt: Date | null;
}

export interface RegistrationListItem {
    id: number;
    publicCode: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    conference: { id: number; shortName: string | null } | null;
    church: { id: number; name: string } | null;
    churchNameRaw: string | null;
    status: string;
    paymentStatus: string;
    totalCents: number;
    paidCents: number;
    checkedInAt: Date | null;
    createdAt: Date;
    deletedAt: Date | null;
    items: RegistrationItemSummary[];
}

type RegDB = Database & { r: RegistrationsTable };
type RegEB = ExpressionBuilder<RegDB, 'r'>;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, m => `\\${m}`);

/**
 * Todas las condiciones de "qué registros ve este usuario en este evento"
 * en un solo lugar: lista, exportación, reportes y actividad las comparten.
 */
export function registrationConditions(eb: RegEB, scope: TenantScope, event: EventSummary, f: RegistrationFilters = {}) {
    const and = [
        eb('r.tenant_id', '=', scope.tenantId),
        eb('r.event_id', '=', event.id),
        f.deleted === 'only' ? eb('r.deleted_at', 'is not', null) : eb('r.deleted_at', 'is', null),
    ];

    // Evento de un nivel superior: solo los de su asociación/iglesia
    if (scope.access.kind === 'organization' && !seesWholeEvent(scope.access, event.organizer.id)) {
        const ids = scope.access.subtreeIds;
        and.push(eb.or([eb('r.conference_organization_id', 'in', ids), eb('r.church_organization_id', 'in', ids)]));
    }

    if (f.q) {
        const q = f.q.trim();
        const like = `%${escapeLike(q)}%`;
        and.push(eb.or([
            eb('r.first_name', 'like', like),
            eb('r.last_name', 'like', like),
            eb('r.email', 'like', like),
            eb('r.phone', 'like', like),
            eb('r.public_code', '=', q.toUpperCase()),
            eb(sql<string>`CONCAT(r.first_name, ' ', r.last_name)`, 'like', like),
        ]));
    }
    if (f.conferenceId) and.push(eb('r.conference_organization_id', '=', f.conferenceId));
    if (f.churchId) and.push(eb('r.church_organization_id', '=', f.churchId));
    if (f.status) and.push(eb('r.status', '=', f.status));
    if (f.paymentStatus) and.push(eb('r.payment_status', '=', f.paymentStatus));
    if (f.checkedIn !== undefined) and.push(f.checkedIn ? eb('r.checked_in_at', 'is not', null) : eb('r.checked_in_at', 'is', null));
    if (f.createdFrom) and.push(eb('r.created_at', '>=', f.createdFrom));
    if (f.createdTo) and.push(eb('r.created_at', '<', f.createdTo));
    if (f.itemCode) {
        let sub = eb.selectFrom('registration_items as ri')
            .innerJoin('form_items as fi', 'fi.id', 'ri.item_id')
            .leftJoin('form_item_variants as fv', 'fv.id', 'ri.variant_id')
            .select('ri.id')
            .whereRef('ri.registration_id', '=', 'r.id')
            .where('fi.code', '=', f.itemCode);
        if (f.variantCode) sub = sub.where('fv.code', '=', f.variantCode);
        and.push(eb.exists(sub));
    }
    return eb.and(and);
}

export async function itemsOf(registrationIds: number[]): Promise<Map<number, RegistrationItemSummary[]>> {
    const map = new Map<number, RegistrationItemSummary[]>();
    if (!registrationIds.length) return map;
    const rows = await db.selectFrom('registration_items as ri')
        .innerJoin('form_items as fi', 'fi.id', 'ri.item_id')
        .leftJoin('form_item_variants as fv', 'fv.id', 'ri.variant_id')
        .select(['ri.id', 'ri.registration_id', 'fi.code', 'fv.code as variant_code', 'ri.unit_price_cents', 'ri.payment_status', 'ri.delivered_at'])
        .where('ri.registration_id', 'in', registrationIds)
        .orderBy('fi.sort_order').orderBy('ri.id').execute();
    for (const r of rows) {
        const list = map.get(r.registration_id) ?? [];
        list.push({
            id: r.id, code: r.code, variantCode: r.variant_code, unitPriceCents: r.unit_price_cents,
            paymentStatus: r.payment_status, deliveredAt: r.delivered_at ? new Date(r.delivered_at) : null,
        });
        map.set(r.registration_id, list);
    }
    return map;
}

export type RegistrationSort = 'created_at' | 'last_name' | 'checked_in_at';

/** Registros de un evento ya validado como visible (findVisibleEvent). */
export async function listRegistrations(
    scope: TenantScope,
    event: EventSummary,
    opts: { page: number; pageSize: number; filters?: RegistrationFilters; sort?: RegistrationSort; order?: 'asc' | 'desc' }
): Promise<Page<RegistrationListItem>> {
    const filters = opts.filters ?? {};
    const base = db.selectFrom('registrations as r').where(eb => registrationConditions(eb, scope, event, filters));

    const [{ total }] = await base.select(eb => eb.fn.countAll<number>().as('total')).execute();
    const sort = opts.sort ?? 'created_at';
    const order = opts.order ?? (sort === 'last_name' ? 'asc' : 'desc');
    let query = base
        .leftJoin('organizations as conf', 'conf.id', 'r.conference_organization_id')
        .leftJoin('organizations as church', 'church.id', 'r.church_organization_id')
        .select([
            'r.id', 'r.public_code', 'r.first_name', 'r.last_name', 'r.email', 'r.phone',
            'r.conference_organization_id', 'conf.short_name as conference_short_name',
            'r.church_organization_id', 'church.name as church_name', 'r.church_name_raw',
            'r.status', 'r.payment_status', 'r.total_cents', 'r.paid_cents', 'r.checked_in_at', 'r.created_at', 'r.deleted_at',
        ]);
    query = sort === 'last_name'
        ? query.orderBy('r.last_name', order).orderBy('r.first_name', order)
        : query.orderBy(`r.${sort}`, order);
    const rows = await query.orderBy('r.id', order).limit(opts.pageSize).offset((opts.page - 1) * opts.pageSize).execute();
    const items = await itemsOf(rows.map(r => r.id));

    return {
        page: opts.page,
        pageSize: opts.pageSize,
        total: Number(total),
        items: rows.map(r => ({
            id: r.id,
            publicCode: r.public_code,
            firstName: r.first_name,
            lastName: r.last_name,
            email: r.email,
            phone: r.phone,
            conference: r.conference_organization_id
                ? { id: r.conference_organization_id, shortName: r.conference_short_name } : null,
            church: r.church_organization_id && r.church_name
                ? { id: r.church_organization_id, name: r.church_name } : null,
            churchNameRaw: r.church_name_raw,
            status: r.status,
            paymentStatus: r.payment_status,
            totalCents: r.total_cents,
            paidCents: r.paid_cents,
            checkedInAt: r.checked_in_at ? new Date(r.checked_in_at) : null,
            createdAt: new Date(r.created_at),
            deletedAt: r.deleted_at ? new Date(r.deleted_at) : null,
            items: items.get(r.id) ?? [],
        })),
    };
}

/**
 * Un registro que el usuario puede ver (o null): de su cliente, de un
 * evento visible y, si el evento es de un nivel superior, de su asociación.
 */
export async function findVisibleRegistration(scope: TenantScope, registrationId: number, opts: { includeDeleted?: boolean } = {}) {
    const row = await db.selectFrom('registrations').selectAll()
        .where('id', '=', registrationId).where('tenant_id', '=', scope.tenantId).executeTakeFirst();
    if (!row || (row.deleted_at && !opts.includeDeleted)) return null;
    const event = await findVisibleEvent(scope, row.event_id);
    if (!event) return null;
    if (scope.access.kind === 'organization' && !seesWholeEvent(scope.access, event.organizer.id)) {
        const ids = scope.access.subtreeIds;
        const inScope = (row.conference_organization_id !== null && ids.includes(row.conference_organization_id))
            || (row.church_organization_id !== null && ids.includes(row.church_organization_id));
        if (!inScope) return null;
    }
    return { row, event };
}

/** Mismo criterio que findVisibleRegistration, buscando por el código del QR dentro de un evento. */
export async function findVisibleByPublicCode(scope: TenantScope, eventId: number, publicCode: string) {
    const row = await db.selectFrom('registrations').select('id')
        .where('public_code', '=', publicCode.toUpperCase()).where('tenant_id', '=', scope.tenantId)
        .where('event_id', '=', eventId).where('deleted_at', 'is', null)
        .executeTakeFirst();
    return row ? findVisibleRegistration(scope, row.id) : null;
}
