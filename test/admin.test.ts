import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { db, destroyDb } from '../src/db/client';
import { fromJson } from '../src/db/json';
import { addMembership, buildScenario, createUser } from './fixtures';
import { as, lastMailTo, loginAs } from './http';
import { uniq } from './helpers';

const app = createApp();
let s: Awaited<ReturnType<typeof buildScenario>>;
let owner: ReturnType<typeof as>;
let finance: ReturnType<typeof as>;
let viewerAz: ReturnType<typeof as>;
let azOwner: ReturnType<typeof as>;

beforeAll(async () => {
    s = await buildScenario();
    const t = s.tenantA.slug;
    owner = as(app, (await loginAs(app, s.users.owner.email, t)).token, t);
    finance = as(app, (await loginAs(app, s.users.finance.email, t)).token, t);
    viewerAz = as(app, (await loginAs(app, s.users.viewerAz.email, t)).token, t);
    const u = await createUser();
    await addMembership(s.tenantA.id, u.id, 'owner', s.orgs.az);
    azOwner = as(app, (await loginAs(app, u.email, t)).token, t);
});
afterAll(async () => {
    await destroyDb();
});

const lastAudit = (action: string, entityId: number | string) => db.selectFrom('audit_logs').selectAll()
    .where('action', '=', action).where('entity_id', '=', String(entityId)).orderBy('id', 'desc').executeTakeFirst();

describe('organizaciones e iglesias', () => {
    it('árbol: el owner ve todo; el lector de AZ solo su rama', async () => {
        const full = await owner.get('/organizations/tree');
        expect(full.status).toBe(200);
        expect(full.body.data.id).toBe(s.orgs.unionA);
        expect(full.body.data.children.map((c: any) => c.id).sort()).toEqual([s.orgs.az, s.orgs.ca].sort());

        const az = await viewerAz.get('/organizations/tree');
        expect(az.body.data.children.map((c: any) => c.id)).toEqual([s.orgs.az]);
    });

    it('crear iglesia: sin duplicados (ni por acentos/mayúsculas) y solo bajo una asociación', async () => {
        const name = `Paraíso ${uniq()}`;
        const res = await owner.post('/organizations/churches', { conferenceId: s.orgs.az, name, city: 'Phoenix', stateCode: 'az' });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ name, status: 'verified', city: 'Phoenix', state: 'AZ' });

        const dup = await owner.post('/organizations/churches', {
            conferenceId: s.orgs.az, name: name.replace('Paraíso', 'paraiso'),
        });
        expect(dup.status).toBe(409);
        expect((await owner.post('/organizations/churches', { conferenceId: s.orgs.unionA, name: 'X' })).status).toBe(400);
        expect((await finance.post('/organizations/churches', { conferenceId: s.orgs.az, name: 'X' })).status).toBe(403);
    });

    it('aprobar una iglesia pendiente queda auditado como church.approved', async () => {
        const res = await db.insertInto('organizations').values({
            parent_id: s.orgs.ca, type: 'church', name: `Pendiente ${uniq()}`, short_name: null, city: null,
            state_id: null, merged_into_id: null, status: 'pending', source: 'registration',
        }).executeTakeFirstOrThrow();
        const id = Number(res.insertId);

        const pending = await owner.get(`/organizations/churches?status=pending&conferenceId=${s.orgs.ca}`);
        expect(pending.body.data.map((c: any) => c.id)).toContain(id);

        expect((await owner.patch(`/organizations/churches/${id}`, { status: 'verified' })).status).toBe(200);
        const log = await lastAudit('church.approved', id);
        expect(fromJson(log!.changes)).toEqual({ status: { from: 'pending', to: 'verified' } });
    });

    it('fusionar: los registros pasan a la correcta y la duplicada queda como merged', async () => {
        const mk = async (name: string) => (await owner.post('/organizations/churches', { conferenceId: s.orgs.az, name })).body.data.id;
        const typo = await mk(`Shalon ${uniq()}`);
        const good = await mk(`Shalom ${uniq()}`);
        const regs = await db.selectFrom('registrations').select('id').where('event_id', '=', s.events.union).limit(2).execute();
        await db.updateTable('registrations').set({ church_organization_id: typo }).where('id', 'in', regs.map(r => r.id)).execute();

        const res = await owner.post(`/organizations/churches/${typo}/merge`, { intoId: good });
        expect(res.status).toBe(200);
        expect(res.body.data.registrationsMoved).toBe(2);

        const moved = await db.selectFrom('registrations').select('id').where('church_organization_id', '=', good).execute();
        expect(moved).toHaveLength(2);
        const typoRow = await db.selectFrom('organizations').select(['status', 'merged_into_id']).where('id', '=', typo).executeTakeFirstOrThrow();
        expect(typoRow).toEqual({ status: 'merged', merged_into_id: good });

        expect((await owner.post(`/organizations/churches/${typo}/merge`, { intoId: good })).status).toBe(409);
        expect((await owner.post(`/organizations/churches/${good}/merge`, { intoId: good })).status).toBe(400);
    });

    it('un owner de AZ no toca iglesias de CA', async () => {
        expect((await azOwner.post('/organizations/churches', { conferenceId: s.orgs.ca, name: `X ${uniq()}` })).status).toBe(404);
        expect((await azOwner.post('/organizations/churches', { conferenceId: s.orgs.az, name: `Y ${uniq()}` })).status).toBe(201);
    });
});

