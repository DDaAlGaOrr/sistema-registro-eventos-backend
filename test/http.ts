import request from 'supertest';
import type { Express } from 'express';
import { sentMailsForTests } from '../src/core/mailer';
import { PASSWORD } from './fixtures';

export async function loginAs(app: Express, email: string, tenant?: string, password = PASSWORD) {
    const req = request(app).post('/api/v2/auth/login');
    if (tenant) req.set('X-Tenant', tenant);
    const res = await req.send({ email, password });
    if (res.status !== 200) throw new Error(`Login falló (${res.status}): ${JSON.stringify(res.body)}`);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find(c => c.startsWith('rt='))?.split(';')[0];
    return { token: res.body.data.accessToken as string, cookie: cookie! };
}

/** Cliente HTTP con cliente (X-Tenant) y sesión ya puestos. */
export const as = (app: Express, token: string, tenant?: string) => {
    const wrap = (r: request.Test) => {
        if (tenant) r.set('X-Tenant', tenant);
        return r.set('Authorization', `Bearer ${token}`);
    };
    return {
        get: (path: string) => wrap(request(app).get(`/api/v2${path}`)),
        post: (path: string, body?: object) => wrap(request(app).post(`/api/v2${path}`)).send(body ?? {}),
        patch: (path: string, body?: object) => wrap(request(app).patch(`/api/v2${path}`)).send(body ?? {}),
        delete: (path: string) => wrap(request(app).delete(`/api/v2${path}`)),
    };
};

/** Último correo enviado a esa dirección (las pruebas no mandan correos reales). */
export const lastMailTo = (to: string) => [...sentMailsForTests].reverse().find(m => m.to === to);

/** Saca el token de un enlace del correo (?token=...). */
export const tokenFromMail = (to: string) => {
    const text = lastMailTo(to)?.text ?? '';
    return text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
};
