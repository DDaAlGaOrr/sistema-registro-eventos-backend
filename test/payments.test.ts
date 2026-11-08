import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { db, destroyDb } from '../src/db/client';
import { fromJson } from '../src/db/json';
import { FEJA_FORM_SCHEMA, TSHIRT_VARIANTS } from '../src/db/import-v1/feja-form';
import { setPaymentProviderForTests } from '../src/modules/payments/provider';
import { addMembership, buildScenario, createUser } from './fixtures';
import { as, loginAs } from './http';
import { uniq } from './helpers';
import { FakeStripe } from './fake-stripe';

const app = createApp();
let s: Awaited<ReturnType<typeof buildScenario>>;
type Client = ReturnType<typeof as>;
let owner: Client, finance: Client, staff: Client;
let formId: number, eventId: number, azChurch: number;
let stripe: FakeStripe;
let accountId: string;

const t = (es: string, en = es) => ({ es, en });

beforeAll(async () => {
    s = await buildScenario();
    const tenant = s.tenantA.slug;
    owner = as(app, (await loginAs(app, s.users.owner.email, tenant)).token, tenant);
    finance = as(app, (await loginAs(app, s.users.finance.email, tenant)).token, tenant);
    const u = await createUser();
    await addMembership(s.tenantA.id, u.id, 'staff');
    staff = as(app, (await loginAs(app, u.email, tenant)).token, tenant);

    const az = await db.selectFrom('us_states').select('id').where('code', '=', 'AZ').executeTakeFirstOrThrow();
    await db.insertInto('organization_states').ignore().values({ organization_id: s.orgs.az, state_id: az.id }).execute();
    azChurch = (await owner.post('/organizations/churches', { conferenceId: s.orgs.az, name: `Shalom ${uniq()}` })).body.data.id;

    const ev = await owner.post('/events', {
        slug: `pagos-${uniq()}`, name: t('Congreso', 'Congress'),
        startsAt: '2027-10-15T17:00:00-07:00', endsAt: '2027-10-17T18:00:00-07:00', timezone: 'America/Phoenix',
    });
    eventId = ev.body.data.id;
    formId = (await owner.post(`/events/${eventId}/forms`, { title: t('Registro') })).body.data.id;
    await owner.post(`/forms/${formId}/items`, {
        code: 'tshirt', kind: 'product', name: t('Playera', 'T-shirt'), priceCents: 400,
        variants: TSHIRT_VARIANTS.map(v => ({ code: v.code, label: v.label })),
    });
    await owner.post(`/forms/${formId}/items`, { code: 'lunch', kind: 'product', name: t('Comida', 'Lunch'), priceCents: 200 });
    await owner.put(`/forms/${formId}/draft`, { schema: FEJA_FORM_SCHEMA });
    await owner.post(`/forms/${formId}/publish`);
    await owner.patch(`/forms/${formId}`, { paymentsEnabled: true, maxRegistrations: 50 });
    await owner.post(`/events/${eventId}/status`, { status: 'published' });
    await owner.post(`/forms/${formId}/status`, { status: 'open' });
});
afterAll(async () => {
    setPaymentProviderForTests(null);
    await destroyDb();
});

const person = (o: Record<string, unknown> = {}) => ({
    first_name: 'Ana', last_name: `Pago ${uniq()}`, email: `pago-${uniq()}@example.test`, phone: '6025550101',
    birth_date: '2008-04-02', gender: 'female', location: { state: 'AZ', conference_id: s.orgs.az }, city: 'Phoenix',
    church: { church_id: azChurch }, is_chaperone: false, wants_tshirt: true, tshirt_size: 'M', wants_lunch: true, diet: 'vegan',
    emergency_name: 'Mamá', emergency_phone: '6025550000', emergency_relationship: 'padres', ...o,
});

async function register(paymentMethod: 'online' | 'offline' = 'offline', answers = person()) {
    const res = await request(app).post(`/api/v2/public/forms/${formId}/registrations`).set('X-Tenant', s.tenantA.slug)
        .send({ answers, locale: 'es', paymentMethod });
    const reg = res.body.data?.publicCode
        ? await db.selectFrom('registrations').selectAll().where('public_code', '=', res.body.data.publicCode).executeTakeFirstOrThrow()
        : null;
    return { res, reg: reg!, email: answers.email as string };
}

const detail = async (id: number) => (await owner.get(`/registrations/${id}`)).body.data;
const itemId = async (registrationId: number, code: string) => (await detail(registrationId)).items.find((i: any) => i.code === code).id;

const webhook = (event: { payload: string; signature: string }) =>
    request(app).post('/api/v2/webhooks/stripe').set('Content-Type', 'application/json')
        .set('Stripe-Signature', event.signature).send(event.payload);

