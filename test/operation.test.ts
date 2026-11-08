import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { db, destroyDb } from '../src/db/client';
import { fromJson } from '../src/db/json';
import { FEJA_FORM_SCHEMA, TSHIRT_VARIANTS } from '../src/db/import-v1/feja-form';
import { addMembership, buildScenario, createUser } from './fixtures';
import { as, loginAs } from './http';
import { uniq } from './helpers';

const app = createApp();
let s: Awaited<ReturnType<typeof buildScenario>>;
type Client = ReturnType<typeof as>;
let owner: Client, staff: Client, finance: Client, viewerAz: Client, azStaff: Client;
let eventId: number, formId: number, otherEventId: number;
let azChurch: number, caChurch: number;
const regs: Record<string, { id: number; code: string }> = {};

const t = (es: string, en = es) => ({ es, en });

async function clientFor(role: 'staff' | 'owner', scope: number | null = null) {
    const u = await createUser();
    await addMembership(s.tenantA.id, u.id, role, scope);
    return as(app, (await loginAs(app, u.email, s.tenantA.slug)).token, s.tenantA.slug);
}

async function setupEvent() {
    const ev = await owner.post('/events', {
        slug: `op-${uniq()}`, name: t('Congreso', 'Congress'), venue: 'Phoenix',
        startsAt: '2027-10-15T17:00:00-07:00', endsAt: '2027-10-17T18:00:00-07:00', timezone: 'America/Phoenix',
    });
    const id = ev.body.data.id;
    const fId = (await owner.post(`/events/${id}/forms`, { title: t('Registro') })).body.data.id;
    await owner.post(`/forms/${fId}/items`, {
        code: 'tshirt', kind: 'product', name: t('Playera', 'T-shirt'), priceCents: 400,
        variants: TSHIRT_VARIANTS.map(v => ({ code: v.code, label: v.label, stock: v.code === 'XL' ? 1 : null })),
    });
    await owner.post(`/forms/${fId}/items`, { code: 'lunch', kind: 'product', name: t('Comida', 'Lunch'), priceCents: 200 });
    await owner.put(`/forms/${fId}/draft`, { schema: FEJA_FORM_SCHEMA });
    await owner.post(`/forms/${fId}/publish`);
    await owner.patch(`/forms/${fId}`, { paymentsEnabled: true });
    await owner.post(`/events/${id}/status`, { status: 'published' });
    await owner.post(`/forms/${fId}/status`, { status: 'open' });
    return { id, formId: fId };
}

const person = (o: Record<string, unknown>) => ({
    first_name: 'Persona', last_name: `Apellido ${uniq()}`, email: `p-${uniq()}@example.test`, phone: '6025550101',
    birth_date: '2008-04-02', gender: 'female', location: { state: 'AZ', conference_id: s.orgs.az }, city: 'Phoenix',
    church: { church_id: azChurch }, is_chaperone: false, wants_tshirt: false, wants_lunch: false,
    emergency_name: 'Mamá', emergency_phone: '6025550000', emergency_relationship: 'padres', ...o,
});

async function registerAs(key: string, fId: number, answers: Record<string, unknown>) {
    const res = await request(app).post(`/api/v2/public/forms/${fId}/registrations`).set('X-Tenant', s.tenantA.slug)
        .send({ answers, locale: 'es' });
    if (res.status !== 201) throw new Error(`Registro falló: ${JSON.stringify(res.body)}`);
    const row = await db.selectFrom('registrations').select('id').where('public_code', '=', res.body.data.publicCode).executeTakeFirstOrThrow();
    regs[key] = { id: row.id, code: res.body.data.publicCode };
}

