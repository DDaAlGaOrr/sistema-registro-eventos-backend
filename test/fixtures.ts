import bcrypt from 'bcrypt';
import { ulid } from 'ulidx';
import { db } from '../src/db/client';
import { toJson } from '../src/db/json';
import type { MembershipRole, OrganizationType } from '../src/db/types';
import { uniq } from './helpers';

export const PASSWORD = 'Clave-de-prueba-123';
const HASH = bcrypt.hashSync(PASSWORD, 4);

const insertId = (r: { insertId?: bigint }) => Number(r.insertId);

export async function createOrg(type: OrganizationType, name: string, parentId: number | null) {
    return insertId(await db.insertInto('organizations').values({
        parent_id: parentId, type, name: `${name} ${uniq()}`, short_name: name.slice(0, 30),
        city: null, state_id: null, merged_into_id: null,
    }).executeTakeFirstOrThrow());
}

export async function createUser(opts: { isPlatformAdmin?: boolean; isActive?: boolean } = {}) {
    const email = `u-${uniq()}@example.test`;
    const id = insertId(await db.insertInto('users').values({
        name: `Usuario ${email}`, email, password_hash: HASH,
        is_platform_admin: opts.isPlatformAdmin ? 1 : 0, is_active: opts.isActive === false ? 0 : 1,
        must_change_password: 0, locked_until: null, last_login_at: null,
    }).executeTakeFirstOrThrow());
    return { id, email };
}

export async function addMembership(tenantId: number, userId: number, role: MembershipRole, scopeOrganizationId: number | null = null) {
    await db.insertInto('tenant_memberships').values({
        tenant_id: tenantId, user_id: userId, role, scope_organization_id: scopeOrganizationId,
        is_active: 1, created_by: null,
    }).execute();
}

async function createEventWithForm(tenantId: number, organizerId: number) {
    const eventId = insertId(await db.insertInto('events').values({
        tenant_id: tenantId, organizer_organization_id: organizerId, slug: `e-${uniq()}`,
        name: toJson({ es: 'Evento', en: 'Event' }), description: null, venue: null,
        starts_at: new Date('2027-03-01T17:00:00Z'), ends_at: new Date('2027-03-02T17:00:00Z'),
        timezone: 'America/Phoenix', cover_image_url: null, created_by: null, deleted_at: null,
    }).executeTakeFirstOrThrow());
    const formId = insertId(await db.insertInto('forms').values({
        tenant_id: tenantId, event_id: eventId, title: toJson({ es: 'F', en: 'F' }),
        published_version_id: null, opens_at: null, closes_at: null, max_registrations: null,
        settings: null, created_by: null,
    }).executeTakeFirstOrThrow());
    const versionId = insertId(await db.insertInto('form_versions').values({
        form_id: formId, version: 1, schema_json: toJson({ steps: [] }), published_at: null, published_by: null,
    }).executeTakeFirstOrThrow());
    return { eventId, formId, versionId };
}

async function addRegistrations(
    tenantId: number, ev: { eventId: number; formId: number; versionId: number }, conferenceId: number, count: number
) {
    for (let i = 0; i < count; i++) {
        await db.insertInto('registrations').values({
            public_code: ulid(), tenant_id: tenantId, event_id: ev.eventId, form_id: ev.formId,
            form_version_id: ev.versionId, conference_organization_id: conferenceId,
            church_organization_id: null, church_name_raw: null,
            first_name: `Nombre${i}`, last_name: `Conf${conferenceId}`, email: `r-${uniq()}@example.test`,
            phone: null, birth_date: null, gender: null, answers: toJson({}),
            checked_in_at: null, checked_in_by: null, checked_in_method: null, deleted_at: null, deleted_by: null,
        }).execute();
    }
}

async function createTenantRow(rootOrgId: number) {
    const slug = `t-${uniq()}`;
    const id = insertId(await db.insertInto('tenants').values({
        root_organization_id: rootOrgId, name: `Cliente ${slug}`, slug,
        logo_url: null, primary_color: null, secondary_color: null, email_from_name: null, email_reply_to: null,
    }).executeTakeFirstOrThrow());
    return { id, slug };
}

/**
 * Escenario completo:
 *   Cliente A: Unión → asociaciones AZ y CA
 *     - evento de la Unión: 3 registrados de AZ + 2 de CA
 *     - evento de CA:       2 registrados de CA
 *     - evento de AZ:       1 de AZ + 1 de CA
 *   Cliente B: otra unión con un evento de 2 registrados
 */
export async function buildScenario() {
    const unionA = await createOrg('union', 'Union A', null);
    const az = await createOrg('conference', 'AZ', unionA);
    const ca = await createOrg('conference', 'CA', unionA);
    const tenantA = await createTenantRow(unionA);

    const unionB = await createOrg('union', 'Union B', null);
    const confB = await createOrg('conference', 'B1', unionB);
    const tenantB = await createTenantRow(unionB);

    const unionEvent = await createEventWithForm(tenantA.id, unionA);
    await addRegistrations(tenantA.id, unionEvent, az, 3);
    await addRegistrations(tenantA.id, unionEvent, ca, 2);
    const caEvent = await createEventWithForm(tenantA.id, ca);
    await addRegistrations(tenantA.id, caEvent, ca, 2);
    const azEvent = await createEventWithForm(tenantA.id, az);
    await addRegistrations(tenantA.id, azEvent, az, 1);
    await addRegistrations(tenantA.id, azEvent, ca, 1);
    const eventB = await createEventWithForm(tenantB.id, unionB);
    await addRegistrations(tenantB.id, eventB, confB, 2);

    const owner = await createUser();
    await addMembership(tenantA.id, owner.id, 'owner');
    const viewerAz = await createUser();
    await addMembership(tenantA.id, viewerAz.id, 'viewer', az);
    const finance = await createUser();
    await addMembership(tenantA.id, finance.id, 'finance');
    const ownerB = await createUser();
    await addMembership(tenantB.id, ownerB.id, 'owner');
    const platformAdmin = await createUser({ isPlatformAdmin: true });
    const inactive = await createUser({ isActive: false });
    await addMembership(tenantA.id, inactive.id, 'staff');

    return {
        tenantA, tenantB, orgs: { unionA, az, ca, unionB },
        events: { union: unionEvent.eventId, ca: caEvent.eventId, az: azEvent.eventId, b: eventB.eventId },
        users: { owner, viewerAz, finance, ownerB, platformAdmin, inactive },
    };
}
