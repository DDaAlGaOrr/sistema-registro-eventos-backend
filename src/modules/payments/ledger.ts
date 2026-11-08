/**
 * Reglas de dinero de un registro, compartidas por pagos manuales, Stripe y
 * reembolsos. Siempre se llaman dentro de la transacción del movimiento.
 */
import type { Kysely } from 'kysely';
import type { Database, RegistrationPaymentStatus } from '../../db/types';

/**
 * Recalcula total, pagado neto y estado de pago a partir de los productos
 * y los pagos guardados (nunca se "suma a mano": así no se descuadra).
 */
export async function recalcRegistration(trx: Kysely<Database>, registrationId: number) {
    const items = await trx.selectFrom('registration_items').select(['unit_price_cents', 'payment_status'])
        .where('registration_id', '=', registrationId).execute();
    const payments = await trx.selectFrom('payments').select(['amount_cents', 'refunded_cents'])
        .where('registration_id', '=', registrationId)
        .where('status', 'in', ['succeeded', 'partially_refunded', 'refunded']).execute();

    const total = items.reduce((s, i) => s + i.unit_price_cents, 0);
    const paid = payments.reduce((s, p) => s + p.amount_cents - p.refunded_cents, 0);
    const chargeable = items.filter(i => i.payment_status !== 'not_required');

    let status: RegistrationPaymentStatus;
    if (chargeable.length === 0) status = 'not_required';
    else if (chargeable.every(i => i.payment_status === 'paid')) status = 'paid';
    else if (chargeable.every(i => i.payment_status === 'refunded')) status = 'refunded';
    else if (chargeable.some(i => i.payment_status === 'paid')) status = 'partially_paid';
    else status = 'unpaid';

    await trx.updateTable('registrations')
        .set({ total_cents: total, paid_cents: Math.max(paid, 0), payment_status: status })
        .where('id', '=', registrationId).execute();
    return { total, paid, status };
}
