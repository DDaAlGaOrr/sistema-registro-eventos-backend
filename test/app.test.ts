import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { destroyDb } from '../src/db/client';

const app = createApp();

afterAll(async () => {
    await destroyDb();
});

describe('app', () => {
    it('health check responde con la BD arriba', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok', data: { api: 'up', db: 'up' } });
    });

    it('cada respuesta trae un X-Request-Id', async () => {
        const res = await request(app).get('/api/health');
        expect(res.headers['x-request-id']).toMatch(/^[0-9A-Z]{26}$/);
    });

    it('respeta un X-Request-Id válido que venga del cliente', async () => {
        const res = await request(app).get('/api/health').set('X-Request-Id', 'front-abc-12345');
        expect(res.headers['x-request-id']).toBe('front-abc-12345');
    });

    it('ignora un X-Request-Id con caracteres raros', async () => {
        const res = await request(app).get('/api/health').set('X-Request-Id', '<script>alert(1)</script>');
        expect(res.headers['x-request-id']).toMatch(/^[0-9A-Z]{26}$/);
    });

    it('ruta inexistente → 404 en JSON', async () => {
        const res = await request(app).get('/api/no-existe');
        expect(res.status).toBe(404);
        expect(res.body.status).toBe('error');
    });

    it('las rutas de V1 siguen protegidas', async () => {
        const res = await request(app).get('/api/logs');
        expect(res.status).toBe(401);
    });
});
