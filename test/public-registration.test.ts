import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { db, destroyDb } from '../src/db/client';
import { fromJson } from '../src/db/json';
import { sentMailsForTests } from '../src/core/mailer';
import { FEJA_FORM_SCHEMA, TSHIRT_VARIANTS } from '../src/db/import-v1/feja-form';
import { processEmailQueue, MAX_ATTEMPTS } from '../src/modules/email/email-queue';
import { buildScenario } from './fixtures';
import { as, loginAs } from './http';
import { uniq } from './helpers';

const app = createApp();
let s: Awaited<ReturnType<typeof buildScenario>>;
let owner: ReturnType<typeof as>;
let church: { id: number; name: string };
let caChurch: { id: number };

const t = (es: string, en = es) => ({ es, en });

beforeAll(async () => {
    s = await buildScenario();
    owner = as(app, (await loginAs(app, s.users.owner.email, s.tenantA.slug)).token, s.tenantA.slug);
    // Estados de las asociaciones del escenario
    const states = await db.selectFrom('us_states').select(['id', 'code']).where('code', 'in', ['AZ', 'CA']).execute();
    const st = Object.fromEntries(states.map(x => [x.code, x.id]));
    await db.insertInto('organization_states').ignore().values([
        { organization_id: s.orgs.az, state_id: st.AZ }, { organization_id: s.orgs.ca, state_id: st.CA },
    ]).execute();
    church = (await owner.post('/organizations/churches', { conferenceId: s.orgs.az, name: `Shalom ${uniq()}` })).body.data;
    caChurch = (await owner.post('/organizations/churches', { conferenceId: s.orgs.ca, name: `Fresno ${uniq()}` })).body.data;
});
afterAll(async () => {
    await destroyDb();
});

/** Evento publicado con el formulario de FEJA abierto y pago en efectivo. */
async function openFejaForm(opts: { payments?: boolean; maxRegistrations?: number; stockM?: number; fee?: number } = {}) {
    const ev = await owner.post('/events', {
        slug: `feja-${uniq()}`, name: t('Congreso FEJA', 'FEJA Congress'), venue: 'Phoenix, AZ',
        startsAt: '2027-10-15T17:00:00-07:00', endsAt: '2027-10-17T18:00:00-07:00', timezone: 'America/Phoenix',
    });
    const eventId = ev.body.data.id;
    const formId = (await owner.post(`/events/${eventId}/forms`, { title: t('Registro', 'Registration') })).body.data.id;
    await owner.post(`/forms/${formId}/items`, {
        code: 'tshirt', kind: 'product', name: t('Playera', 'T-shirt'), priceCents: 400,
        variants: TSHIRT_VARIANTS.map(v => ({ code: v.code, label: v.label, stock: v.code === 'M' ? opts.stockM ?? null : null })),
    });
    await owner.post(`/forms/${formId}/items`, { code: 'lunch', kind: 'product', name: t('Comida', 'Lunch'), priceCents: 200 });
    if (opts.fee) await owner.post(`/forms/${formId}/items`, { code: 'cuota', kind: 'registration_fee', name: t('Inscripción', 'Registration fee'), priceCents: opts.fee });
    await owner.put(`/forms/${formId}/draft`, { schema: FEJA_FORM_SCHEMA });
    await owner.post(`/forms/${formId}/publish`);
    await owner.patch(`/forms/${formId}`, {
        paymentsEnabled: opts.payments ?? true,
        settings: { confirmationMessage: t('Trae tu Biblia', 'Bring your Bible') },
        ...(opts.maxRegistrations ? { maxRegistrations: opts.maxRegistrations } : {}),
    });
    await owner.post(`/events/${eventId}/status`, { status: 'published' });
    await owner.post(`/forms/${formId}/status`, { status: 'open' });
    return { eventId, formId, slug: ev.body.data.slug as string };
}

