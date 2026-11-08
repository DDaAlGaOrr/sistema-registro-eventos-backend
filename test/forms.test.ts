import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { db, destroyDb } from '../src/db/client';
import { fromJson } from '../src/db/json';
import { FEJA_FORM_SCHEMA, TSHIRT_VARIANTS } from '../src/db/import-v1/feja-form';
import { addMembership, buildScenario, createUser } from './fixtures';
import { as, loginAs } from './http';
import { uniq } from './helpers';

const app = createApp();
let s: Awaited<ReturnType<typeof buildScenario>>;
let owner: ReturnType<typeof as>;
let finance: ReturnType<typeof as>;
let viewerAz: ReturnType<typeof as>;
let azOwner: ReturnType<typeof as>;

const t = (es: string, en = es) => ({ es, en });

beforeAll(async () => {
    s = await buildScenario();
    const tenant = s.tenantA.slug;
    owner = as(app, (await loginAs(app, s.users.owner.email, tenant)).token, tenant);
    finance = as(app, (await loginAs(app, s.users.finance.email, tenant)).token, tenant);
    viewerAz = as(app, (await loginAs(app, s.users.viewerAz.email, tenant)).token, tenant);
    const u = await createUser();
    await addMembership(s.tenantA.id, u.id, 'owner', s.orgs.az);
    azOwner = as(app, (await loginAs(app, u.email, tenant)).token, tenant);
});
afterAll(async () => {
    await destroyDb();
});

/** Evento nuevo con un formulario nuevo y los productos de FEJA (playera con tallas y comida). */
async function setupFejaLikeForm() {
    const event = await owner.post('/events', {
        slug: `feja-${uniq()}`, name: t('Congreso FEJA', 'FEJA Congress'),
        startsAt: '2027-10-15T17:00:00-07:00', endsAt: '2027-10-17T18:00:00-07:00', timezone: 'America/Phoenix',
    });
    const eventId = event.body.data.id;
    const form = await owner.post(`/events/${eventId}/forms`, { title: t('Registro', 'Registration') });
    const formId = form.body.data.id;
    await owner.post(`/forms/${formId}/items`, {
        code: 'tshirt', kind: 'product', name: t('Playera', 'T-shirt'), priceCents: 400,
        variants: TSHIRT_VARIANTS.map(v => ({ code: v.code, label: v.label })),
    });
    await owner.post(`/forms/${formId}/items`, { code: 'lunch', kind: 'product', name: t('Comida', 'Lunch'), priceCents: 200 });
    return { eventId, formId };
}

