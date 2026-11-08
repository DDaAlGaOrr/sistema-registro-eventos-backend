import Stripe from 'stripe';
import type { CheckoutParams, PaymentProvider } from '../src/modules/payments/provider';

export const WEBHOOK_SECRET = 'whsec_prueba_local_123';

/** Stripe simulado: guarda las llamadas; los webhooks se firman y verifican con la librería real. */
export class FakeStripe implements PaymentProvider {
    readonly livemode = false;
    private n = 0;
    private stripe = new Stripe('sk_test_simulado');
    calls: { type: string; args: unknown[] }[] = [];
    accountStatus = new Map<string, { chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }>();
    sessions = new Map<string, { accountId: string; params: CheckoutParams }>();

    private id = (prefix: string) => `${prefix}_${++this.n}${Date.now()}`;

    async createConnectedAccount(opts: { email?: string }) {
        this.calls.push({ type: 'createConnectedAccount', args: [opts] });
        return { id: this.id('acct') };
    }
    async createAccountLink(accountId: string, refreshUrl: string, returnUrl: string) {
        this.calls.push({ type: 'createAccountLink', args: [accountId, refreshUrl, returnUrl] });
        return { url: `https://connect.stripe.test/setup/${accountId}` };
    }
    async retrieveAccount(accountId: string) {
        return this.accountStatus.get(accountId) ?? { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
    }
    async createCheckoutSession(accountId: string, params: CheckoutParams) {
        const id = this.id('cs_test');
        this.sessions.set(id, { accountId, params });
        this.calls.push({ type: 'createCheckoutSession', args: [accountId, params] });
        return { id, url: `https://checkout.stripe.test/pay/${id}` };
    }
    async expireCheckoutSession(accountId: string, sessionId: string) {
        this.calls.push({ type: 'expireCheckoutSession', args: [accountId, sessionId] });
    }
    async createRefund(accountId: string, paymentIntentId: string, amountCents: number, reason?: string) {
        this.calls.push({ type: 'createRefund', args: [accountId, paymentIntentId, amountCents, reason] });
        return { id: this.id('re'), status: 'succeeded', amountCents };
    }
    constructEvent(rawBody: Buffer, signature: string) {
        return this.stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
    }

    /** Arma un evento firmado como lo mandaría Stripe. */
    signedEvent(type: string, object: Record<string, unknown>, account: string, id = this.id('evt')) {
        const payload = JSON.stringify({ id, object: 'event', type, account, livemode: false, created: Math.floor(Date.now() / 1000), data: { object } });
        const signature = this.stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
        return { payload, signature, id };
    }
}
