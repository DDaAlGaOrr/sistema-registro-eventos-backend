/**
 * Lo que ve una persona sin sesión: evento, formulario publicado, productos
 * disponibles, estados/asociaciones e iglesias. Siempre dentro del cliente
 * de la petición (X-Tenant / subdominio).
 */
import { sql } from 'kysely';
import { db } from '../../db/client';
import { fromJson, I18nText } from '../../db/json';
import { getContext } from '../../core/request-context';
import { tenantOrganizationIds } from '../../core/tenant-tree';
import { AppError } from '../../middlewares/errorHandler';
import { FormSchema, formSchemaSchema } from '../forms/form-schema';
import { ItemView, loadItems } from '../forms/forms.service';

const tenantId = () => {
    const t = getContext()?.tenant;
    if (!t) throw new AppError(400, 'Falta indicar el cliente');
    return t.id;
};

export type Availability = 'open' | 'not_open_yet' | 'closed' | 'full';

export interface PublicEvent {
    id: number;
    slug: string;
    name: I18nText;
    description: I18nText | null;
    venue: string | null;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    coverImageUrl: string | null;
    status: 'published' | 'closed';
}

async function findEventBySlug(slug: string): Promise<PublicEvent> {
    const e = await db.selectFrom('events').selectAll()
        .where('tenant_id', '=', tenantId()).where('slug', '=', slug).where('deleted_at', 'is', null)
        .where('status', 'in', ['published', 'closed'])
        .executeTakeFirst();
    if (!e) throw new AppError(404, 'Evento no encontrado');
    return toPublicEvent(e);
}

const toPublicEvent = (e: any): PublicEvent => ({
    id: e.id, slug: e.slug, name: fromJson<I18nText>(e.name), description: fromJson<I18nText | null>(e.description, null),
    venue: e.venue, startsAt: new Date(e.starts_at), endsAt: new Date(e.ends_at), timezone: e.timezone,
    coverImageUrl: e.cover_image_url, status: e.status,
});

/** Formulario con versión publicada, de un evento publicado o cerrado del cliente. */
export async function loadPublicForm(formId: number) {
    const form = await db.selectFrom('forms').selectAll()
        .where('id', '=', formId).where('tenant_id', '=', tenantId()).executeTakeFirst();
    if (!form || form.status === 'draft' || !form.published_version_id) throw new AppError(404, 'Formulario no encontrado');

    const event = await db.selectFrom('events').selectAll()
        .where('id', '=', form.event_id).where('deleted_at', 'is', null).where('status', 'in', ['published', 'closed'])
        .executeTakeFirst();
    if (!event) throw new AppError(404, 'Formulario no encontrado');

    const version = await db.selectFrom('form_versions').select(['id', 'version', 'schema_json'])
        .where('id', '=', form.published_version_id).executeTakeFirstOrThrow();
    return { form, event: toPublicEvent(event), version: { id: version.id, version: version.version, schema: formSchemaSchema.parse(fromJson(version.schema_json)) as FormSchema } };
}

async function countActiveRegistrations(formId: number): Promise<number> {
    const r = await db.selectFrom('registrations').select(eb => eb.fn.countAll<number>().as('n'))
        .where('form_id', '=', formId).where('deleted_at', 'is', null).where('status', '!=', 'cancelled')
        .executeTakeFirstOrThrow();
    return Number(r.n);
}

export function availabilityOf(
    form: { status: string; opens_at: Date | string | null; closes_at: Date | string | null; max_registrations: number | null },
    event: { status: string },
    registrations: number,
    now = Date.now()
): Availability {
    if (form.status !== 'open' || event.status !== 'published') return 'closed';
    if (form.opens_at && now < new Date(form.opens_at).getTime()) return 'not_open_yet';
    if (form.closes_at && now >= new Date(form.closes_at).getTime()) return 'closed';
    if (form.max_registrations !== null && registrations >= form.max_registrations) return 'full';
    return 'open';
}

/** Unidades vendidas por variante (registros no borrados ni cancelados). */
export async function soldByVariant(variantIds: number[]): Promise<Map<number, number>> {
    if (!variantIds.length) return new Map();
    const rows = await db.selectFrom('registration_items as ri')
        .innerJoin('registrations as r', 'r.id', 'ri.registration_id')
        .select(['ri.variant_id', eb => eb.fn.sum<number>('ri.quantity').as('n')])
        .where('ri.variant_id', 'in', variantIds).where('r.deleted_at', 'is', null).where('r.status', '!=', 'cancelled')
        .groupBy('ri.variant_id').execute();
    return new Map(rows.map(r => [r.variant_id!, Number(r.n)]));
}

