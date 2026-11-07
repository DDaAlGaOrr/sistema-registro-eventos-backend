import { db } from '../../db/client';
import { seesWholeEvent, TenantScope } from '../../core/access-scope';
import type { EventSummary } from '../events/events.repository';

export interface Page<T> {
    items: T[];
    page: number;
    pageSize: number;
    total: number;
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
}

/**
 * Registros de un evento ya validado como visible (findVisibleEvent).
 * Si el evento es de un nivel superior al alcance del usuario, solo
 * devuelve los registrados de su asociación/iglesia.
 */
export async function listRegistrations(
    scope: TenantScope,
    event: EventSummary,
    { page, pageSize }: { page: number; pageSize: number }
): Promise<Page<RegistrationListItem>> {
    let base = db.selectFrom('registrations as r')
        .where('r.tenant_id', '=', scope.tenantId)
        .where('r.event_id', '=', event.id)
        .where('r.deleted_at', 'is', null);

    if (scope.access.kind === 'organization' && !seesWholeEvent(scope.access, event.organizer.id)) {
        const ids = scope.access.subtreeIds;
        base = base.where(eb => eb.or([
            eb('r.conference_organization_id', 'in', ids),
            eb('r.church_organization_id', 'in', ids),
        ]));
    }

    const [{ total }] = await base.select(eb => eb.fn.countAll<number>().as('total')).execute();
    const rows = await base
        .leftJoin('organizations as conf', 'conf.id', 'r.conference_organization_id')
        .leftJoin('organizations as church', 'church.id', 'r.church_organization_id')
        .select([
            'r.id', 'r.public_code', 'r.first_name', 'r.last_name', 'r.email', 'r.phone',
            'r.conference_organization_id', 'conf.short_name as conference_short_name',
            'r.church_organization_id', 'church.name as church_name', 'r.church_name_raw',
            'r.status', 'r.payment_status', 'r.total_cents', 'r.paid_cents', 'r.checked_in_at', 'r.created_at',
        ])
        .orderBy('r.created_at', 'desc')
        .orderBy('r.id', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute();

    return {
        page,
        pageSize,
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
        })),
    };
}