const eventBody = (overrides: object = {}) => ({
    slug: `evento-${uniq()}`,
    name: { es: 'Retiro de jóvenes', en: 'Youth retreat' },
    startsAt: '2027-05-01T09:00:00-07:00',
    endsAt: '2027-05-03T18:00:00-07:00',
    timezone: 'America/Phoenix',
    ...overrides,
});

describe('eventos', () => {
    it('crear: queda en borrador, organizado por la raíz y auditado', async () => {
        const res = await owner.post('/events', eventBody({ venue: 'Prescott' }));
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ status: 'draft', venue: 'Prescott', organizer: { id: s.orgs.unionA } });
        expect(res.body.data.startsAt).toBe('2027-05-01T16:00:00.000Z');
        expect(await lastAudit('event.created', res.body.data.id)).toBeDefined();
    });

    it('validaciones: slug repetido, fechas al revés, zona horaria inválida', async () => {
        const body = eventBody();
        await owner.post('/events', body);
        expect((await owner.post('/events', { ...body })).status).toBe(409);
        expect((await owner.post('/events', eventBody({ endsAt: '2027-04-01T00:00:00Z' }))).status).toBe(400);
        expect((await owner.post('/events', eventBody({ timezone: 'Marte/Olympus' }))).status).toBe(400);
        expect((await owner.post('/events', eventBody({ slug: 'Con Espacios' }))).status).toBe(400);
    });

    it('editar solo audita lo que cambió', async () => {
        const created = await owner.post('/events', eventBody());
        const id = created.body.data.id;
        const res = await owner.patch(`/events/${id}`, { venue: 'Flagstaff', name: { es: 'Retiro de jóvenes', en: 'Youth retreat' } });
        expect(res.status).toBe(200);
        const log = await lastAudit('event.updated', id);
        expect(Object.keys(fromJson<object>(log!.changes))).toEqual(['venue']);
    });

    it('estados: borrador → publicado → cerrado; no se regresa a borrador', async () => {
        const id = (await owner.post('/events', eventBody())).body.data.id;
        expect((await owner.post(`/events/${id}/status`, { status: 'published' })).body.data.status).toBe('published');
        expect((await owner.post(`/events/${id}/status`, { status: 'draft' })).status).toBe(409);
        expect((await owner.post(`/events/${id}/status`, { status: 'closed' })).body.data.status).toBe('closed');
    });

    it('borrar: solo sin registros; con registros hay que archivar', async () => {
        expect((await owner.delete(`/events/${s.events.union}`)).status).toBe(409);
        const id = (await owner.post('/events', eventBody())).body.data.id;
        expect((await owner.delete(`/events/${id}`)).status).toBe(200);
        expect((await owner.get(`/events/${id}`)).status).toBe(404);
    });

    it('permisos y alcance: lector no crea; owner de AZ crea para AZ y no toca los de la Unión', async () => {
        expect((await viewerAz.post('/events', eventBody())).status).toBe(403);

        const az = await azOwner.post('/events', eventBody());
        expect(az.status).toBe(201);
        expect(az.body.data.organizer.id).toBe(s.orgs.az);
        expect((await azOwner.post('/events', eventBody({ organizerOrganizationId: s.orgs.ca }))).status).toBe(404);
        expect((await azOwner.patch(`/events/${s.events.union}`, { venue: 'x' })).status).toBe(403);
    });
});

