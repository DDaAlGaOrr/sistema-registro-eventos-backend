import { db } from '../../db/client';
import { fromJson, I18nText } from '../../db/json';
import type { Locale } from '../../db/types';
import { diff, recordAudit } from '../../core/audit';
import { frontUrl } from '../../core/mailer';
import { getContext } from '../../core/request-context';
import { logger } from '../../core/logger';
import { AppError } from '../../middlewares/errorHandler';
import { env } from '../../config/env';
import { getPaymentProvider } from './provider';

// ── Cuenta de Stripe del cliente (Connect) ─────────────────────────────

async function accountRow(tenantId: number, livemode: boolean) {
    return db.selectFrom('tenant_payment_accounts').selectAll()
        .where('tenant_id', '=', tenantId).where('provider', '=', 'stripe').where('livemode', '=', livemode ? 1 : 0)
        .executeTakeFirst();
}

const view = (row: Awaited<ReturnType<typeof accountRow>>) => row
    ? {
        connected: true, accountId: row.external_account_id, livemode: !!row.livemode,
        chargesEnabled: !!row.charges_enabled, payoutsEnabled: !!row.payouts_enabled, detailsSubmitted: !!row.details_submitted,
    }
    : { connected: false, accountId: null, livemode: null, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };

export async function getStripeAccount() {
    const provider = getPaymentProvider();
    return view(await accountRow(getContext()!.tenant!.id, provider.livemode));
}

/** Crea (si no existe) la cuenta conectada y devuelve el enlace de Stripe para completar el alta. */
export async function startStripeOnboarding() {
    const provider = getPaymentProvider();
    const ctx = getContext()!;
    const tenant = ctx.tenant!;
    let row = await accountRow(tenant.id, provider.livemode);
    if (!row) {
        const account = await provider.createConnectedAccount({ email: ctx.auth!.email });
        await db.transaction().execute(async (trx) => {
            await trx.insertInto('tenant_payment_accounts').values({
                tenant_id: tenant.id, provider: 'stripe', external_account_id: account.id, livemode: provider.livemode ? 1 : 0,
                charges_enabled: 0, payouts_enabled: 0, details_submitted: 0,
            }).execute();
            await recordAudit(trx, {
                action: 'tenant.stripe_account_created', entityType: 'tenant', entityId: tenant.id,
                metadata: { accountId: account.id, livemode: provider.livemode },
            });
        });
        row = await accountRow(tenant.id, provider.livemode);
    }
    const settings = (path: string) => frontUrl(tenant.slug, `/admin/configuracion/pagos?stripe=${path}`);
    const link = await provider.createAccountLink(row!.external_account_id, settings('reintentar'), settings('listo'));
    return { url: link.url, account: view(row) };
}

/** Consulta a Stripe el estado de la cuenta (útil si el webhook aún no llega). */
export async function refreshStripeAccount() {
    const provider = getPaymentProvider();
    const tenant = getContext()!.tenant!;
    const row = await accountRow(tenant.id, provider.livemode);
    if (!row) throw new AppError(404, 'El cliente todavía no conecta su cuenta de Stripe');
    const status = await provider.retrieveAccount(row.external_account_id);
    await applyAccountStatus(row.external_account_id, status, tenant.id);
    return view(await accountRow(tenant.id, provider.livemode));
}

/** Guarda el estado de la cuenta (desde la API o desde el webhook account.updated). */
export async function applyAccountStatus(
    accountId: string,
    status: { chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean },
    tenantIdHint?: number
) {
    const row = await db.selectFrom('tenant_payment_accounts').selectAll()
        .where('provider', '=', 'stripe').where('external_account_id', '=', accountId).executeTakeFirst();
    if (!row) return;
    const changes = diff(
        { chargesEnabled: !!row.charges_enabled, payoutsEnabled: !!row.payouts_enabled, detailsSubmitted: !!row.details_submitted },
        status
    );
    if (!changes) return;
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('tenant_payment_accounts').set({
            charges_enabled: status.chargesEnabled ? 1 : 0, payouts_enabled: status.payoutsEnabled ? 1 : 0,
            details_submitted: status.detailsSubmitted ? 1 : 0,
        }).where('id', '=', row.id).execute();
        await recordAudit(trx, {
            tenantId: tenantIdHint ?? row.tenant_id, actorType: getContext()?.auth ? 'user' : 'stripe',
            action: 'tenant.stripe_account_updated', entityType: 'tenant', entityId: row.tenant_id, changes,
        });
    });
}