const person = (overrides: Record<string, unknown> = {}) => ({
    first_name: 'Ana', last_name: `López ${uniq()}`, email: `ana-${uniq()}@example.test`, phone: '602-555-0101',
    birth_date: '2008-04-02', gender: 'female',
    location: { state: 'AZ', conference_id: s.orgs.az }, city: 'Phoenix', church: { church_id: church.id },
    is_chaperone: false, wants_tshirt: true, tshirt_size: 'M', wants_lunch: true, diet: 'vegan',
    emergency_name: 'Mamá', emergency_phone: '6025550000', emergency_relationship: 'padres',
    ...overrides,
});

const register = (formId: number, answers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    request(app).post(`/api/v2/public/forms/${formId}/registrations`).set('X-Tenant', s.tenantA.slug)
        .send({ answers, locale: 'es', ...extra });

describe('lectura pública', () => {
    it('inicio del cliente: lista sus eventos publicados con disponibilidad y el formulario abierto', async () => {
        const { formId, slug } = await openFejaForm();
        const draft = await owner.post('/events', {
            slug: `oculto-${uniq()}`, name: t('Borrador'), startsAt: '2027-01-01T00:00:00Z', endsAt: '2027-01-02T00:00:00Z', timezone: 'UTC',
        });
        const res = await request(app).get('/api/v2/public/events').set('X-Tenant', s.tenantA.slug);
        expect(res.status).toBe(200);
        const mine = res.body.data.find((e: any) => e.slug === slug);
        expect(mine).toMatchObject({ availability: 'open', openFormId: formId, status: 'published' });
        expect(res.body.data.map((e: any) => e.slug)).not.toContain(draft.body.data.slug);
        // Otro cliente no ve los eventos de este
        const other = await request(app).get('/api/v2/public/events').set('X-Tenant', s.tenantB.slug);
        expect(other.body.data.map((e: any) => e.slug)).not.toContain(slug);

        await owner.post(`/forms/${formId}/status`, { status: 'closed' });
        const closed = await request(app).get('/api/v2/public/events').set('X-Tenant', s.tenantA.slug);
        expect(closed.body.data.find((e: any) => e.slug === slug)).toMatchObject({ availability: 'closed', openFormId: null });
    });

    it('evento y formulario abiertos, con productos y disponibilidad', async () => {
        const { formId, slug } = await openFejaForm();
        const ev = await request(app).get(`/api/v2/public/events/${slug}`).set('X-Tenant', s.tenantA.slug);
        expect(ev.status).toBe(200);
        expect(ev.body.data.forms).toEqual([expect.objectContaining({ id: formId, availability: 'open' })]);

        const form = await request(app).get(`/api/v2/public/forms/${formId}`).set('X-Tenant', s.tenantA.slug);
        expect(form.body.data.schema.steps).toHaveLength(2);
        expect(form.body.data.items.map((i: any) => i.code)).toEqual(['tshirt', 'lunch']);
        expect(form.body.data.payments).toEqual({ enabled: true, online: false, offline: true, currency: 'usd' });
    });

    it('un evento en borrador no existe para el público', async () => {
        const ev = await owner.post('/events', {
            slug: `borrador-${uniq()}`, name: t('X'), startsAt: '2027-01-01T00:00:00Z', endsAt: '2027-01-02T00:00:00Z', timezone: 'UTC',
        });
        const res = await request(app).get(`/api/v2/public/events/${ev.body.data.slug}`).set('X-Tenant', s.tenantA.slug);
        expect(res.status).toBe(404);
    });

    it('estados con sus asociaciones e iglesias verificadas', async () => {
        const loc = await request(app).get('/api/v2/public/locations').set('X-Tenant', s.tenantA.slug);
        const az = loc.body.data.find((x: any) => x.code === 'AZ');
        expect(az.conferences.map((c: any) => c.id)).toEqual([s.orgs.az]);
        const churches = await request(app).get(`/api/v2/public/conferences/${s.orgs.az}/churches`).set('X-Tenant', s.tenantA.slug);
        expect(churches.body.data.map((c: any) => c.id)).toContain(church.id);
        // Asociación de otro cliente
        const other = await request(app).get(`/api/v2/public/conferences/${s.orgs.unionB}/churches`).set('X-Tenant', s.tenantA.slug);
        expect(other.status).toBe(404);
    });
});

describe('registro', () => {
    it('crea el registro completo: precios congelados, respuestas, auditoría y correo en cola', async () => {
        const { formId, eventId } = await openFejaForm();
        const answers = person();
        const res = await register(formId, answers);
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ status: 'confirmed', paymentStatus: 'unpaid', paymentMethod: 'offline', totalCents: 600 });
        const code = res.body.data.publicCode;

        const reg = await db.selectFrom('registrations').selectAll().where('public_code', '=', code).executeTakeFirstOrThrow();
        expect(reg).toMatchObject({
            event_id: eventId, conference_organization_id: s.orgs.az, church_organization_id: church.id,
            first_name: 'Ana', email: (answers.email as string).toLowerCase(), gender: 'female', source: 'public_form',
        });
        expect(fromJson(reg.answers)).toMatchObject({ state: 'AZ', city: 'Phoenix', diet: 'vegan', is_chaperone: false });

        const items = await db.selectFrom('registration_items').select(['unit_price_cents', 'payment_status']).where('registration_id', '=', reg.id).execute();
        expect(items.map(i => i.unit_price_cents).sort()).toEqual([200, 400]);

        const audit = await db.selectFrom('audit_logs').selectAll().where('action', '=', 'registration.created').where('entity_id', '=', String(reg.id)).executeTakeFirstOrThrow();
        expect(audit).toMatchObject({ actor_type: 'participant', actor_user_id: null, tenant_id: s.tenantA.id, event_id: eventId });

        const queued = await db.selectFrom('email_messages').selectAll().where('registration_id', '=', reg.id).executeTakeFirstOrThrow();
        expect(queued).toMatchObject({ status: 'queued', template: 'registration_confirmation', attempts: 0 });

        // Cambiar el precio después no afecta a quien ya se registró
        const tshirt = (await owner.get(`/forms/${formId}`)).body.data.items.find((i: any) => i.code === 'tshirt');
        await owner.patch(`/forms/${formId}/items/${tshirt.id}`, { priceCents: 900 });
        const after = await db.selectFrom('registrations').select('total_cents').where('id', '=', reg.id).executeTakeFirstOrThrow();
        expect(after.total_cents).toBe(600);
    });

    it('el correo de confirmación sale con QR, código y datos del evento', async () => {
        const { formId } = await openFejaForm();
        const answers = person();
        const code = (await register(formId, answers)).body.data.publicCode;

        const summary = await processEmailQueue();
        expect(summary.sent).toBeGreaterThanOrEqual(1);
        const mail = [...sentMailsForTests].reverse().find(m => m.to === (answers.email as string).toLowerCase())!;
        expect(mail.subject).toBe('Registro confirmado: Congreso FEJA');
        expect(mail.text).toContain(code);
        expect(mail.text).toContain(`/registro/confirmacion/${code}`);
        expect(mail.text).toContain('Trae tu Biblia');
        expect(mail.html).toContain('cid:registro-qr');
        expect(mail.attachments?.[0]).toMatchObject({ cid: 'registro-qr', contentType: 'image/png' });
        expect(mail.attachments![0].content.subarray(1, 4).toString()).toBe('PNG');

        const row = await db.selectFrom('email_messages').select(['status', 'sent_at']).where('to_email', '=', mail.to).executeTakeFirstOrThrow();
        expect(row.status).toBe('sent');
    });

    it('la confirmación indica que no puede pagar en línea si no hay Stripe', async () => {
        const { formId } = await openFejaForm();
        const code = (await register(formId, person())).body.data.publicCode;
        const res = await request(app).get(`/api/v2/public/registrations/${code}`).set('X-Tenant', s.tenantA.slug);
        expect(res.body.data.canPayOnline).toBe(false);
    });

    it('la página de confirmación muestra el registro sin datos de contacto', async () => {
        const { formId } = await openFejaForm();
        const code = (await register(formId, person({ wants_lunch: false }))).body.data.publicCode;
        const res = await request(app).get(`/api/v2/public/registrations/${code}`).set('X-Tenant', s.tenantA.slug);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ firstName: 'Ana', totalCents: 400, paymentStatus: 'unpaid', checkedIn: false });
        expect(res.body.data).not.toHaveProperty('email');
        expect(res.body.data.items).toEqual([expect.objectContaining({ code: 'tshirt', variant: expect.objectContaining({ code: 'M' }) })]);
        // Desde otro cliente no existe
        const other = await request(app).get(`/api/v2/public/registrations/${code}`).set('X-Tenant', s.tenantB.slug);
        expect(other.status).toBe(404);
    });

    it('respuestas inválidas: 400 con el error de cada campo', async () => {
        const { formId } = await openFejaForm();
        const res = await register(formId, person({ email: 'no-es-correo', tshirt_size: 'XXXL', diet: undefined }));
        expect(res.status).toBe(400);
        const codes = Object.fromEntries(res.body.details.errors.map((e: any) => [e.field, e.code]));
        expect(codes).toEqual({ email: 'invalid', tshirt_size: 'invalid_option', diet: 'required' });
    });

    it('la asociación debe ser del estado elegido y del cliente', async () => {
        const { formId } = await openFejaForm();
        const wrongState = await register(formId, person({ location: { state: 'CA', conference_id: s.orgs.az } }));
        expect(wrongState.status).toBe(400);
        expect(wrongState.body.details.errors[0]).toMatchObject({ field: 'location', code: 'invalid_option' });
        const otherTenant = await register(formId, person({ location: { state: 'AZ', conference_id: s.orgs.unionB } }));
        expect(otherTenant.status).toBe(400);
    });

    it('la iglesia elegida debe pertenecer a la asociación elegida', async () => {
        const { formId } = await openFejaForm();
        const res = await register(formId, person({ church: { church_id: caChurch.id } }));
        expect(res.status).toBe(400);
        expect(res.body.details.errors[0]).toMatchObject({ field: 'church', code: 'invalid_option' });
    });

    it('"mi iglesia no está": se crea pendiente y la siguiente persona que la escribe igual la reutiliza', async () => {
        const { formId } = await openFejaForm();
        const name = `Nueva Esperanza ${uniq()}`;
        const first = await register(formId, person({ church: { new_name: name } }));
        expect(first.status).toBe(201);
        const second = await register(formId, person({ church: { new_name: `  ${name.toUpperCase()} ` } }));
        expect(second.status).toBe(201);

        const regs = await db.selectFrom('registrations').select(['church_organization_id', 'church_name_raw'])
            .where('public_code', 'in', [first.body.data.publicCode, second.body.data.publicCode]).execute();
        expect(new Set(regs.map(r => r.church_organization_id)).size).toBe(1);
        const created = await db.selectFrom('organizations').select(['status', 'source', 'parent_id'])
            .where('id', '=', regs[0].church_organization_id!).executeTakeFirstOrThrow();
        expect(created).toEqual({ status: 'pending', source: 'registration', parent_id: s.orgs.az });

        // No aparece en la lista pública hasta que se apruebe
        const list = await request(app).get(`/api/v2/public/conferences/${s.orgs.az}/churches`).set('X-Tenant', s.tenantA.slug);
        expect(list.body.data.map((c: any) => c.id)).not.toContain(regs[0].church_organization_id);
    });

    it('la misma persona no se registra dos veces en el evento', async () => {
        const { formId } = await openFejaForm();
        const answers = person();
        expect((await register(formId, answers)).status).toBe(201);
        const again = await register(formId, { ...answers, email: (answers.email as string).toUpperCase() });
        expect(again.status).toBe(409);
        expect(again.body.details.reason).toBe('already_registered');
        // Un hermano con el mismo correo sí puede
        expect((await register(formId, { ...answers, first_name: 'Luis' })).status).toBe(201);
    });
});

