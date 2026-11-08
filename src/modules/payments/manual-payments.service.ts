/**
 * Pagos que registra finanzas: efectivo, cheque, Zelle u otro.
 * Reemplaza el "marcar pagado" de V1, pero cada cobro queda como un pago
 * con monto, conceptos, quién lo registró y cuándo.
 */
import { db } from '../../db/client';
import { recordAudit } from '../../core/audit';
import { currentTenantScope } from '../../core/access-scope';
import { getContext } from '../../core/request-context';
import { AppError } from '../../middlewares/errorHandler';
import { findVisibleRegistration } from '../registrations/registrations.repository';
import { recalcRegistration } from './ledger';

export type ManualMethod = 'cash' | 'check' | 'zelle' | 'other';

export interface ManualPaymentInput {
    method: ManualMethod;
    /** Productos del registro que cubre (registration_items.id). Vacío = todo lo pendiente. */
    itemIds?: number[];
    reference?: string | null;
    notes?: string | null;
    paidAt?: Date;
}

async function requireRegistration(registrationId: number) {
    const scope = await currentTenantScope();
    const found = await findVisibleRegistration(scope, registrationId);
    if (!found) throw new AppError(404, 'Registro no encontrado');
    return found;
}

export async function recordManualPayment(registrationId: number, input: ManualPaymentInput) {
    const { row, event } = await requireRegistration(registrationId);
    if (row.status === 'cancelled') throw new AppError(409, 'El registro está cancelado');
    const userId = getContext()!.auth!.userId;

    return db.transaction().execute(async (trx) => {
        // Bloquea el registro: dos cobros simultáneos no pagan dos veces lo mismo
        await trx.selectFrom('registrations').select('id').where('id', '=', row.id).forUpdate().execute();
        const items = await trx.selectFrom('registration_items as ri').innerJoin('form_items as fi', 'fi.id', 'ri.item_id')
            .select(['ri.id', 'ri.unit_price_cents', 'ri.payment_status', 'fi.code'])
            .where('ri.registration_id', '=', row.id).execute();

        const selected = input.itemIds?.length
            ? input.itemIds.map(id => {
                const item = items.find(i => i.id === id);
                if (!item) throw new AppError(400, `El producto ${id} no es de este registro`);
                return item;
            })
            : items.filter(i => i.payment_status === 'unpaid');
        if (!selected.length) throw new AppError(409, 'No hay nada pendiente de pago');
        const notPending = selected.filter(i => i.payment_status !== 'unpaid');
        if (notPending.length) throw new AppError(409, `Ya no está pendiente: ${notPending.map(i => i.code).join(', ')}`);

        const amount = selected.reduce((s, i) => s + i.unit_price_cents, 0);
        const paymentId = Number((await trx.insertInto('payments').values({
            tenant_id: row.tenant_id, event_id: row.event_id, registration_id: row.id,
            method: input.method, status: 'succeeded', amount_cents: amount, currency: 'usd',
            stripe_account_id: null, stripe_checkout_session_id: null, stripe_payment_intent_id: null,
            reference: input.reference ?? null, notes: input.notes ?? null, recorded_by: userId,
            paid_at: input.paidAt ?? new Date(),
        }).executeTakeFirstOrThrow()).insertId);
        await trx.insertInto('payment_items')
            .values(selected.map(i => ({ payment_id: paymentId, registration_item_id: i.id, amount_cents: i.unit_price_cents })))
            .execute();
        await trx.updateTable('registration_items').set({ payment_status: 'paid' })
            .where('id', 'in', selected.map(i => i.id)).execute();
        if (row.status === 'pending_payment') {
            await trx.updateTable('registrations').set({ status: 'confirmed' }).where('id', '=', row.id).execute();
        }
        const totals = await recalcRegistration(trx, row.id);

        await recordAudit(trx, {
            action: 'payment.recorded', entityType: 'registration', entityId: row.id, eventId: event.id,
            changes: { paymentStatus: { from: row.payment_status, to: totals.status }, paidCents: { from: row.paid_cents, to: totals.paid } },
            metadata: { paymentId, method: input.method, amountCents: amount, items: selected.map(i => i.code), reference: input.reference ?? null },
        });
        return { paymentId, amountCents: amount, paymentStatus: totals.status, paidCents: totals.paid };
    });
}

/** Anula un pago manual capturado por error: los productos vuelven a "pendiente". */
export async function voidManualPayment(paymentId: number, reason: string) {
    const tenantId = getContext()!.tenant!.id;
    const payment = await db.selectFrom('payments').selectAll()
        .where('id', '=', paymentId).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!payment) throw new AppError(404, 'Pago no encontrado');
    // Debe ser visible para el usuario (alcance)
    await requireRegistration(payment.registration_id);
    if (payment.method === 'stripe') throw new AppError(409, 'Los pagos con tarjeta se devuelven con un reembolso');
    if (payment.status !== 'succeeded' || payment.refunded_cents > 0) throw new AppError(409, 'Este pago ya no se puede anular');

    return db.transaction().execute(async (trx) => {
        const items = await trx.selectFrom('payment_items').select('registration_item_id').where('payment_id', '=', paymentId).execute();
        await trx.updateTable('payments').set({ status: 'canceled', notes: `${payment.notes ? `${payment.notes} · ` : ''}Anulado: ${reason}` })
            .where('id', '=', paymentId).execute();
        if (items.length) {
            await trx.updateTable('registration_items').set({ payment_status: 'unpaid' })
                .where('id', 'in', items.map(i => i.registration_item_id)).execute();
        }
        const totals = await recalcRegistration(trx, payment.registration_id);
        await recordAudit(trx, {
            action: 'payment.voided', entityType: 'registration', entityId: payment.registration_id, eventId: payment.event_id,
            metadata: { paymentId, method: payment.method, amountCents: payment.amount_cents, reason },
        });
        return { paymentStatus: totals.status, paidCents: totals.paid };
    });
}