beforeAll(async () => {
    s = await buildScenario();
    const tenant = s.tenantA.slug;
    owner = as(app, (await loginAs(app, s.users.owner.email, tenant)).token, tenant);
    finance = as(app, (await loginAs(app, s.users.finance.email, tenant)).token, tenant);
    viewerAz = as(app, (await loginAs(app, s.users.viewerAz.email, tenant)).token, tenant);
    staff = await clientFor('staff');
    azStaff = await clientFor('staff', s.orgs.az);

    const states = await db.selectFrom('us_states').select(['id', 'code']).where('code', 'in', ['AZ', 'CA']).execute();
    const st = Object.fromEntries(states.map(x => [x.code, x.id]));
    await db.insertInto('organization_states').ignore().values([
        { organization_id: s.orgs.az, state_id: st.AZ }, { organization_id: s.orgs.ca, state_id: st.CA },
    ]).execute();
    azChurch = (await owner.post('/organizations/churches', { conferenceId: s.orgs.az, name: `Shalom ${uniq()}` })).body.data.id;
    caChurch = (await owner.post('/organizations/churches', { conferenceId: s.orgs.ca, name: `Fresno ${uniq()}` })).body.data.id;

    ({ id: eventId, formId } = await setupEvent());
    await registerAs('ana', formId, person({ first_name: 'Ana', last_name: 'Zamora', wants_tshirt: true, tshirt_size: 'M', wants_lunch: true, diet: 'vegan' }));
    await registerAs('beto', formId, person({ first_name: 'Beto', last_name: 'Álvarez', wants_tshirt: true, tshirt_size: 'L', wants_lunch: true, diet: 'regular' }));
    await registerAs('cata', formId, person({ first_name: 'Cata', last_name: 'Mena', wants_lunch: true, diet: 'vegan' }));
    const ca = { location: { state: 'CA', conference_id: s.orgs.ca }, church: { church_id: caChurch } };
    await registerAs('dani', formId, person({ ...ca, first_name: 'Dani', last_name: 'Ruiz', gender: 'male', wants_tshirt: true, tshirt_size: 'M' }));
    await registerAs('eli', formId, person({ ...ca, first_name: '=HYPERLINK("http://x")', last_name: 'Soto', gender: 'male' }));

    const other = await setupEvent();
    otherEventId = other.id;
    await registerAs('otro', other.formId, person({ first_name: 'Otro', last_name: 'Evento' }));
});
afterAll(async () => {
    await destroyDb();
});

const names = (res: request.Response) => res.body.data.items.map((r: any) => r.firstName).sort();

describe('lista con filtros', () => {
    it('todos, búsqueda, asociación, producto/talla, pago y orden', async () => {
        const base = `/events/${eventId}/registrations`;
        expect((await owner.get(base)).body.data.total).toBe(5);
        expect(names(await owner.get(`${base}?q=zamo`))).toEqual(['Ana']);
        expect(names(await owner.get(`${base}?q=${encodeURIComponent('Ana Zamora')}`))).toEqual(['Ana']);
        expect(names(await owner.get(`${base}?q=${regs.beto.code}`))).toEqual(['Beto']);
        expect((await owner.get(`${base}?conferenceId=${s.orgs.az}`)).body.data.total).toBe(3);
        expect(names(await owner.get(`${base}?itemCode=tshirt&variantCode=M`))).toEqual(['Ana', 'Dani']);
        expect((await owner.get(`${base}?paymentStatus=not_required`)).body.data.items.map((r: any) => r.lastName)).toEqual(['Soto']);
        const sorted = await owner.get(`${base}?sort=last_name&order=asc`);
        expect(sorted.body.data.items[0].lastName).toBe('Álvarez');
        expect(sorted.body.data.items[0].items.map((i: any) => `${i.code}:${i.variantCode ?? ''}`)).toEqual(['tshirt:L', 'lunch:']);
    });

    it('el lector de AZ solo ve los de AZ, también con filtros', async () => {
        const res = await viewerAz.get(`/events/${eventId}/registrations?itemCode=tshirt`);
        expect(names(res)).toEqual(['Ana', 'Beto']);
    });

    it('la papelera solo para quien puede borrar', async () => {
        expect((await viewerAz.get(`/events/${eventId}/registrations?deleted=only`)).status).toBe(403);
    });
});

