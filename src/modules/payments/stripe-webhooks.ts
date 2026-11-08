/**
 * Webhook de Stripe (Connect: "eventos en cuentas conectadas").
 *
 * - Verifica la firma con STRIPE_WEBHOOK_SECRET (sin firma válida: 400).
 * - Idempotente: Stripe reintenta; cada evento se procesa una sola vez
 *   (stripe_webhook_events). Si algo falla responde 500 para que reintente.
 */
import type Stripe from 'stripe';
import { db } from '../../db/client';
import { toJson } from '../../db/json';
import { recordAudit } from '../../core/audit';
import { logger } from '../../core/logger';
import { AppError } from '../../middlewares/errorHandler';
import { getPaymentProvider } from './provider';
import { recalcRegistration } from './ledger';
import { applyAccountStatus } from './stripe.service';
import { applyRefund } from './refunds.service';

export async function handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!signature) throw new AppError(400, 'Falta la firma de Stripe');
    let event: Stripe.Event;
    try {
        event = getPaymentProvider().constructEvent(rawBody, signature);
    } catch {
        throw new AppError(400, 'Firma de Stripe inválida');
    }

    const existing = await db.selectFrom('stripe_webhook_events').select(['id', 'processed_at'])
        .where('id', '=', event.id).executeTakeFirst();
    if (existing?.processed_at) return { received: true, duplicate: true };
    if (!existing) {
        await db.insertInto('stripe_webhook_events').values({
            id: event.id, type: event.type, stripe_account_id: event.account ?? null, livemode: event.livemode ? 1 : 0,
            payload: toJson(event), processed_at: null, error: null,
        }).ignore().execute();
    }

    try {
        await processEvent(event);
        await db.updateTable('stripe_webhook_events').set({ processed_at: new Date(), error: null }).where('id', '=', event.id).execute();
        return { received: true, duplicate: false };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db.updateTable('stripe_webhook_events').set({ error: message.slice(0, 2000) }).where('id', '=', event.id).execute();
        logger.error({ err, eventId: event.id, type: event.type }, '[stripe] Error procesando webhook');
        throw err;
    }
}

async function processEvent(event: Stripe.Event) {
    switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
            return onCheckoutPaid(event.data.object as Stripe.Checkout.Session);
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed':
            return onCheckoutExpired(event.data.object as Stripe.Checkout.Session);
        case 'charge.refunded':
            return onChargeRefunded(event.data.object as Stripe.Charge);
        case 'account.updated': {
            const a = event.data.object as Stripe.Account;
            return applyAccountStatus(a.id, {
                chargesEnabled: !!a.charges_enabled, payoutsEnabled: !!a.payouts_enabled, detailsSubmitted: !!a.details_submitted,
            });
        }
        default:
            return; // Eventos que no usamos: se marcan como procesados
    }
}

const paymentBySession = (sessionId: string) =>
    db.selectFrom('payments').selectAll().where('stripe_checkout_session_id', '=', sessionId).executeTakeFirst();