/** Productos activos para el formulario público, con precio final y si se agotó. */
export async function publicItems(items: ItemView[]) {
    const active = items.filter(i => i.isActive);
    const sold = await soldByVariant(active.flatMap(i => i.variants.filter(v => v.stock !== null).map(v => v.id)));
    return active.map(i => ({
        code: i.code, kind: i.kind, name: i.name, description: i.description, priceCents: i.priceCents, isRequired: i.isRequired,
        variants: i.variants.filter(v => v.isActive).map(v => ({
            code: v.code, label: v.label, priceCents: v.priceCentsOverride ?? i.priceCents,
            soldOut: v.stock !== null && (sold.get(v.id) ?? 0) >= v.stock,
        })),
    }));
}

async function formsWithAvailability(event: PublicEvent) {
    const forms = await db.selectFrom('forms').selectAll()
        .where('event_id', '=', event.id).where('status', '!=', 'draft').where('published_version_id', 'is not', null)
        .orderBy('id').execute();
    return Promise.all(forms.map(async f => ({
        id: f.id,
        title: fromJson<I18nText>(f.title),
        opensAt: f.opens_at ? new Date(f.opens_at) : null,
        closesAt: f.closes_at ? new Date(f.closes_at) : null,
        availability: availabilityOf(f, event, await countActiveRegistrations(f.id)),
    })));
}

export async function getPublicEvent(slug: string) {
    const event = await findEventBySlug(slug);
    return { event, forms: await formsWithAvailability(event) };
}

/** Prioridad para resumir varios formularios en una sola etiqueta. */
const AVAILABILITY_PRIORITY: Availability[] = ['open', 'not_open_yet', 'full', 'closed'];

/**
 * Página de inicio del cliente: sus eventos publicados o cerrados (no los
 * archivados ni los borradores), con si se puede registrar alguien ahora.
 */
export async function listPublicEvents() {
    const rows = await db.selectFrom('events').selectAll()
        .where('tenant_id', '=', tenantId()).where('deleted_at', 'is', null)
        .where('status', 'in', ['published', 'closed'])
        .orderBy('starts_at', 'desc').execute();
    return Promise.all(rows.map(async (row) => {
        const event = toPublicEvent(row);
        const forms = await formsWithAvailability(event);
        const availability = AVAILABILITY_PRIORITY.find(a => forms.some(f => f.availability === a)) ?? 'closed';
        // Con un solo formulario abierto el Front puede llevar directo al registro
        const openForms = forms.filter(f => f.availability === 'open');
        return { ...event, availability, openFormId: openForms.length === 1 ? openForms[0].id : null };
    }));
}

export async function getPublicForm(formId: number) {
    const { form, event, version } = await loadPublicForm(formId);
    const items = await publicItems(await loadItems(formId));
    return {
        id: form.id,
        title: fromJson<I18nText>(form.title),
        event,
        version: version.version,
        schema: version.schema,
        items,
        payments: {
            enabled: !!form.payments_enabled,
            online: !!form.payments_enabled && !!form.allow_online_payment,
            offline: !!form.payments_enabled && !!form.allow_offline_payment,
            currency: form.currency,
        },
        opensAt: form.opens_at ? new Date(form.opens_at) : null,
        closesAt: form.closes_at ? new Date(form.closes_at) : null,
        availability: availabilityOf(form, event, await countActiveRegistrations(form.id)),
    };
}

/** Estados → asociaciones del cliente (para el selector estado/asociación). */
export async function getPublicLocations() {
    const ids = await tenantOrganizationIds();
    const rows = await db.selectFrom('organizations as o')
        .innerJoin('organization_states as os', 'os.organization_id', 'o.id')
        .innerJoin('us_states as s', 's.id', 'os.state_id')
        .select(['s.code', 's.name as state_name', 'o.id', 'o.name', 'o.short_name'])
        .where('o.id', 'in', ids).where('o.type', '=', 'conference').where('o.status', '=', 'verified')
        .orderBy('s.name').orderBy('o.name').execute();
    const states = new Map<string, { code: string; name: string; conferences: { id: number; name: string; shortName: string | null }[] }>();
    for (const r of rows) {
        const state = states.get(r.code) ?? { code: r.code, name: r.state_name, conferences: [] };
        state.conferences.push({ id: r.id, name: r.name, shortName: r.short_name });
        states.set(r.code, state);
    }
    return [...states.values()];
}

/** Iglesias verificadas de una asociación del cliente. */
export async function getPublicChurches(conferenceId: number) {
    const ids = await tenantOrganizationIds();
    if (!ids.includes(conferenceId)) throw new AppError(404, 'Asociación no encontrada');
    return db.selectFrom('organizations').select(['id', 'name', 'city'])
        .where('parent_id', '=', conferenceId).where('type', '=', 'church').where('status', '=', 'verified')
        .orderBy(sql`name`).execute();
}