describe('pagos manuales (finanzas)', () => {
    it('cobrar solo la playera, luego el resto; staff no puede cobrar', async () => {
        const { reg } = await register();
        const tshirt = await itemId(reg.id, 'tshirt');
        expect((await staff.post(`/registrations/${reg.id}/payments`, { method: 'cash' })).status).toBe(403);

        const first = await finance.post(`/registrations/${reg.id}/payments`, { method: 'cash', itemIds: [tshirt], reference: 'Recibo 001' });
        expect(first.status).toBe(201);
        expect(first.body.data).toMatchObject({ amountCents: 400, paymentStatus: 'partially_paid', paidCents: 400 });
        expect((await finance.post(`/registrations/${reg.id}/payments`, { method: 'cash', itemIds: [tshirt] })).status).toBe(409);

        const rest = await finance.post(`/registrations/${reg.id}/payments`, { method: 'zelle' });
        expect(rest.body.data).toMatchObject({ amountCents: 200, paymentStatus: 'paid', paidCents: 600 });

        const d = await detail(reg.id);
        expect(d.payments.map((p: any) => [p.method, p.amountCents, p.recordedBy !== null])).toEqual([['cash', 400, true], ['zelle', 200, true]]);
        const log = await db.selectFrom('audit_logs').select('metadata').where('action', '=', 'payment.recorded')
            .where('entity_id', '=', String(reg.id)).orderBy('id').executeTakeFirstOrThrow();
        expect(fromJson<any>(log.metadata)).toMatchObject({ method: 'cash', amountCents: 400, items: ['tshirt'], reference: 'Recibo 001' });
    });

    it('anular un pago capturado por error devuelve los productos a pendiente', async () => {
        const { reg } = await register();
        const pay = await finance.post(`/registrations/${reg.id}/payments`, { method: 'cash' });
        expect((await staff.post(`/payments/${pay.body.data.paymentId}/void`, { reason: 'Error' })).status).toBe(403);
        const res = await finance.post(`/payments/${pay.body.data.paymentId}/void`, { reason: 'Se registró en la persona equivocada' });
        expect(res.body.data).toEqual({ paymentStatus: 'unpaid', paidCents: 0 });
        expect((await finance.post(`/payments/${pay.body.data.paymentId}/void`, { reason: 'otra vez' })).status).toBe(409);
    });

    it('un cliente no cobra registros de otro cliente', async () => {
        const { reg } = await register();
        const ownerB = as(app, (await loginAs(app, s.users.ownerB.email, s.tenantB.slug)).token, s.tenantB.slug);
        expect((await ownerB.post(`/registrations/${reg.id}/payments`, { method: 'cash' })).status).toBe(404);
    });
});

