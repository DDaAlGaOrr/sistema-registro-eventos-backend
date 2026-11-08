import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { db, destroyDb } from '../src/db/client';
import { fromJson } from '../src/db/json';
import { addMembership, buildScenario, createUser, PASSWORD } from './fixtures';
import { as, lastMailTo, loginAs, tokenFromMail } from './http';
import { uniq } from './helpers';

const app = createApp();
let s: Awaited<ReturnType<typeof buildScenario>>;
let owner: ReturnType<typeof as>;
const NEW_PASSWORD = 'NuevaClave2027';

beforeAll(async () => {
    s = await buildScenario();
    owner = as(app, (await loginAs(app, s.users.owner.email, s.tenantA.slug)).token, s.tenantA.slug);
});
afterAll(async () => {
    await destroyDb();
});

const newEmail = () => `nuevo-${uniq()}@example.test`;

describe('usuarios del cliente', () => {
    it('el owner ve a los miembros; finanzas no puede', async () => {
        const res = await owner.get('/users');
        expect(res.status).toBe(200);
        const emails = res.body.data.map((m: any) => m.email);
        expect(emails).toEqual(expect.arrayContaining([s.users.owner.email, s.users.viewerAz.email, s.users.finance.email]));

        const fin = as(app, (await loginAs(app, s.users.finance.email, s.tenantA.slug)).token, s.tenantA.slug);
        expect((await fin.get('/users')).status).toBe(403);
    });

    it('invitar a alguien nuevo: correo con enlace, no puede entrar hasta crear su contraseña', async () => {
        const email = newEmail();
        const res = await owner.post('/users/invite', { email, name: 'Nueva Staff', role: 'staff' });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ email, role: 'staff', invitationPending: true, isActive: true });

        const mail = lastMailTo(email)!;
        expect(mail.subject).toMatch(/Invitación/);
        expect(mail.text).toContain(`${s.tenantA.slug}.localhost:4200/invitacion?token=`);

        const before = await request(app).post('/api/v2/auth/login').set('X-Tenant', s.tenantA.slug)
            .send({ email, password: PASSWORD });
        expect(before.status).toBe(401);
    });

    it('aceptar la invitación crea la contraseña e inicia sesión; el enlace no sirve dos veces', async () => {
        const email = newEmail();
        await owner.post('/users/invite', { email, name: 'Acepta', role: 'viewer' });
        const token = tokenFromMail(email)!;

        const weak = await request(app).post('/api/v2/auth/invitation/accept').set('X-Tenant', s.tenantA.slug)
            .send({ token, password: 'corta' });
        expect(weak.status).toBe(400);

        const ok = await request(app).post('/api/v2/auth/invitation/accept').set('X-Tenant', s.tenantA.slug)
            .send({ token, password: NEW_PASSWORD });
        expect(ok.status).toBe(200);
        expect(ok.body.data.accessToken).toBeTypeOf('string');
        expect(ok.body.data.role).toBe('viewer');

        await loginAs(app, email, s.tenantA.slug, NEW_PASSWORD);
        const again = await request(app).post('/api/v2/auth/invitation/accept').set('X-Tenant', s.tenantA.slug)
            .send({ token, password: NEW_PASSWORD });
        expect(again.status).toBe(400);
    });

    it('invitar a alguien que ya existe en otro cliente solo le da acceso (sin cambiar su contraseña)', async () => {
        const res = await owner.post('/users/invite', { email: s.users.ownerB.email, name: 'x', role: 'finance' });
        expect(res.status).toBe(201);
        expect(res.body.data.invitationPending).toBe(false);
        expect(lastMailTo(s.users.ownerB.email)!.subject).toMatch(/acceso/);
        await loginAs(app, s.users.ownerB.email, s.tenantA.slug);
    });

    it('invitar a quien ya tiene acceso → 409', async () => {
        expect((await owner.post('/users/invite', { email: s.users.finance.email, name: 'x', role: 'staff' })).status).toBe(409);
    });

    it('reenviar invitación: solo si no la ha aceptado', async () => {
        const email = newEmail();
        const invited = await owner.post('/users/invite', { email, name: 'Reenvío', role: 'staff' });
        const firstToken = tokenFromMail(email);
        expect((await owner.post(`/users/${invited.body.data.userId}/resend-invitation`)).status).toBe(200);
        const secondToken = tokenFromMail(email);
        expect(secondToken).not.toBe(firstToken);
        // El primer enlace ya no sirve
        const old = await request(app).post('/api/v2/auth/invitation/accept').set('X-Tenant', s.tenantA.slug)
            .send({ token: firstToken, password: NEW_PASSWORD });
        expect(old.status).toBe(400);
        expect((await owner.post(`/users/${s.users.finance.id}/resend-invitation`)).status).toBe(409);
    });

    it('cambiar rol/alcance queda en auditoría con antes y después', async () => {
        const res = await owner.patch(`/users/${s.users.viewerAz.id}`, { scopeOrganizationId: s.orgs.ca });
        expect(res.status).toBe(200);
        expect(res.body.data.scope.id).toBe(s.orgs.ca);
        const log = await db.selectFrom('audit_logs').select('changes')
            .where('action', '=', 'membership.updated').where('entity_id', '=', String(s.users.viewerAz.id))
            .orderBy('id', 'desc').executeTakeFirstOrThrow();
        expect(fromJson(log.changes)).toEqual({ scopeOrganizationId: { from: s.orgs.az, to: s.orgs.ca } });
        await owner.patch(`/users/${s.users.viewerAz.id}`, { scopeOrganizationId: s.orgs.az });
    });

    it('no puedes cambiarte a ti mismo ni dejar al cliente sin owner', async () => {
        expect((await owner.patch(`/users/${s.users.owner.id}`, { role: 'viewer' })).status).toBe(400);
        const pa = as(app, (await loginAs(app, s.users.platformAdmin.email, s.tenantA.slug)).token, s.tenantA.slug);
        const res = await pa.patch(`/users/${s.users.owner.id}`, { role: 'staff' });
        expect(res.status).toBe(409);
    });

    it('desactivar a alguien corta su sesión de inmediato', async () => {
        const u = await createUser();
        await addMembership(s.tenantA.id, u.id, 'staff');
        const session = await loginAs(app, u.email, s.tenantA.slug);
        expect((await owner.patch(`/users/${u.id}`, { isActive: false })).status).toBe(200);
        expect((await as(app, session.token, s.tenantA.slug).get('/auth/me')).status).toBe(403);
    });

    it('un owner limitado a AZ solo invita y ve gente de AZ', async () => {
        const u = await createUser();
        await addMembership(s.tenantA.id, u.id, 'owner', s.orgs.az);
        const azOwner = as(app, (await loginAs(app, u.email, s.tenantA.slug)).token, s.tenantA.slug);

        expect((await azOwner.post('/users/invite', { email: newEmail(), name: 'x', role: 'staff' })).status).toBe(403);
        const caEmail = newEmail();
        expect((await azOwner.post('/users/invite', { email: caEmail, name: 'x', role: 'staff', scopeOrganizationId: s.orgs.ca })).status).toBe(404);
        // Además del 404, no debe haberse creado nada ni mandado correo
        expect(await db.selectFrom('users').select('id').where('email', '=', caEmail).executeTakeFirst()).toBeUndefined();
        expect(lastMailTo(caEmail)).toBeUndefined();
        expect((await azOwner.post('/users/invite', { email: newEmail(), name: 'x', role: 'staff', scopeOrganizationId: s.orgs.az })).status).toBe(201);

        const list = await azOwner.get('/users');
        expect(list.body.data.every((m: any) => m.scope?.id === s.orgs.az)).toBe(true);
        // No puede tocar a alguien fuera de su alcance
        expect((await azOwner.patch(`/users/${s.users.finance.id}`, { role: 'viewer' })).status).toBe(404);
    });
});

