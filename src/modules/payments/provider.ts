/**
 * Puerta única hacia Stripe. El resto del código habla con esta interfaz;
 * las pruebas instalan un proveedor simulado (sin red).
 *
 * Modelo: Stripe Connect con cuentas Standard. Cada cliente conecta SU
 * cuenta y los cobros son "direct charges" en esa cuenta: el dinero le llega
 * directo al cliente. La plataforma nunca guarda llaves del cliente.
 */
import Stripe from 'stripe';
import { env } from '../../config/env';
import { AppError } from '../../middlewares/errorHandler';

export interface CheckoutLine {
    name: string;
    amountCents: number;
}

export interface CheckoutParams {
    lines: CheckoutLine[];
    currency: string;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
    expiresAt: Date;
    locale: 'es' | 'en';
    metadata: Record<string, string>;
}

export interface PaymentProvider {
    readonly livemode: boolean;
    createConnectedAccount(opts: { email?: string; country?: string }): Promise<{ id: string }>;
    createAccountLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<{ url: string }>;
    retrieveAccount(accountId: string): Promise<{ chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }>;
    createCheckoutSession(accountId: string, params: CheckoutParams): Promise<{ id: string; url: string }>;
    expireCheckoutSession(accountId: string, sessionId: string): Promise<void>;
    createRefund(accountId: string, paymentIntentId: string, amountCents: number, reason?: string): Promise<{ id: string; status: string; amountCents: number }>;
    /** Verifica la firma del webhook y devuelve el evento (o lanza error). */
    constructEvent(rawBody: Buffer, signature: string): Stripe.Event;
}

class StripeProvider implements PaymentProvider {
    private stripe: Stripe;
    readonly livemode: boolean;

    constructor(secretKey: string) {
        this.stripe = new Stripe(secretKey);
        this.livemode = secretKey.startsWith('sk_live_');
    }

    async createConnectedAccount(opts: { email?: string; country?: string }) {
        const account = await this.stripe.accounts.create({ type: 'standard', email: opts.email, country: opts.country ?? 'US' });
        return { id: account.id };
    }

    async createAccountLink(accountId: string, refreshUrl: string, returnUrl: string) {
        const link = await this.stripe.accountLinks.create({
            account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding',
        });
        return { url: link.url };
    }

    async retrieveAccount(accountId: string) {
        const a = await this.stripe.accounts.retrieve(accountId);
        return { chargesEnabled: !!a.charges_enabled, payoutsEnabled: !!a.payouts_enabled, detailsSubmitted: !!a.details_submitted };
    }

    async createCheckoutSession(accountId: string, p: CheckoutParams) {
        const session = await this.stripe.checkout.sessions.create({
            mode: 'payment',
            customer_email: p.customerEmail,
            locale: p.locale,
            line_items: p.lines.map(l => ({
                quantity: 1,
                price_data: { currency: p.currency, unit_amount: l.amountCents, product_data: { name: l.name } },
            })),
            success_url: p.successUrl,
            cancel_url: p.cancelUrl,
            expires_at: Math.floor(p.expiresAt.getTime() / 1000),
            metadata: p.metadata,
            payment_intent_data: { metadata: p.metadata },
        }, { stripeAccount: accountId });
        if (!session.url) throw new Error('Stripe no devolvió la URL de pago');
        return { id: session.id, url: session.url };
    }

    async expireCheckoutSession(accountId: string, sessionId: string) {
        await this.stripe.checkout.sessions.expire(sessionId, {}, { stripeAccount: accountId });
    }

    async createRefund(accountId: string, paymentIntentId: string, amountCents: number, reason?: string) {
        const refund = await this.stripe.refunds.create({
            payment_intent: paymentIntentId, amount: amountCents, metadata: reason ? { reason } : undefined,
        }, { stripeAccount: accountId });
        return { id: refund.id, status: refund.status ?? 'pending', amountCents: refund.amount };
    }

    constructEvent(rawBody: Buffer, signature: string) {
        if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('Falta STRIPE_WEBHOOK_SECRET');
        return this.stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    }
}

let override: PaymentProvider | null = null;
let instance: PaymentProvider | null = null;

/** Solo pruebas: instala un Stripe simulado. */
export function setPaymentProviderForTests(provider: PaymentProvider | null) {
    override = provider;
}

export const stripeConfigured = () => !!override || !!env.STRIPE_SECRET_KEY;

export function getPaymentProvider(): PaymentProvider {
    if (override) return override;
    if (!env.STRIPE_SECRET_KEY) throw new AppError(503, 'Los pagos en línea no están configurados en la plataforma');
    instance ??= new StripeProvider(env.STRIPE_SECRET_KEY);
    return instance;
}
