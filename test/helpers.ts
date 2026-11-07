import { ulid } from 'ulidx';
import { db } from '../src/db/client';
import { toJson } from '../src/db/json';

/** Sufijo único para que cada prueba cree datos que no choquen con otras. */
export const uniq = () => ulid().slice(-10).toLowerCase();

/** Crea una unión + tenant mínimos para pruebas. */
export async function createTenant(name = `Union ${uniq()}`) {
    const org = await db.insertInto('organizations').values({
        parent_id: null, type: 'union', name, short_name: null, city: null, state_id: null, merged_into_id: null,
    }).executeTakeFirstOrThrow();
    const orgId = Number(org.insertId);
    const tenant = await db.insertInto('tenants').values({
        root_organization_id: orgId, name, slug: `t-${uniq()}`,
        logo_url: null, primary_color: null, secondary_color: null, email_from_name: null, email_reply_to: null,
    }).executeTakeFirstOrThrow();
    return { tenantId: Number(tenant.insertId), orgId };
}

export async function createEvent(tenantId: number, orgId: number) {
    const event = await db.insertInto('events').values({
        tenant_id: tenantId, organizer_organization_id: orgId, slug: `e-${uniq()}`,
        name: toJson({ es: 'Evento', en: 'Event' }), venue: null,
        starts_at: new Date('2027-01-01T17:00:00Z'), ends_at: new Date('2027-01-02T17:00:00Z'),
        timezone: 'America/Phoenix', cover_image_url: null, created_by: null, deleted_at: null,
    }).executeTakeFirstOrThrow();
    return Number(event.insertId);
}