describe('recuperar contraseña', () => {
    it('responde igual exista o no el correo, y solo manda correo a miembros del cliente', async () => {
        const unknown = await request(app).post('/api/v2/auth/password/forgot').set('X-Tenant', s.tenantA.slug)
            .send({ email: 'nadie-aqui@example.test' });
        const known = await request(app).post('/api/v2/auth/password/forgot').set('X-Tenant', s.tenantA.slug)
            .send({ email: s.users.finance.email });
        expect(unknown.status).toBe(200);
        expect(known.status).toBe(200);
        expect(unknown.body.data.message).toBe(known.body.data.message);
        expect(lastMailTo('nadie-aqui@example.test')).toBeUndefined();
        expect(lastMailTo(s.users.finance.email)!.text).toContain('/restablecer?token=');

        // Alguien de otro cliente no recibe correo con la marca de este cliente
        const outsider = await createUser();
        await request(app).post('/api/v2/auth/password/forgot').set('X-Tenant', s.tenantA.slug).send({ email: outsider.email });
        expect(lastMailTo(outsider.email)).toBeUndefined();
    });

    it('cambiar la contraseña cierra las sesiones abiertas y el enlace se usa una sola vez', async () => {
        const u = await createUser();
        await addMembership(s.tenantA.id, u.id, 'staff');
        const session = await loginAs(app, u.email, s.tenantA.slug);

        await request(app).post('/api/v2/auth/password/forgot').set('X-Tenant', s.tenantA.slug).send({ email: u.email });
        const token = tokenFromMail(u.email)!;
        const reset = await request(app).post('/api/v2/auth/password/reset').set('X-Tenant', s.tenantA.slug)
            .send({ token, password: NEW_PASSWORD });
        expect(reset.status).toBe(200);

        const refresh = await request(app).post('/api/v2/auth/refresh').set('X-Tenant', s.tenantA.slug).set('Cookie', session.cookie);
        expect(refresh.status).toBe(401);
        await loginAs(app, u.email, s.tenantA.slug, NEW_PASSWORD);

        const reuse = await request(app).post('/api/v2/auth/password/reset').set('X-Tenant', s.tenantA.slug)
            .send({ token, password: 'OtraClave2028' });
        expect(reuse.status).toBe(400);
    });

    it('un enlace vencido no sirve', async () => {
        await request(app).post('/api/v2/auth/password/forgot').set('X-Tenant', s.tenantA.slug).send({ email: s.users.owner.email });
        const token = tokenFromMail(s.users.owner.email)!;
        await db.updateTable('user_tokens').set({ expires_at: new Date(Date.now() - 1000) })
            .where('user_id', '=', s.users.owner.id).where('type', '=', 'password_reset').where('used_at', 'is', null).execute();
        const res = await request(app).post('/api/v2/auth/password/reset').set('X-Tenant', s.tenantA.slug)
            .send({ token, password: NEW_PASSWORD });
        expect(res.status).toBe(400);
    });
});