describe('detalle y edición', () => {
    it('detalle con respuestas y sus etiquetas; fuera del alcance es 404', async () => {
        const res = await owner.get(`/registrations/${regs.ana.id}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ firstName: 'Ana', conference: { id: s.orgs.az }, totalCents: 600, paymentStatus: 'unpaid' });
        expect(res.body.data.answers.diet).toBe('vegan');
        expect(res.body.data.answerLabels.diet).toEqual({ es: 'Preferencia alimenticia', en: 'Dietary preference' });
        expect((await viewerAz.get(`/registrations/${regs.dani.id}`)).status).toBe(404);
    });

    it('staff edita datos y respuestas; la auditoría guarda antes y después', async () => {
        const res = await staff.patch(`/registrations/${regs.cata.id}`, { firstName: 'Catalina', answers: { diet: 'vegetarian' } });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ firstName: 'Catalina', answers: { diet: 'vegetarian' } });
        const log = await db.selectFrom('audit_logs').select('changes').where('action', '=', 'registration.updated')
            .where('entity_id', '=', String(regs.cata.id)).orderBy('id', 'desc').executeTakeFirstOrThrow();
        expect(fromJson(log.changes)).toEqual({
            firstName: { from: 'Cata', to: 'Catalina' },
            'answers.diet': { from: 'vegan', to: 'vegetarian' },
        });
    });

    it('las respuestas se validan con las reglas del formulario', async () => {
        expect((await staff.patch(`/registrations/${regs.cata.id}`, { answers: { diet: 'pizza' } })).status).toBe(400);
        expect((await staff.patch(`/registrations/${regs.cata.id}`, { answers: { location: { state: 'CA' } } })).status).toBe(400);
        expect((await staff.patch(`/registrations/${regs.cata.id}`, { answers: { no_existe: 1 } })).status).toBe(400);
        expect((await staff.patch(`/registrations/${regs.cata.id}`, { email: 'mal' })).status).toBe(400);
    });

    it('permisos: lector y finanzas no editan datos', async () => {
        expect((await viewerAz.patch(`/registrations/${regs.ana.id}`, { firstName: 'X' })).status).toBe(403);
        expect((await finance.patch(`/registrations/${regs.ana.id}`, { firstName: 'X' })).status).toBe(403);
    });

    it('asociación e iglesia deben ser coherentes y dentro del alcance de quien edita', async () => {
        expect((await owner.patch(`/registrations/${regs.beto.id}`, { conferenceOrganizationId: s.orgs.ca })).status).toBe(400);
        const moved = await owner.patch(`/registrations/${regs.beto.id}`, { conferenceOrganizationId: s.orgs.ca, churchOrganizationId: caChurch });
        expect(moved.status).toBe(200);
        expect(moved.body.data.church.id).toBe(caChurch);
        // Un staff de AZ no puede mandar a alguien a CA
        expect((await azStaff.patch(`/registrations/${regs.ana.id}`, { conferenceOrganizationId: s.orgs.ca, churchOrganizationId: caChurch })).status).toBe(400);
        await owner.patch(`/registrations/${regs.beto.id}`, { conferenceOrganizationId: s.orgs.az, churchOrganizationId: azChurch });
    });

    it('cambiar talla respeta existencias', async () => {
        const detail = (await owner.get(`/registrations/${regs.ana.id}`)).body.data;
        const tshirt = detail.items.find((i: any) => i.code === 'tshirt');
        expect((await staff.patch(`/registrations/${regs.ana.id}/items/${tshirt.id}`, { variantCode: 'XL' })).body.data.items[0].variant.code).toBe('XL');
        const dani = (await owner.get(`/registrations/${regs.dani.id}`)).body.data.items.find((i: any) => i.code === 'tshirt');
        expect((await staff.patch(`/registrations/${regs.dani.id}/items/${dani.id}`, { variantCode: 'XL' })).status).toBe(409);
        await staff.patch(`/registrations/${regs.ana.id}/items/${tshirt.id}`, { variantCode: 'M' });
    });
});

describe('borrar y restaurar', () => {
    it('borrado lógico con motivo y copia en la auditoría; se puede restaurar', async () => {
        expect((await finance.delete(`/registrations/${regs.eli.id}`)).status).toBe(403);
        const del = await staff.delete(`/registrations/${regs.eli.id}`).send({ reason: 'Registro de prueba' });
        expect(del.status).toBe(200);
        expect((await owner.get(`/registrations/${regs.eli.id}`)).status).toBe(404);
        expect(names(await owner.get(`/events/${eventId}/registrations?deleted=only`))).toEqual(['=HYPERLINK("http://x")']);

        const log = await db.selectFrom('audit_logs').select('metadata').where('action', '=', 'registration.deleted')
            .where('entity_id', '=', String(regs.eli.id)).executeTakeFirstOrThrow();
        expect(fromJson<any>(log.metadata)).toMatchObject({ reason: 'Registro de prueba', snapshot: { lastName: 'Soto' } });

        expect((await owner.post(`/registrations/${regs.eli.id}/restore`)).status).toBe(200);
        expect((await owner.get(`/events/${eventId}/registrations`)).body.data.total).toBe(5);
    });
});

describe('check-in', () => {
    it('al escanear se ve quién es, qué pidió y cuánto debe', async () => {
        const res = await staff.get(`/events/${eventId}/checkin/${regs.ana.code}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ firstName: 'Ana', pendingCents: 600, checkIn: null });
    });

    it('check-in por QR; el segundo escaneo avisa que ya entró sin duplicar', async () => {
        const first = await staff.post(`/events/${eventId}/checkin`, { publicCode: regs.ana.code.toLowerCase() });
        expect(first.body.data.result).toBe('checked_in');
        expect(first.body.data.registration.checkIn).toMatchObject({ method: 'qr' });
        const again = await staff.post(`/events/${eventId}/checkin`, { publicCode: regs.ana.code });
        expect(again.body.data.result).toBe('already_checked_in');
        const logs = await db.selectFrom('audit_logs').select('id').where('action', '=', 'registration.checked_in')
            .where('entity_id', '=', String(regs.ana.id)).execute();
        expect(logs).toHaveLength(1);
    });

    it('dos personas escaneando el mismo QR a la vez: un solo check-in', async () => {
        const results = await Promise.all(Array.from({ length: 5 }, () => staff.post(`/events/${eventId}/checkin`, { publicCode: regs.cata.code })));
        expect(results.filter(r => r.body.data.result === 'checked_in')).toHaveLength(1);
        const logs = await db.selectFrom('audit_logs').select('id').where('action', '=', 'registration.checked_in')
            .where('entity_id', '=', String(regs.cata.id)).execute();
        expect(logs).toHaveLength(1);
    });

    it('un QR de otro evento o fuera del alcance no se encuentra', async () => {
        expect((await staff.post(`/events/${eventId}/checkin`, { publicCode: regs.otro.code })).status).toBe(404);
        expect((await azStaff.post(`/events/${eventId}/checkin`, { publicCode: regs.dani.code })).status).toBe(404);
        expect((await finance.post(`/events/${eventId}/checkin`, { publicCode: regs.dani.code })).status).toBe(403);
    });

    it('manual desde la lista y deshacer', async () => {
        expect((await staff.post(`/registrations/${regs.beto.id}/checkin`)).body.data.registration.checkIn.method).toBe('manual');
        const undo = await staff.delete(`/registrations/${regs.beto.id}/checkin`);
        expect(undo.body.data.checkIn).toBeNull();
        expect((await staff.delete(`/registrations/${regs.beto.id}/checkin`)).status).toBe(409);
    });
});