/** Cuenta lista para cobrar del cliente, o null. */
export async function chargeableAccount(tenantId: number) {
    const provider = getPaymentProvider();
    const row = await accountRow(tenantId, provider.livemode);
    return row && row.charges_enabled ? row.external_account_id : null;
}

// ── Cobro en línea (Checkout) ──────────────────────────────────────────

/**
 * Abre una sesión de pago de Stripe por lo pendiente del registro. Si había
 * otra sesión abierta, la expira primero (evita pagar dos veces).
 */
export async function startCheckout(registrationId: number): Promise<{ url: string; paymentId: number }> {
    const r = await db.selectFrom('registrations as r').innerJoin('forms as f', 'f.id', 'r.form_id').innerJoin('tenants as t', 't.id', 'r.tenant_id')
        .select(['r.id', 'r.tenant_id', 'r.event_id', 'r.public_code', 'r.email', 'r.locale', 'r.status', 'r.deleted_at',
            'f.payments_enabled', 'f.allow_online_payment', 'f.currency', 't.slug'])
        .where('r.id', '=', registrationId).executeTakeFirstOrThrow();
    if (r.deleted_at || r.status === 'cancelled') throw new AppError(409, 'El registro está cancelado');
    if (!r.payments_enabled || !r.allow_online_payment) throw new AppError(409, 'Este registro no acepta pago en línea');
    const accountId = await chargeableAccount(r.tenant_id);
    if (!accountId) throw new AppError(409, 'El pago en línea no está disponible por ahora');

    const items = await db.selectFrom('registration_items as ri').innerJoin('form_items as fi', 'fi.id', 'ri.item_id')
        .leftJoin('form_item_variants as fv', 'fv.id', 'ri.variant_id')
        .select(['ri.id', 'ri.unit_price_cents', 'fi.name', 'fv.label as variant_label'])
        .where('ri.registration_id', '=', r.id).where('ri.payment_status', '=', 'unpaid').execute();
    if (!items.length) throw new AppError(409, 'No hay nada pendiente de pago');

    const provider = getPaymentProvider();
    const locale: Locale = r.locale;

    // Expira sesiones anteriores todavía abiertas
    const open = await db.selectFrom('payments').select(['id', 'stripe_checkout_session_id', 'stripe_account_id'])
        .where('registration_id', '=', r.id).where('method', '=', 'stripe').where('status', '=', 'pending').execute();
    for (const p of open) {
        try {
            await provider.expireCheckoutSession(p.stripe_account_id!, p.stripe_checkout_session_id!);
        } catch (err) {
            logger.warn({ err, paymentId: p.id }, '[stripe] No se pudo expirar la sesión anterior');
        }
        await db.updateTable('payments').set({ status: 'canceled' }).where('id', '=', p.id).where('status', '=', 'pending').execute();
    }

    const confirmation = (result: string) => frontUrl(r.slug, `/registro/confirmacion/${r.public_code}?pago=${result}`);
    const amount = items.reduce((s, i) => s + i.unit_price_cents, 0);
    const session = await provider.createCheckoutSession(accountId, {
        lines: items.map(i => ({
            name: `${fromJson<I18nText>(i.name)[locale]}${i.variant_label ? ` (${fromJson<I18nText>(i.variant_label)[locale]})` : ''}`,
            amountCents: i.unit_price_cents,
        })),
        currency: r.currency,
        customerEmail: r.email,
        successUrl: confirmation('exito'),
        cancelUrl: confirmation('cancelado'),
        expiresAt: new Date(Date.now() + env.STRIPE_CHECKOUT_EXPIRES_MINUTES * 60_000),
        locale,
        metadata: { registrationId: String(r.id), tenantId: String(r.tenant_id), publicCode: r.public_code },
    });

    const paymentId = await db.transaction().execute(async (trx) => {
        const id = Number((await trx.insertInto('payments').values({
            tenant_id: r.tenant_id, event_id: r.event_id, registration_id: r.id, method: 'stripe', status: 'pending',
            amount_cents: amount, currency: r.currency, stripe_account_id: accountId, stripe_checkout_session_id: session.id,
            stripe_payment_intent_id: null, reference: null, notes: null, recorded_by: null, paid_at: null,
        }).executeTakeFirstOrThrow()).insertId);
        await trx.insertInto('payment_items')
            .values(items.map(i => ({ payment_id: id, registration_item_id: i.id, amount_cents: i.unit_price_cents })))
            .execute();
        return id;
    });
    return { url: session.url, paymentId };
}
