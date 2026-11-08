import { db } from '../../db/client';
import { currentTenantScope } from '../../core/access-scope';
import { AppError } from '../../middlewares/errorHandler';
import { findVisibleEvent } from '../events/events.repository';
import { Page, registrationConditions } from '../registrations/registrations.repository';

export interface PaymentFilters {
    method?: 'stripe' | 'cash' | 'check' | 'zelle' | 'other' | 'legacy';
    status?: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'refunded' | 'partially_refunded';
}

/** Movimientos de dinero de un evento (vista "Pagos"), con el mismo alcance que la lista de registros. */
export async function listEventPayments(eventId: number, filters: PaymentFilters, page: number, pageSize: number) {
    const scope = await currentTenantScope();
    const event = await findVisibleEvent(scope, eventId);
    if (!event) throw new AppError(404, 'Evento no encontrado');

    let base = db.selectFrom('payments as p')
        .innerJoin('registrations as r', 'r.id', 'p.registration_id')
        .where(eb => registrationConditions(eb as any, scope, event, {}))
        .where('p.event_id', '=', event.id);
    if (filters.method) base = base.where('p.method', '=', filters.method);
    if (filters.status) base = base.where('p.status', '=', filters.status);

    const [{ total }] = await base.select(eb => eb.fn.countAll<number>().as('total')).execute();
    const [sums] = await base.select([
        eb => eb.fn.sum<number>('p.amount_cents').as('amount'),
        eb => eb.fn.sum<number>('p.refunded_cents').as('refunded'),
    ]).where('p.status', 'in', ['succeeded', 'partially_refunded', 'refunded']).execute();

    const rows = await base.leftJoin('users as u', 'u.id', 'p.recorded_by')
        .select([
            'p.id', 'p.method', 'p.status', 'p.amount_cents', 'p.refunded_cents', 'p.reference', 'p.notes', 'p.paid_at', 'p.created_at',
            'r.id as registration_id', 'r.first_name', 'r.last_name', 'r.public_code', 'u.name as recorded_by',
        ])
        .orderBy('p.id', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute();

    const result: Page<unknown> & { totals: { collectedCents: number; refundedCents: number; netCents: number } } = {
        page, pageSize, total: Number(total),
        totals: {
            collectedCents: Number(sums?.amount ?? 0),
            refundedCents: Number(sums?.refunded ?? 0),
            netCents: Number(sums?.amount ?? 0) - Number(sums?.refunded ?? 0),
        },
        items: rows.map(p => ({
            id: p.id, method: p.method, status: p.status, amountCents: p.amount_cents, refundedCents: p.refunded_cents,
            reference: p.reference, notes: p.notes, paidAt: p.paid_at ? new Date(p.paid_at) : null, createdAt: new Date(p.created_at),
            recordedBy: p.recorded_by,
            registration: { id: p.registration_id, firstName: p.first_name, lastName: p.last_name, publicCode: p.public_code },
        })),
    };
    return result;
}