describe('entregas', () => {
    it('no se entrega lo que no está pagado; pagado sí, y se puede deshacer', async () => {
        const items = (await owner.get(`/registrations/${regs.dani.id}`)).body.data.items;
        const tshirt = items.find((i: any) => i.code === 'tshirt');
        const blocked = await staff.post(`/registrations/${regs.dani.id}/items/${tshirt.id}/delivery`);
        expect(blocked.status).toBe(409);
        expect(blocked.body.details.reason).toBe('unpaid');

        await db.updateTable('registration_items').set({ payment_status: 'paid' }).where('id', '=', tshirt.id).execute();
        const ok = await staff.post(`/registrations/${regs.dani.id}/items/${tshirt.id}/delivery`);
        expect(ok.body.data.items.find((i: any) => i.code === 'tshirt').deliveredAt).not.toBeNull();
        const undo = await staff.delete(`/registrations/${regs.dani.id}/items/${tshirt.id}/delivery`);
        expect(undo.body.data.items.find((i: any) => i.code === 'tshirt').deliveredAt).toBeNull();
    });
});

describe('reportes, exportación y actividad', () => {
    it('reporte del evento: totales, asociaciones, productos y respuestas', async () => {
        const res = await owner.get(`/events/${eventId}/report`);
        expect(res.status).toBe(200);
        const r = res.body.data;
        expect(r.totals).toMatchObject({ registrations: 5 });
        expect(r.totals.checkedIn).toBeGreaterThanOrEqual(2);
        expect(r.byConference.find((c: any) => c.id === s.orgs.az).registrations).toBe(3);
        const tshirt = r.items.find((i: any) => i.code === 'tshirt');
        expect(Object.fromEntries(tshirt.variants.map((v: any) => [v.variant, v.total]))).toEqual({ M: 2, L: 1 });
        const diet = r.answers.find((a: any) => a.key === 'diet');
        expect(Object.fromEntries(diet.counts.map((c: any) => [c.value, c.count]))).toMatchObject({ vegan: 1, vegetarian: 1, regular: 1 });
        expect(r.daily.reduce((n: number, d: any) => n + d.count, 0)).toBe(5);

        const az = (await viewerAz.get(`/events/${eventId}/report`)).body.data;
        expect(az.totals.registrations).toBe(3);
    });

    it('CSV: encabezados, una fila por registro, protegido contra fórmulas y auditado', async () => {
        const res = await owner.get(`/events/${eventId}/registrations/export`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/csv/);
        const text: string = res.text;
        expect(text.charCodeAt(0)).toBe(0xfeff);
        const lines = text.trim().split('\r\n');
        expect(lines).toHaveLength(6);
        expect(lines[0]).toContain('Preferencia alimenticia');
        expect(text).toContain(`"'=HYPERLINK(""http://x"")"`);
        const audit = await db.selectFrom('audit_logs').select('metadata').where('action', '=', 'registrations.exported')
            .where('event_id', '=', eventId).orderBy('id', 'desc').executeTakeFirstOrThrow();
        expect(fromJson<any>(audit.metadata).rows).toBe(5);

        const azCsv = await viewerAz.get(`/events/${eventId}/registrations/export`);
        expect(azCsv.text.trim().split('\r\n')).toHaveLength(4);
    });

    it('actividad reciente con cursor', async () => {
        const first = await owner.get(`/events/${eventId}/activity`);
        expect(first.body.data.items.length).toBeGreaterThan(0);
        const cursor = first.body.data.cursor;
        expect((await owner.get(`/events/${eventId}/activity?after=${cursor}`)).body.data.items).toEqual([]);
        await registerAs('nuevo', formId, person({ first_name: 'Nuevo', last_name: `Persona ${uniq()}` }));
        const next = await owner.get(`/events/${eventId}/activity?after=${cursor}`);
        expect(next.body.data.items.map((i: any) => [i.action, i.registration.firstName])).toEqual([['registration.created', 'Nuevo']]);
    });
});

describe('auditoría', () => {
    it('el owner consulta el log filtrado; staff y owners limitados no', async () => {
        const res = await owner.get(`/audit?eventId=${eventId}&action=registration.checked_in`);
        expect(res.status).toBe(200);
        expect(res.body.data.items.every((e: any) => e.action === 'registration.checked_in')).toBe(true);
        expect(res.body.data.items[0].ip).toMatch(/^[\d.:a-f]+$/);
        expect((await staff.get('/audit')).status).toBe(403);
        const azOwner = await clientFor('owner', s.orgs.az);
        expect((await azOwner.get('/audit')).status).toBe(403);
    });

    it('historial de un registro en orden', async () => {
        const res = await owner.get(`/registrations/${regs.cata.id}/history`);
        const actions = res.body.data.map((e: any) => e.action);
        expect(actions[0]).toBe('registration.created');
        expect(actions).toEqual(expect.arrayContaining(['registration.updated', 'registration.checked_in']));
        expect((await staff.get(`/registrations/${regs.cata.id}/history`)).status).toBe(403);
    });
});
