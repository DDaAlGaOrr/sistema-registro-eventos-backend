import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { db, destroyDb } from '../src/db/client';
import { fromJson, toJson } from '../src/db/json';
import { runSeeds } from '../src/db/seeds/seed';
import { createEvent, createTenant, uniq } from './helpers';

afterAll(async () => {
    await destroyDb();
});

const V2_TABLES = [
    'us_states', 'organizations', 'organization_states', 'tenants', 'tenant_domains',
    'tenant_payment_accounts', 'users', 'tenant_memberships', 'user_tokens', 'events', 'forms',
    'form_versions', 'form_items', 'form_item_variants', 'registrations', 'registration_items',
    'payments', 'payment_items', 'refunds', 'stripe_webhook_events', 'email_messages', 'audit_logs',
];

describe('esquema V2', () => {
    it('crea las 22 tablas con collation utf8mb4_unicode_ci', async () => {
        const { rows } = await sql<{ name: string; coll: string }>`
            SELECT table_name AS name, table_collation AS coll
            FROM information_schema.tables WHERE table_schema = DATABASE()`.execute(db);
        const v2 = rows.filter(r => V2_TABLES.includes(r.name));
        expect(v2.map(r => r.name).sort()).toEqual([...V2_TABLES].sort());
        expect(new Set(v2.map(r => r.coll))).toEqual(new Set(['utf8mb4_unicode_ci']));
    });

    it('audit_logs es solo de inserción', async () => {
        const res = await db.insertInto('audit_logs').values({
            actor_type: 'system', action: 'test.inserted', entity_type: 'test',
            tenant_id: null, event_id: null, actor_user_id: null, actor_name: null, entity_id: null,
            changes: null, metadata: null, ip: null, user_agent: null, request_id: null,
        }).executeTakeFirstOrThrow();
        const id = Number(res.insertId);

        await expect(db.updateTable('audit_logs').set({ action: 'hack' }).where('id', '=', id).execute())
            .rejects.toThrow(/solo de insercion/);
        await expect(db.deleteFrom('audit_logs').where('id', '=', id).execute())
            .rejects.toThrow(/solo de insercion/);
    });

    it('no permite dos iglesias iguales ignorando acentos y mayúsculas', async () => {
        const { orgId } = await createTenant();
        const church = (name: string) => db.insertInto('organizations').values({
            parent_id: orgId, type: 'church', name, short_name: null, city: null, state_id: null, merged_into_id: null,
        }).execute();
        await church('Paraíso SDA');
        await expect(church('paraiso sda')).rejects.toThrow(/Duplicate/i);
    });

    it('la BD impide mezclar datos de dos clientes (FK compuesta)', async () => {
        const a = await createTenant();
        const b = await createTenant();
        const eventA = await createEvent(a.tenantId, a.orgId);

        const form = (tenantId: number) => db.insertInto('forms').values({
            tenant_id: tenantId, event_id: eventA, title: toJson({ es: 'F', en: 'F' }),
            published_version_id: null, opens_at: null, closes_at: null, max_registrations: null,
            settings: null, created_by: null,
        }).execute();

        await expect(form(a.tenantId)).resolves.toBeDefined();
        await expect(form(b.tenantId)).rejects.toThrow(/foreign key/i);
    });

    it('JSON: lo que se guarda es lo que se lee (MariaDB o MySQL)', async () => {
        const { tenantId, orgId } = await createTenant();
        const name = { es: 'Congreso Juvenil "FEJA"', en: 'Youth Congress ñ é' };
        const eventId = await db.insertInto('events').values({
            tenant_id: tenantId, organizer_organization_id: orgId, slug: `e-${uniq()}`,
            name: toJson(name), description: null, venue: null,
            starts_at: new Date('2027-01-01T17:00:00Z'), ends_at: new Date('2027-01-02T17:00:00Z'),
            timezone: 'America/Phoenix', cover_image_url: null, created_by: null, deleted_at: null,
        }).executeTakeFirstOrThrow().then(r => Number(r.insertId));

        const row = await db.selectFrom('events').select(['name', 'description', 'starts_at'])
            .where('id', '=', eventId).executeTakeFirstOrThrow();
        expect(fromJson(row.name)).toEqual(name);
        expect(fromJson(row.description, null)).toBeNull();
        // Fechas en UTC sin corrimientos de zona horaria
        expect(new Date(row.starts_at).toISOString()).toBe('2027-01-01T17:00:00.000Z');
    });

    it('los seeds son idempotentes', async () => {
        await runSeeds(db);
        const first = await runSeeds(db);
        expect(first).toEqual({ states: 51, unions: 1, conferences: 7 });

        const puc = await db.selectFrom('organizations').select('id')
            .where('name', '=', 'Pacific Union Conference').where('parent_id', 'is', null).execute();
        expect(puc).toHaveLength(1);
        const confs = await db.selectFrom('organizations').select('id')
            .where('parent_id', '=', puc[0].id).where('type', '=', 'conference').execute();
        expect(confs).toHaveLength(7);
    });
});