describe('disponibilidad', () => {
    it('cupo lleno', async () => {
        const { formId } = await openFejaForm({ maxRegistrations: 1 });
        expect((await register(formId, person())).status).toBe(201);
        const res = await register(formId, person());
        expect(res.status).toBe(409);
        expect(res.body.details.reason).toBe('full');
    });

    it('talla agotada', async () => {
        const { formId } = await openFejaForm({ stockM: 1 });
        expect((await register(formId, person())).status).toBe(201);
        const res = await register(formId, person());
        expect(res.status).toBe(409);
        expect(res.body.details).toMatchObject({ reason: 'sold_out', variant: 'M' });
        expect((await register(formId, person({ tshirt_size: 'L' }))).status).toBe(201);
    });

    it('registro cerrado, todavía no abre o ya cerró por fecha', async () => {
        const { formId } = await openFejaForm();
        await owner.patch(`/forms/${formId}`, { opensAt: '2099-01-01T00:00:00Z', closesAt: '2099-02-01T00:00:00Z' });
        expect((await register(formId, person())).body.details.reason).toBe('not_open_yet');
        await owner.patch(`/forms/${formId}`, { opensAt: '2020-01-01T00:00:00Z', closesAt: '2020-02-01T00:00:00Z' });
        expect((await register(formId, person())).body.details.reason).toBe('closed');
        await owner.patch(`/forms/${formId}`, { opensAt: null, closesAt: null });
        await owner.post(`/forms/${formId}/status`, { status: 'closed' });
        expect((await register(formId, person())).status).toBe(409);
    });

    it('cupo con registros simultáneos: nunca se pasa del límite', async () => {
        const { formId } = await openFejaForm({ maxRegistrations: 3 });
        const results = await Promise.all(Array.from({ length: 8 }, () => register(formId, person())));
        expect(results.filter(r => r.status === 201)).toHaveLength(3);
        const count = await db.selectFrom('registrations').select(eb => eb.fn.countAll<number>().as('n')).where('form_id', '=', formId).executeTakeFirstOrThrow();
        expect(Number(count.n)).toBe(3);
    });
});

