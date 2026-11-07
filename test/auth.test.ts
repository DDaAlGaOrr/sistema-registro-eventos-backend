import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { db, destroyDb } from '../src/db/client';
import { fromJson } from '../src/db/json';
import { buildScenario, PASSWORD } from './fixtures';

const app = createApp();
let s: Awaited<ReturnType<typeof buildScenario>>;

beforeAll(async () => {
    s = await buildScenario();
});
afterAll(async () => {
    await destroyDb();
});

const login = (email: string, tenant?: string, password = PASSWORD) => {
    const req = request(app).post('/api/v2/auth/login');
    if (tenant) req.set('X-Tenant', tenant);
    return req.send({ email, password });
};

const refreshCookie = (res: request.Response): string => {
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find(c => c.startsWith('rt='));
    if (!raw) throw new Error('No vino la cookie rt');
    return raw.split(';')[0];
};

describe('login V2', () => {
    it('entra con el cliente en X-Tenant y recibe access token + cookie httpOnly', async () => {
        const res = await login(s.users.owner.email, s.tenantA.slug);
        expect(res.status).toBe(200);
        expect(res.body.data.accessToken).toBeTypeOf('string');
        expect(res.body.data.role).toBe('owner');
        expect(res.body.data.tenant.slug).toBe(s.tenantA.slug);
        expect(res.body.data.permissions).toContain('audit.read');

        const cookie = ([] as string[]).concat(res.headers['set-cookie']).find(c => c.startsWith('rt='))!;
        expect(cookie).toMatch(/HttpOnly/i);
        expect(cookie).toMatch(/Path=\/api\/v2\/auth/);
        expect(cookie).toMatch(/SameSite=Lax/i);
    });

    it('deja registro en auditoría con request_id, IP y cliente', async () => {
        const res = await login(s.users.finance.email, s.tenantA.slug).set('X-Request-Id', 'login-audit-test-001');
        expect(res.status).toBe(200);
        const row = await db.selectFrom('audit_logs').selectAll()
            .where('action', '=', 'auth.login').where('request_id', '=', 'login-audit-test-001')
            .executeTakeFirstOrThrow();
        expect(row.tenant_id).toBe(s.tenantA.id);
        expect(row.actor_user_id).toBe(s.users.finance.id);
        expect(row.ip).not.toBeNull();
    });

    it('contraseña incorrecta y correo inexistente responden igual (401)', async () => {
        const wrong = await login(s.users.finance.email, s.tenantA.slug, 'mala');
        const unknown = await login('nadie@example.test', s.tenantA.slug);
        expect(wrong.status).toBe(401);
        expect(unknown.status).toBe(401);
        expect(wrong.body.message).toBe(unknown.body.message);
    });

    it('bloquea la cuenta tras 5 intentos fallidos, aunque luego ponga la contraseña bien', async () => {
        const { createUser, addMembership } = await import('./fixtures');
        const u = await createUser();
        await addMembership(s.tenantA.id, u.id, 'staff');
        for (let i = 0; i < 5; i++) {
            expect((await login(u.email, s.tenantA.slug, 'mala')).status).toBe(401);
        }
        const blocked = await login(u.email, s.tenantA.slug);
        expect(blocked.status).toBe(423);
        expect(blocked.body.message).toMatch(/bloqueada/);

        const failures = await db.selectFrom('audit_logs').select('metadata')
            .where('action', '=', 'auth.login_failed').where('actor_user_id', '=', u.id).execute();
        expect(failures.map(f => fromJson<{ reason: string }>(f.metadata).reason)).toContain('locked');
    });

    it('sin membresía en ese cliente → 403', async () => {
        const res = await login(s.users.ownerB.email, s.tenantA.slug);
        expect(res.status).toBe(403);
    });

    it('usuario inactivo → 401', async () => {
        expect((await login(s.users.inactive.email, s.tenantA.slug)).status).toBe(401);
    });

    it('cliente inexistente → 404', async () => {
        expect((await login(s.users.owner.email, 'no-existe-zzz')).status).toBe(404);
    });

    it('sin cliente solo entra el admin de plataforma', async () => {
        expect((await login(s.users.owner.email)).status).toBe(403);
        const res = await login(s.users.platformAdmin.email);
        expect(res.status).toBe(200);
        expect(res.body.data.tenant).toBeNull();
        expect(res.body.data.user.isPlatformAdmin).toBe(true);
    });
});