async function onCheckoutPaid(session: Stripe.Checkout.Session) {
    // Métodos asíncronos (ej. transferencia) llegan "completed" sin pagar todavía
    if (session.payment_status !== 'paid') return;
    const payment = await paymentBySession(session.id);
    if (!payment) {
        logger.warn({ sessionId: session.id }, '[stripe] Sesión pagada que no corresponde a ningún pago');
        return;
    }
    if (payment.status === 'succeeded') return;

    const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
    await db.transaction().execute(async (trx) => {
        const reg = await trx.selectFrom('registrations').select(['id', 'status', 'payment_status', 'paid_cents'])
            .where('id', '=', payment.registration_id).forUpdate().executeTakeFirstOrThrow();
        await trx.updateTable('payments').set({
            status: 'succeeded', stripe_payment_intent_id: paymentIntent, paid_at: new Date(),
            amount_cents: session.amount_total ?? payment.amount_cents,
        }).where('id', '=', payment.id).execute();

        const items = await trx.selectFrom('payment_items').select('registration_item_id').where('payment_id', '=', payment.id).execute();
        if (items.length) {
            await trx.updateTable('registration_items').set({ payment_status: 'paid' })
                .where('id', 'in', items.map(i => i.registration_item_id)).where('payment_status', '=', 'unpaid').execute();
        }
        // Si se pagó después de que venciera (pagos asíncronos), se reactiva
        if (reg.status !== 'confirmed') {
            await trx.updateTable('registrations').set({ status: 'confirmed' }).where('id', '=', reg.id).execute();
        }
        const totals = await recalcRegistration(trx, reg.id);
        await recordAudit(trx, {
            tenantId: payment.tenant_id, eventId: payment.event_id, actorType: 'stripe', actorName: 'Stripe',
            action: 'payment.succeeded', entityType: 'registration', entityId: reg.id,
            changes: {
                status: { from: reg.status, to: 'confirmed' },
                paymentStatus: { from: reg.payment_status, to: totals.status },
            },
            metadata: { paymentId: payment.id, amountCents: session.amount_total, sessionId: session.id, paymentIntent },
        });

        // La confirmación se manda cuando el pago entra (una sola vez)
        const queued = await trx.selectFrom('email_messages').select('id')
            .where('registration_id', '=', reg.id).where('template', '=', 'registration_confirmation').executeTakeFirst();
        if (!queued) {
            const r = await trx.selectFrom('registrations').select(['email', 'locale']).where('id', '=', reg.id).executeTakeFirstOrThrow();
            await trx.insertInto('email_messages').values({
                tenant_id: payment.tenant_id, registration_id: reg.id, template: 'registration_confirmation',
                locale: r.locale, to_email: r.email, status: 'queued', attempts: 0,
                provider_message_id: null, last_error: null, sent_at: null,
            }).execute();
        }
    });
}

async function onCheckoutExpired(session: Stripe.Checkout.Session) {
    const payment = await paymentBySession(session.id);
    if (!payment || payment.status !== 'pending') return;
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('payments').set({ status: 'canceled' }).where('id', '=', payment.id).execute();
        const reg = await trx.selectFrom('registrations').select(['id', 'status'])
            .where('id', '=', payment.registration_id).forUpdate().executeTakeFirstOrThrow();
        const other = await trx.selectFrom('payments').select('id').where('registration_id', '=', reg.id)
            .where('status', 'in', ['pending', 'succeeded']).executeTakeFirst();
        // Nunca pagó: se cancela y libera el lugar del cupo
        if (reg.status === 'pending_payment' && !other) {
            await trx.updateTable('registrations').set({ status: 'cancelled' }).where('id', '=', reg.id).execute();
            await recordAudit(trx, {
                tenantId: payment.tenant_id, eventId: payment.event_id, actorType: 'stripe', actorName: 'Stripe',
                action: 'registration.cancelled_unpaid', entityType: 'registration', entityId: reg.id,
                changes: { status: { from: 'pending_payment', to: 'cancelled' } },
                metadata: { paymentId: payment.id, sessionId: session.id },
            });
        }
    });
}

/** Reembolsos hechos desde el dashboard de Stripe (los del panel ya están registrados). */
async function onChargeRefunded(charge: Stripe.Charge) {
    const paymentIntent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (!paymentIntent) return;
    const payment = await db.selectFrom('payments').selectAll().where('stripe_payment_intent_id', '=', paymentIntent).executeTakeFirst();
    if (!payment) return;
    const delta = charge.amount_refunded - payment.refunded_cents;
    if (delta <= 0) return;
    await applyRefund({
        paymentId: payment.id, amountCents: delta, reason: 'Reembolso hecho desde Stripe', stripeRefundId: null,
        status: 'succeeded', createdBy: null, actorType: 'stripe',
    });
}