describe('marca del cliente', () => {
    it('la marca pública se puede leer sin sesión', async () => {
        const res = await request(app).get('/api/v2/tenant/public').set('X-Tenant', s.tenantA.slug);
        expect(res.status).toBe(200);
        expect(res.body.data.slug).toBe(s.tenantA.slug);
    });

    it('el owner cambia colores y logo; queda auditado; finanzas no puede', async () => {
        const res = await owner.patch('/tenant/settings', { primaryColor: '#1D4ED8', logoUrl: 'https://cdn.example.com/logo.png' });
        expect(res.status).toBe(200);
        expect(res.body.data.primaryColor).toBe('#1D4ED8');
        expect((await owner.patch('/tenant/settings', { primaryColor: 'azul' })).status).toBe(400);
        expect((await owner.patch('/tenant/settings', { logoUrl: 'http://inseguro.com/l.png' })).status).toBe(400);
        expect((await finance.patch('/tenant/settings', { primaryColor: '#000000' })).status).toBe(403);
        expect(await lastAudit('tenant.settings_updated', s.tenantA.id)).toBeDefined();
    });
});

describe('panel de plataforma', () => {
    it('solo el admin de plataforma entra', async () => {
        expect((await owner.get('/platform/tenants')).status).toBe(403);
    });

    it('dar de alta una unión y un cliente nuevo con su owner invitado', async () => {
        const pa = as(app, (await loginAs(app, s.users.platformAdmin.email)).token);

        const union = await pa.post('/platform/organizations', { type: 'union', name: `Atlantic Union ${uniq()}`, shortName: 'AUC' });
        expect(union.status).toBe(201);
        const conf = await pa.post('/platform/organizations', {
            type: 'conference', name: `Greater NY ${uniq()}`, parentId: union.body.data.id, stateCodes: ['NY'],
        });
        expect(conf.status).toBe(201);

        const slug = `atlantic-${uniq()}`;
        const ownerEmail = `owner-${uniq()}@example.test`;
        const tenant = await pa.post('/platform/tenants', {
            name: 'Atlantic Union', slug, rootOrganizationId: union.body.data.id,
            timezone: 'America/New_York', owner: { email: ownerEmail, name: 'Owner Atlantic' },
        });
        expect(tenant.status).toBe(201);
        expect(tenant.body.data).toMatchObject({ slug, members: 1 });
        expect(lastMailTo(ownerEmail)!.text).toContain(`${slug}.localhost:4200/invitacion?token=`);

        expect((await pa.post('/platform/tenants', {
            name: 'Otra', slug, rootOrganizationId: conf.body.data.id, owner: { email: `x-${uniq()}@example.test`, name: 'x' },
        })).status).toBe(409);
        expect((await pa.post('/platform/tenants', {
            name: 'Otra', slug: `otra-${uniq()}`, rootOrganizationId: union.body.data.id, owner: { email: `y-${uniq()}@example.test`, name: 'y' },
        })).status).toBe(409);
    });

    it('suspender un cliente lo deja fuera de servicio', async () => {
        const pa = as(app, (await loginAs(app, s.users.platformAdmin.email)).token);
        expect((await pa.patch(`/platform/tenants/${s.tenantB.id}/status`, { status: 'suspended' })).status).toBe(200);
        const res = await request(app).post('/api/v2/auth/login').set('X-Tenant', s.tenantB.slug)
            .send({ email: s.users.ownerB.email, password: 'x' });
        expect(res.status).toBe(404);
        await pa.patch(`/platform/tenants/${s.tenantB.id}/status`, { status: 'active' });
    });
});