describe('cuenta de Stripe del cliente', () => {
    it('sin Stripe configurado en la plataforma responde 503', async () => {
        setPaymentProviderForTests(null);
        expect((await owner.get('/payments/stripe/account')).status).toBe(503);
    });

    it('conectar: crea la cuenta y devuelve el enlace de alta de Stripe', async () => {
        stripe = new FakeStripe();
        setPaymentProviderForTests(stripe);
        expect((await finance.post('/payments/stripe/connect')).status).toBe(403);
        const res = await owner.post('/payments/stripe/connect');
        expect(res.status).toBe(200);
        expect(res.body.data.url).toMatch(/^https:\/\/connect\.stripe\.test\//);
        accountId = res.body.data.account.accountId;
        expect(res.body.data.account).toMatchObject({ connected: true, chargesEnabled: false });
        const link = stripe.calls.find(c => c.type === 'createAccountLink')!;
        expect(link.args[2]).toBe(`http://${s.tenantA.slug}.localhost:4200/admin/configuracion/pagos?stripe=listo`);
    });

    it('no se puede activar el cobro en línea hasta que Stripe habilite la cuenta', async () => {
        expect((await owner.patch(`/forms/${formId}`, { allowOnlinePayment: true })).status).toBe(409);
    });

    it('el webhook account.updated habilita la cuenta', async () => {
        const res = await webhook(stripe.signedEvent('account.updated', {
            id: accountId, object: 'account', charges_enabled: true, payouts_enabled: true, details_submitted: true,
        }, accountId));
        expect(res.status).toBe(200);
        expect((await owner.get('/payments/stripe/account')).body.data).toMatchObject({ chargesEnabled: true, payoutsEnabled: true });
        expect((await owner.patch(`/forms/${formId}`, { allowOnlinePayment: true })).body.data.payments.online).toBe(true);
    });

    it('también se puede consultar el estado directo a Stripe', async () => {
        stripe.accountStatus.set(accountId, { chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true });
        const res = await owner.post('/payments/stripe/refresh');
        expect(res.body.data).toMatchObject({ chargesEnabled: true, payoutsEnabled: false });
    });
});

describe('cobro en línea', () => {
    const paidSession = (sessionId: string, amount: number, pi = `pi_${uniq()}`) => ({
        id: sessionId, object: 'checkout.session', payment_status: 'paid', amount_total: amount, payment_intent: pi,
    });

    it('registrarse con tarjeta: queda pendiente, aparta su lugar y recibe la URL de pago', async () => {
        const { res, reg } = await register('online');
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ status: 'pending_payment', paymentMethod: 'online', totalCents: 600 });
        expect(res.body.data.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);

        const session = [...stripe.sessions.values()].at(-1)!;
        expect(session.accountId).toBe(accountId);
        expect(session.params.lines).toEqual([{ name: 'Playera (Mediana (M))', amountCents: 400 }, { name: 'Comida', amountCents: 200 }]);
        expect(session.params.successUrl).toContain(`/registro/confirmacion/${reg.public_code}?pago=exito`);

        const payment = await db.selectFrom('payments').selectAll().where('registration_id', '=', reg.id).executeTakeFirstOrThrow();
        expect(payment).toMatchObject({ method: 'stripe', status: 'pending', amount_cents: 600 });
        // La confirmación espera al pago
        expect(await db.selectFrom('email_messages').select('id').where('registration_id', '=', reg.id).executeTakeFirst()).toBeUndefined();
    });

    it('la confirmación ofrece pagar con tarjeta solo si falta pagar y Stripe está listo', async () => {
        const { reg } = await register('offline');
        const page = () => request(app).get(`/api/v2/public/registrations/${reg.public_code}`).set('X-Tenant', s.tenantA.slug);
        expect((await page()).body.data.canPayOnline).toBe(true);
        await finance.post(`/registrations/${reg.id}/payments`, { method: 'cash' });
        expect((await page()).body.data.canPayOnline).toBe(false);
    });

    it('una firma inválida se rechaza', async () => {
        const ev = stripe.signedEvent('checkout.session.completed', { id: 'cs_x' }, accountId);
        const res = await webhook({ payload: ev.payload, signature: 't=1,v1=falsa' });
        expect(res.status).toBe(400);
    });

    it('pago completado: confirma, marca pagado, encola la confirmación; el reintento de Stripe no duplica', async () => {
        const { reg } = await register('online');
        const payment = await db.selectFrom('payments').selectAll().where('registration_id', '=', reg.id).executeTakeFirstOrThrow();
        const event = stripe.signedEvent('checkout.session.completed', paidSession(payment.stripe_checkout_session_id!, 600), accountId);

        expect((await webhook(event)).body.data).toEqual({ received: true, duplicate: false });
        expect((await webhook(event)).body.data).toEqual({ received: true, duplicate: true });

        const d = await detail(reg.id);
        expect(d).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', paidCents: 600 });
        expect(d.items.every((i: any) => i.paymentStatus === 'paid')).toBe(true);
        expect(d.payments[0]).toMatchObject({ method: 'stripe', status: 'succeeded', amountCents: 600 });

        const audits = await db.selectFrom('audit_logs').select(['actor_type']).where('action', '=', 'payment.succeeded')
            .where('entity_id', '=', String(reg.id)).execute();
        expect(audits).toEqual([{ actor_type: 'stripe' }]);
        const mails = await db.selectFrom('email_messages').select('status').where('registration_id', '=', reg.id).execute();
        expect(mails).toHaveLength(1);
    });

    it('sesión vencida sin pagar: se cancela el registro y se libera el lugar', async () => {
        const { reg } = await register('online');
        const payment = await db.selectFrom('payments').selectAll().where('registration_id', '=', reg.id).executeTakeFirstOrThrow();
        await webhook(stripe.signedEvent('checkout.session.expired', { id: payment.stripe_checkout_session_id, object: 'checkout.session' }, accountId));
        const row = await db.selectFrom('registrations').select(['status']).where('id', '=', reg.id).executeTakeFirstOrThrow();
        expect(row.status).toBe('cancelled');
        const p = await db.selectFrom('payments').select('status').where('id', '=', payment.id).executeTakeFirstOrThrow();
        expect(p.status).toBe('canceled');
    });

    it('reintentar el pago expira la sesión anterior; quien eligió efectivo también puede pagar con tarjeta después', async () => {
        const { reg } = await register('online');
        const old = await db.selectFrom('payments').selectAll().where('registration_id', '=', reg.id).executeTakeFirstOrThrow();
        const retry = await request(app).post(`/api/v2/public/registrations/${reg.public_code}/checkout`).set('X-Tenant', s.tenantA.slug);
        expect(retry.status).toBe(200);
        expect(stripe.calls.some(c => c.type === 'expireCheckoutSession' && c.args[1] === old.stripe_checkout_session_id)).toBe(true);
        const statuses = await db.selectFrom('payments').select('status').where('registration_id', '=', reg.id).orderBy('id').execute();
        expect(statuses.map(x => x.status)).toEqual(['canceled', 'pending']);

        const offline = await register('offline');
        const later = await request(app).post(`/api/v2/public/registrations/${offline.reg.public_code}/checkout`).set('X-Tenant', s.tenantA.slug);
        expect(later.body.data.checkoutUrl).toMatch(/checkout\.stripe\.test/);
    });
});