describe('formularios: crear y productos', () => {
    it('crear un formulario deja un borrador vacío (versión 1)', async () => {
        const { formId } = await setupFejaLikeForm();
        const res = await owner.get(`/forms/${formId}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ status: 'draft', publishedVersion: null, draftVersion: { version: 1, schema: { steps: [] } } });
        expect(res.body.data.items.map((i: any) => i.code)).toEqual(['tshirt', 'lunch']);
        expect(res.body.data.items[0].variants.map((v: any) => v.code)).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    });

    it('permisos: finanzas no crea formularios; el lector sí puede verlos', async () => {
        const { eventId, formId } = await setupFejaLikeForm();
        expect((await finance.post(`/events/${eventId}/forms`, { title: t('X') })).status).toBe(403);
        expect((await owner.get(`/forms/${formId}`)).status).toBe(200);
    });

    it('códigos de producto únicos y una sola cuota de inscripción', async () => {
        const { formId } = await setupFejaLikeForm();
        expect((await owner.post(`/forms/${formId}/items`, { code: 'lunch', kind: 'product', name: t('Otra'), priceCents: 1 })).status).toBe(409);
        const fee = await owner.post(`/forms/${formId}/items`, { code: 'cuota', kind: 'registration_fee', name: t('Inscripción'), priceCents: 2500, isRequired: false });
        expect(fee.status).toBe(201);
        expect(fee.body.data.isRequired).toBe(true);
        expect((await owner.post(`/forms/${formId}/items`, { code: 'cuota2', kind: 'registration_fee', name: t('Otra'), priceCents: 1 })).status).toBe(409);
    });

    it('cambiar el precio queda auditado; las tallas que se quitan se desactivan (no se borran)', async () => {
        const { formId } = await setupFejaLikeForm();
        const items = (await owner.get(`/forms/${formId}`)).body.data.items;
        const tshirt = items.find((i: any) => i.code === 'tshirt');

        expect((await owner.patch(`/forms/${formId}/items/${tshirt.id}`, { priceCents: 500 })).body.data.priceCents).toBe(500);
        const log = await db.selectFrom('audit_logs').select('changes').where('action', '=', 'form.item_updated')
            .where('entity_id', '=', String(tshirt.id)).executeTakeFirstOrThrow();
        expect(fromJson(log.changes)).toEqual({ priceCents: { from: 400, to: 500 } });

        const res = await owner.put(`/forms/${formId}/items/${tshirt.id}/variants`, {
            variants: [...TSHIRT_VARIANTS.filter(v => v.code !== 'XS'), { code: 'XXL', label: t('XXL'), priceCentsOverride: 600 }],
        });
        const byCode = Object.fromEntries(res.body.data.variants.map((v: any) => [v.code, v]));
        expect(byCode.XS.isActive).toBe(false);
        expect(byCode.XXL).toMatchObject({ isActive: true, priceCentsOverride: 600 });
    });
});

describe('borrador y publicación', () => {
    it('un borrador con estructura inválida se rechaza con la lista de problemas', async () => {
        const { formId } = await setupFejaLikeForm();
        const res = await owner.put(`/forms/${formId}/draft`, { schema: { steps: [{ key: 'X mal', title: t('a'), fields: [] }] } });
        expect(res.status).toBe(400);
        expect(res.body.details.issues[0].path).toBe('steps.0.key');
    });

    it('un borrador incompleto se guarda, avisa qué falta y no se puede publicar', async () => {
        const { formId } = await setupFejaLikeForm();
        const res = await owner.put(`/forms/${formId}/draft`, {
            schema: { steps: [{ key: 'datos', title: t('Datos'), fields: [{ key: 'nombre', type: 'text', maps_to: 'first_name', required: true, label: t('Nombre') }] }] },
        });
        expect(res.status).toBe(200);
        expect(res.body.data.publishIssues.length).toBeGreaterThan(0);
        expect((await owner.post(`/forms/${formId}/publish`)).status).toBe(400);
    });

    it('publicar el formulario de FEJA, abrirlo y publicar una segunda versión', async () => {
        const { eventId, formId } = await setupFejaLikeForm();

        const draft = await owner.put(`/forms/${formId}/draft`, { schema: FEJA_FORM_SCHEMA });
        expect(draft.status).toBe(200);
        expect(draft.body.data.publishIssues).toEqual([]);

        const v1 = await owner.post(`/forms/${formId}/publish`);
        expect(v1.status).toBe(200);
        expect(v1.body.data).toMatchObject({ publishedVersion: { version: 1 }, draftVersion: null });
        expect((await owner.post(`/forms/${formId}/publish`)).status).toBe(409); // no hay cambios

        // No se abre si el evento sigue en borrador
        expect((await owner.post(`/forms/${formId}/status`, { status: 'open' })).status).toBe(409);
        await owner.post(`/events/${eventId}/status`, { status: 'published' });
        expect((await owner.post(`/forms/${formId}/status`, { status: 'open' })).body.data.status).toBe('open');

        // Versión 2: se agrega un campo
        const schema2 = structuredClone(FEJA_FORM_SCHEMA) as any;
        schema2.steps[1].fields.push({ key: 'alergias', type: 'textarea', label: t('Alergias', 'Allergies') });
        expect((await owner.put(`/forms/${formId}/draft`, { schema: schema2 })).body.data.version).toBe(2);
        const v2 = await owner.post(`/forms/${formId}/publish`);
        expect(v2.body.data.publishedVersion.version).toBe(2);

        const versions = (await owner.get(`/forms/${formId}/versions`)).body.data;
        expect(versions.map((v: any) => [v.version, v.status])).toEqual([[2, 'published'], [1, 'superseded']]);

        const log = await db.selectFrom('audit_logs').select(['changes', 'metadata'])
            .where('action', '=', 'form.version_published').where('entity_id', '=', String(formId))
            .orderBy('id', 'desc').executeTakeFirstOrThrow();
        expect(fromJson(log.changes)).toEqual({ published_version: { from: 1, to: 2 } });
        expect(fromJson<any>(log.metadata).fields).toMatchObject({ added: ['alergias'], removed: [], changed: [] });
    });

    it('vista previa: valida respuestas contra la versión publicada', async () => {
        const { formId } = await setupFejaLikeForm();
        await owner.put(`/forms/${formId}/draft`, { schema: FEJA_FORM_SCHEMA });
        await owner.post(`/forms/${formId}/publish`);
        const res = await owner.post(`/forms/${formId}/preview-answers`, {
            version: 'published', answers: { first_name: 'Ana', wants_tshirt: true, tshirt_size: 'XXXL' },
        });
        expect(res.status).toBe(200);
        expect(res.body.data.ok).toBe(false);
        const codes = Object.fromEntries(res.body.data.errors.map((e: any) => [e.field, e.code]));
        expect(codes).toMatchObject({ last_name: 'required', email: 'required', tshirt_size: 'invalid_option' });
    });
});

describe('configuración de pagos y fechas', () => {
    it('con pagos activos hay que permitir al menos un método; en línea requiere Stripe conectado', async () => {
        const { formId } = await setupFejaLikeForm();
        expect((await owner.patch(`/forms/${formId}`, { paymentsEnabled: true, allowOfflinePayment: false })).status).toBe(400);
        expect((await owner.patch(`/forms/${formId}`, { paymentsEnabled: true, allowOnlinePayment: true })).status).toBe(409);
        const ok = await owner.patch(`/forms/${formId}`, { paymentsEnabled: true });
        expect(ok.body.data.payments).toEqual({ enabled: true, online: false, offline: true, currency: 'usd' });
    });

    it('el cierre del registro debe ser después de la apertura', async () => {
        const { formId } = await setupFejaLikeForm();
        const res = await owner.patch(`/forms/${formId}`, { opensAt: '2027-09-01T00:00:00Z', closesAt: '2027-08-01T00:00:00Z' });
        expect(res.status).toBe(400);
        const ok = await owner.patch(`/forms/${formId}`, { opensAt: '2027-08-01T00:00:00Z', closesAt: '2027-10-10T00:00:00-07:00' });
        expect(ok.body.data.closesAt).toBe('2027-10-10T07:00:00.000Z');
    });
});

describe('alcance y aislamiento', () => {
    it('un owner de AZ no modifica formularios de eventos de la Unión', async () => {
        const { formId } = await setupFejaLikeForm();
        expect((await azOwner.patch(`/forms/${formId}`, { title: t('X') })).status).toBe(403);
        expect((await azOwner.put(`/forms/${formId}/draft`, { schema: FEJA_FORM_SCHEMA })).status).toBe(403);
    });

    it('un formulario de otro cliente no existe (404)', async () => {
        const otherForm = await db.selectFrom('forms').select('id').where('tenant_id', '=', s.tenantB.id).executeTakeFirstOrThrow();
        expect((await owner.get(`/forms/${otherForm.id}`)).status).toBe(404);
        expect((await owner.patch(`/forms/${otherForm.id}`, { title: t('X') })).status).toBe(404);
    });

    it('el lector de AZ no ve formularios de eventos de CA', async () => {
        const caForm = await db.selectFrom('forms').select('id').where('event_id', '=', s.events.ca).executeTakeFirstOrThrow();
        expect((await viewerAz.get(`/forms/${caForm.id}`)).status).toBe(404);
    });
});
