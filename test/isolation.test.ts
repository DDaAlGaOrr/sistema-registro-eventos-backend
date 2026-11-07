import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { destroyDb } from '../src/db/client';
import { buildScenario, PASSWORD } from './fixtures';

const app = createApp();
let s: Awaited<ReturnType<typeof buildScenario>>;
const tokens: Record<string, string> = {};

beforeAll(async () => {
    s = await buildScenario();
    for (const [name, user] of Object.entries(s.users)) {
        if (name === 'inactive' || name === 'ownerB') continue;
        const res = await request(app).post('/api/v2/auth/login')
            .set('X-Tenant', s.tenantA.slug).send({ email: user.email, password: PASSWORD });
        tokens[name] = res.body.data.accessToken;
    }
});
afterAll(async () => {
    await destroyDb();
});

const get = (who: string, path: string, tenant = s.tenantA.slug) =>
    request(app).get(`/api/v2${path}`).set('X-Tenant', tenant).set('Authorization', `Bearer ${tokens[who]}`);

const eventIds = (res: request.Response) => res.body.data.map((e: { id: number }) => e.id).sort();

describe('aislamiento entre clientes', () => {
    it('el owner del cliente A solo ve los eventos de A', async () => {
        const res = await get('owner', '/events');
        expect(res.status).toBe(200);
        expect(eventIds(res)).toEqual([s.events.union, s.events.ca, s.events.az].sort());
    });

    it('pedir registros de un evento del cliente B da 404 (no se delata que existe)', async () => {
        const res = await get('owner', `/events/${s.events.b}/registrations`);
        expect(res.status).toBe(404);
    });

    it('el admin de plataforma entra a cualquier cliente aunque no tenga membresía', async () => {
        const login = await request(app).post('/api/v2/auth/login')
            .set('X-Tenant', s.tenantB.slug).send({ email: s.users.platformAdmin.email, password: PASSWORD });
        expect(login.status).toBe(200);
        const res = await request(app).get('/api/v2/events')
            .set('X-Tenant', s.tenantB.slug).set('Authorization', `Bearer ${login.body.data.accessToken}`);
        expect(eventIds(res)).toEqual([s.events.b]);
    });
});

describe('alcance por asociación (viewer de AZ)', () => {
    it('ve el evento de la Unión y el de AZ, no el de CA', async () => {
        const res = await get('viewerAz', '/events');
        expect(eventIds(res)).toEqual([s.events.union, s.events.az].sort());
    });

    it('en el evento de la Unión solo ve los registrados de AZ', async () => {
        const res = await get('viewerAz', `/events/${s.events.union}/registrations`);
        expect(res.status).toBe(200);
        expect(res.body.data.total).toBe(3);
        expect(new Set(res.body.data.items.map((r: any) => r.conference.id))).toEqual(new Set([s.orgs.az]));
    });

    it('el evento de CA no existe para él (404)', async () => {
        expect((await get('viewerAz', `/events/${s.events.ca}/registrations`)).status).toBe(404);
    });

    it('en el evento que organiza AZ ve a todos, aunque vengan de otra asociación', async () => {
        const res = await get('viewerAz', `/events/${s.events.az}/registrations`);
        expect(res.body.data.total).toBe(2);
    });

    it('el owner sin alcance ve todos los registrados del evento de la Unión', async () => {
        const res = await get('owner', `/events/${s.events.union}/registrations`);
        expect(res.body.data.total).toBe(5);
    });
});

describe('paginación', () => {
    it('respeta page y pageSize', async () => {
        const p1 = await get('owner', `/events/${s.events.union}/registrations?page=1&pageSize=2`);
        const p3 = await get('owner', `/events/${s.events.union}/registrations?page=3&pageSize=2`);
        expect(p1.body.data).toMatchObject({ page: 1, pageSize: 2, total: 5 });
        expect(p1.body.data.items).toHaveLength(2);
        expect(p3.body.data.items).toHaveLength(1);
    });

    it('rechaza pageSize fuera de rango', async () => {
        expect((await get('owner', `/events/${s.events.union}/registrations?pageSize=1000`)).status).toBe(400);
    });
});

describe('sin sesión', () => {
    it('sin token → 401', async () => {
        const res = await request(app).get('/api/v2/events').set('X-Tenant', s.tenantA.slug);
        expect(res.status).toBe(401);
    });

    it('sin cliente → 400', async () => {
        const res = await request(app).get('/api/v2/events').set('Authorization', `Bearer ${tokens.owner}`);
        expect(res.status).toBe(400);
    });
});