describe('reembolsos', () => {
    async function paidOnline() {
        const { reg } = await register('online');
        const payment = await db.selectFrom('payments').selectAll().where('registration_id', '=', reg.id).executeTakeFirstOrThrow();
        const pi = `pi_${uniq()}`;
        await webhook(stripe.signedEvent('checkout.session.completed', {
            id: payment.stripe_checkout_session_id, object: 'checkout.session', payment_status: 'paid', amount_total: 600, payment_intent: pi,
        }, accountId));
        return { reg, paymentId: payment.id, pi };
    }

    it('parcial y luego total desde el panel (se hace en Stripe)', async () => {
        const { reg, paymentId, pi } = await paidOnline();
        expect((await staff.post(`/payments/${paymentId}/refund`, { reason: 'x', amountCents: 100 })).status).toBe(403);
        expect((await finance.post(`/payments/${paymentId}/refund`, { reason: 'Mucho', amountCents: 9999 })).status).toBe(400);

        const partial = await finance.post(`/payments/${paymentId}/refund`, { reason: 'No usó la comida', amountCents: 200 });
        expect(partial.body.data).toMatchObject({ refundedCents: 200, paymentStatus: 'paid', paidCents: 400 });
        expect(stripe.calls.find(c => c.type === 'createRefund')!.args).toEqual([accountId, pi, 200, 'No usó la comida']);

        const full = await finance.post(`/payments/${paymentId}/refund`, { reason: 'Canceló su asistencia' });
        expect(full.body.data).toMatchObject({ refundedCents: 600, paymentStatus: 'refunded', paidCents: 0 });
        const d = await detail(reg.id);
        expect(d.items.every((i: any) => i.paymentStatus === 'refunded')).toBe(true);

        // Stripe avisa después del mismo reembolso: no se cuenta dos veces
        await webhook(stripe.signedEvent('charge.refunded', { id: 'ch_x', object: 'charge', payment_intent: pi, amount_refunded: 600 }, accountId));
        const refunds = await db.selectFrom('refunds').select('amount_cents').where('payment_id', '=', paymentId).execute();
        expect(refunds.map(r => r.amount_cents)).toEqual([200, 400]);
    });

    it('reembolso hecho directo en el dashboard de Stripe se refleja por webhook', async () => {
        const { reg, paymentId, pi } = await paidOnline();
        const ev = stripe.signedEvent('charge.refunded', { id: 'ch_y', object: 'charge', payment_intent: pi, amount_refunded: 600 }, accountId);
        await webhook(ev);
        await webhook(ev);
        const refunds = await db.selectFrom('refunds').selectAll().where('payment_id', '=', paymentId).execute();
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({ amount_cents: 600, created_by: null });
        expect((await detail(reg.id)).paymentStatus).toBe('refunded');
    });

    it('reembolso de un pago en efectivo: solo se registra (no llama a Stripe)', async () => {
        const { reg } = await register('offline');
        const pay = await finance.post(`/registrations/${reg.id}/payments`, { method: 'cash' });
        const before = stripe.calls.filter(c => c.type === 'createRefund').length;
        const res = await finance.post(`/payments/${pay.body.data.paymentId}/refund`, { reason: 'Devolución en efectivo' });
        expect(res.body.data).toMatchObject({ paymentStatus: 'refunded', paidCents: 0 });
        expect(stripe.calls.filter(c => c.type === 'createRefund').length).toBe(before);
    });
});

describe('vista de pagos del evento', () => {
    it('lista de movimientos con totales cobrados, reembolsados y neto', async () => {
        const res = await finance.get(`/events/${eventId}/payments?status=succeeded`);
        expect(res.status).toBe(200);
        expect(res.body.data.items.every((p: any) => p.status === 'succeeded')).toBe(true);
        const all = await finance.get(`/events/${eventId}/payments`);
        const { collectedCents, refundedCents, netCents } = all.body.data.totals;
        expect(netCents).toBe(collectedCents - refundedCents);
        expect(refundedCents).toBeGreaterThan(0);
    });
});