describe('resolución del cliente', () => {
    it('por subdominio en el Host ({slug}.localhost)', async () => {
        const res = await request(app).post('/api/v2/auth/login')
            .set('Host', `${s.tenantA.slug}.localhost`)
            .send({ email: s.users.owner.email, password: PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body.data.tenant.slug).toBe(s.tenantA.slug);
    });

    it('por el Origin del Front ({slug}.localhost:4200), con CORS y credentials', async () => {
        const res = await request(app).post('/api/v2/auth/login')
            .set('Origin', `http://${s.tenantA.slug}.localhost:4200`)
            .send({ email: s.users.owner.email, password: PASSWORD });
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe(`http://${s.tenantA.slug}.localhost:4200`);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('CORS no responde a orígenes ajenos', async () => {
        const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
});

describe('sesión', () => {
    it('/me trae rol, permisos y alcance', async () => {
        const { body } = await login(s.users.viewerAz.email, s.tenantA.slug);
        const me = await request(app).get('/api/v2/auth/me')
            .set('X-Tenant', s.tenantA.slug).set('Authorization', `Bearer ${body.data.accessToken}`);
        expect(me.status).toBe(200);
        expect(me.body.data.role).toBe('viewer');
        expect(me.body.data.permissions).toEqual(['registrations.read']);
        expect(me.body.data.scope.id).toBe(s.orgs.az);
    });

    it('un token del cliente A no sirve en el cliente B', async () => {
        const { body } = await login(s.users.owner.email, s.tenantA.slug);
        const res = await request(app).get('/api/v2/auth/me')
            .set('X-Tenant', s.tenantB.slug).set('Authorization', `Bearer ${body.data.accessToken}`);
        expect(res.status).toBe(401);
    });

    it('los tokens de V1 no sirven en V2', async () => {
        const v1 = jwt.sign({ id: s.users.owner.id, role: 'superadmin' }, process.env.JWT_SECRET!, { expiresIn: '5m' });
        const res = await request(app).get('/api/v2/auth/me')
            .set('X-Tenant', s.tenantA.slug).set('Authorization', `Bearer ${v1}`);
        expect(res.status).toBe(401);
    });

    it('quitar la membresía corta el acceso de inmediato, aunque el token no haya vencido', async () => {
        const { createUser, addMembership } = await import('./fixtures');
        const u = await createUser();
        await addMembership(s.tenantA.id, u.id, 'staff');
        const { body } = await login(u.email, s.tenantA.slug);
        await db.updateTable('tenant_memberships').set({ is_active: 0 })
            .where('user_id', '=', u.id).execute();
        const res = await request(app).get('/api/v2/auth/me')
            .set('X-Tenant', s.tenantA.slug).set('Authorization', `Bearer ${body.data.accessToken}`);
        expect(res.status).toBe(403);
    });

    it('refresh rota el token: da uno nuevo y el anterior deja de servir', async () => {
        const first = await login(s.users.owner.email, s.tenantA.slug);
        const cookie1 = refreshCookie(first);

        const second = await request(app).post('/api/v2/auth/refresh').set('X-Tenant', s.tenantA.slug).set('Cookie', cookie1);
        expect(second.status).toBe(200);
        const cookie2 = refreshCookie(second);
        expect(cookie2).not.toBe(cookie1);

        // Reusar el viejo dentro de los 30 s de gracia: 401 pero no cierra todo
        const reuse = await request(app).post('/api/v2/auth/refresh').set('X-Tenant', s.tenantA.slug).set('Cookie', cookie1);
        expect(reuse.status).toBe(401);
        const third = await request(app).post('/api/v2/auth/refresh').set('X-Tenant', s.tenantA.slug).set('Cookie', cookie2);
        expect(third.status).toBe(200);
    });

    it('reusar un refresh token viejo (posible robo) cierra todas las sesiones del usuario', async () => {
        const first = await login(s.users.finance.email, s.tenantA.slug);
        const cookie1 = refreshCookie(first);
        const second = await request(app).post('/api/v2/auth/refresh').set('X-Tenant', s.tenantA.slug).set('Cookie', cookie1);
        const cookie2 = refreshCookie(second);

        // Simula que el token viejo se rotó hace más de 30 s
        await db.updateTable('user_tokens').set({ used_at: new Date(Date.now() - 120_000) })
            .where('user_id', '=', s.users.finance.id).where('used_at', 'is not', null).execute();

        const stolen = await request(app).post('/api/v2/auth/refresh').set('X-Tenant', s.tenantA.slug).set('Cookie', cookie1);
        expect(stolen.status).toBe(401);
        const legit = await request(app).post('/api/v2/auth/refresh').set('X-Tenant', s.tenantA.slug).set('Cookie', cookie2);
        expect(legit.status).toBe(401);

        const alert = await db.selectFrom('audit_logs').select('id')
            .where('action', '=', 'auth.refresh_token_reused').where('entity_id', '=', String(s.users.finance.id))
            .executeTakeFirst();
        expect(alert).toBeDefined();
    });

    it('logout invalida el refresh token', async () => {
        const res = await login(s.users.owner.email, s.tenantA.slug);
        const cookie = refreshCookie(res);
        const out = await request(app).post('/api/v2/auth/logout').set('X-Tenant', s.tenantA.slug).set('Cookie', cookie);
        expect(out.status).toBe(200);
        const again = await request(app).post('/api/v2/auth/refresh').set('X-Tenant', s.tenantA.slug).set('Cookie', cookie);
        expect(again.status).toBe(401);
    });
});
