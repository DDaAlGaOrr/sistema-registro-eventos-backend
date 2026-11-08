import { db } from '../../db/client';
import { recordAudit } from '../../core/audit';
import { currentTenantScope } from '../../core/access-scope';
import { getContext } from '../../core/request-context';
import { AppError } from '../../middlewares/errorHandler';
import { findVisibleRegistration } from '../registrations/registrations.repository';
import { getPaymentProvider } from './provider';
import { recalcRegistration } from './ledger';

/**
 * Reembolso total o parcial. Con tarjeta se hace en Stripe (sale de la
 * cuenta del cliente; Stripe no devuelve su comisión). En efectivo/otro solo
 * se registra que se devolvió el dinero.
 */
export async function refundPayment(paymentId: number, input: { amountCents?: number; reason: string }) {
    const tenantId = getContext()!.tenant!.id;
    const payment = await db.selectFrom('payments').selectAll()
        .where('id', '=', paymentId).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!payment) throw new AppError(404, 'Pago no encontrado');
    const visible = await findVisibleRegistration(await currentTenantScope(), payment.registration_id, { includeDeleted: true });
    if (!visible) throw new AppError(404, 'Pago no encontrado');
    if (!['succeeded', 'partially_refunded'].includes(payment.status)) throw new AppError(409, 'Este pago no se puede reembolsar');

    const refundable = payment.amount_cents - payment.refunded_cents;
    const amount = input.amountCents ?? refundable;
    if (amount <= 0 || amount > refundable) throw new AppError(400, `El monto a reembolsar debe ser entre $0.01 y $${(refundable / 100).toFixed(2)}`);

    let stripeRefund: { id: string; status: string } | null = null;
    if (payment.method === 'stripe') {
        if (!payment.stripe_payment_intent_id || !payment.stripe_account_id) throw new AppError(409, 'El pago con tarjeta no tiene referencia de Stripe');
        stripeRefund = await getPaymentProvider().createRefund(payment.stripe_account_id, payment.stripe_payment_intent_id, amount, input.reason);
        if (stripeRefund.status === 'failed' || stripeRefund.status === 'canceled') throw new AppError(502, 'Stripe rechazó el reembolso');
    }

    return applyRefund({
        paymentId, amountCents: amount, reason: input.reason,
        stripeRefundId: stripeRefund?.id ?? null,
        status: stripeRefund ? (stripeRefund.status === 'succeeded' ? 'succeeded' : 'pending') : 'succeeded',
        createdBy: getContext()!.auth!.userId, actorType: 'user',
    });
}

/** Aplica un reembolso ya hecho (desde el panel o reportado por Stripe). */
export async function applyRefund(r: {
    paymentId: number; amountCents: number; reason: string | null; stripeRefundId: string | null;
    status: 'pending' | 'succeeded'; createdBy: number | null; actorType: 'user' | 'stripe';
}) {
    return db.transaction().execute(async (trx) => {
        const payment = await trx.selectFrom('payments').selectAll().where('id', '=', r.paymentId).forUpdate().executeTakeFirstOrThrow();
        const refunded = Math.min(payment.refunded_cents + r.amountCents, payment.amount_cents);
        const full = refunded >= payment.amount_cents;

        await trx.insertInto('refunds').values({
            payment_id: payment.id, amount_cents: r.amountCents, reason: r.reason, status: r.status,
            stripe_refund_id: r.stripeRefundId, created_by: r.createdBy,
        }).execute();
        await trx.updateTable('payments').set({ refunded_cents: refunded, status: full ? 'refunded' : 'partially_refunded' })
            .where('id', '=', payment.id).execute();
        if (full) {
            const items = await trx.selectFrom('payment_items').select('registration_item_id').where('payment_id', '=', payment.id).execute();
            if (items.length) {
                await trx.updateTable('registration_items').set({ payment_status: 'refunded' })
                    .where('id', 'in', items.map(i => i.registration_item_id)).execute();
            }
        }
        const totals = await recalcRegistration(trx, payment.registration_id);
        await recordAudit(trx, {
            tenantId: payment.tenant_id, eventId: payment.event_id, actorType: r.actorType,
            action: 'payment.refunded', entityType: 'registration', entityId: payment.registration_id,
            metadata: { paymentId: payment.id, method: payment.method, amountCents: r.amountCents, full, reason: r.reason, stripeRefundId: r.stripeRefundId },
        });
        return { paymentId: payment.id, refundedCents: refunded, paymentStatus: totals.status, paidCents: totals.paid };
    });
}