describe('pagos', () => {
    it('la cuota de inscripción obligatoria se agrega sola', async () => {
        const { formId } = await openFejaForm({ fee: 2500 });
        const res = await register(formId, person({ wants_tshirt: false, wants_lunch: false }));
        expect(res.body.data.totalCents).toBe(2500);
        expect(res.body.data.items.map((i: any) => i.code)).toEqual(['cuota']);
    });

    it('sin pagos activos no se cobra nada', async () => {
        const { formId } = await openFejaForm({ payments: false });
        const res = await register(formId, person());
        expect(res.body.data).toMatchObject({ paymentStatus: 'not_required', paymentMethod: null });
    });

    it('pago en línea todavía no disponible (llega con Stripe)', async () => {
        const { formId } = await openFejaForm();
        const res = await register(formId, person(), { paymentMethod: 'online' });
        expect(res.status).toBe(400);
    });
});

describe('bandeja de correos', () => {
    it('reintenta si falla y lo da por perdido tras varios intentos', async () => {
        const { formId } = await openFejaForm();
        await processEmailQueue(); // vacía lo anterior
        const answers = person();
        await register(formId, answers);
        const failing = async () => ({ ok: false, providerMessageId: null, error: 'SMTP caído' });

        for (let i = 1; i < MAX_ATTEMPTS; i++) {
            expect(await processEmailQueue({ deliver: failing })).toMatchObject({ retrying: 1 });
        }
        expect(await processEmailQueue({ deliver: failing })).toMatchObject({ failed: 1 });
        const row = await db.selectFrom('email_messages').select(['status', 'attempts', 'last_error'])
            .where('to_email', '=', (answers.email as string).toLowerCase()).executeTakeFirstOrThrow();
        expect(row).toEqual({ status: 'failed', attempts: MAX_ATTEMPTS, last_error: 'SMTP caído' });
    });
});
