import { db } from '../../db/client';
import { fromJson, I18nText, toJson } from '../../db/json';
import { diff, recordAudit } from '../../core/audit';
import { currentTenantScope } from '../../core/access-scope';
import { getContext } from '../../core/request-context';
import { assertManageableOrganization } from '../../core/tenant-tree';
import { AppError } from '../../middlewares/errorHandler';
import { findVisibleEvent } from './events.repository';

export type EventStatus = 'draft' | 'published' | 'closed' | 'archived';

/** Transiciones permitidas de estado. */
const TRANSITIONS: Record<EventStatus, EventStatus[]> = {
    draft: ['published', 'archived'],
    published: ['closed', 'archived'],
    closed: ['published', 'archived'],
    archived: ['closed'],
};

export interface EventDetail {
    id: number;
    slug: string;
    name: I18nText;
    description: I18nText | null;
    venue: string | null;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    status: EventStatus;
    coverImageUrl: string | null;
    organizer: { id: number; name: string; type: string; shortName: string | null };
    registrations: number;
    createdAt: Date;
    updatedAt: Date;
}

/** Evento visible para el usuario (o 404), con lo necesario para editarlo. */
export async function getEventDetail(eventId: number): Promise<EventDetail> {
    const scope = await currentTenantScope();
    const summary = await findVisibleEvent(scope, eventId);
    if (!summary) throw new AppError(404, 'Evento no encontrado');
    const row = await db.selectFrom('events')
        .select(['description', 'cover_image_url', 'created_at', 'updated_at',
            eb => eb.selectFrom('registrations').select(eb2 => eb2.fn.countAll<number>().as('n'))
                .whereRef('registrations.event_id', '=', 'events.id').where('registrations.deleted_at', 'is', null)
                .as('registrations')])
        .where('id', '=', eventId).executeTakeFirstOrThrow();
    return {
        ...summary,
        status: summary.status as EventStatus,
        description: fromJson<I18nText | null>(row.description, null),
        coverImageUrl: row.cover_image_url,
        registrations: Number(row.registrations ?? 0),
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
    };
}

/** Además de verlo, el usuario debe poder administrar a quien lo organiza. */
export async function getManageableEvent(eventId: number): Promise<EventDetail> {
    const event = await getEventDetail(eventId);
    await assertManageableOrganization(event.organizer.id).catch(() => {
        throw new AppError(403, 'Solo puedes modificar eventos de tu asociación');
    });
    return event;
}

const duplicateSlug = (err: any) => err?.code === 'ER_DUP_ENTRY'
    ? new AppError(409, 'Ya existe un evento con esa dirección (slug) en este cliente') : err;

const checkDates = (startsAt: Date, endsAt: Date) => {
    if (endsAt.getTime() <= startsAt.getTime()) throw new AppError(400, 'La fecha de fin debe ser posterior a la de inicio');
};

export interface EventInput {
    slug: string;
    name: I18nText;
    description?: I18nText | null;
    venue?: string | null;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    coverImageUrl?: string | null;
    organizerOrganizationId?: number;
}

export async function createEvent(input: EventInput): Promise<EventDetail> {
    const ctx = getContext()!;
    const tenant = ctx.tenant!;
    // Por defecto lo organiza la asociación del usuario, o la raíz del cliente
    const organizerId = input.organizerOrganizationId ?? ctx.auth!.scopeOrganizationId ?? tenant.rootOrganizationId;
    await assertManageableOrganization(organizerId);
    checkDates(input.startsAt, input.endsAt);

    const eventId = await db.transaction().execute(async (trx) => {
        const res = await trx.insertInto('events').values({
            tenant_id: tenant.id, organizer_organization_id: organizerId, slug: input.slug,
            name: toJson(input.name), description: input.description ? toJson(input.description) : null,
            venue: input.venue ?? null, starts_at: input.startsAt, ends_at: input.endsAt, timezone: input.timezone,
            status: 'draft', cover_image_url: input.coverImageUrl ?? null, created_by: ctx.auth!.userId, deleted_at: null,
        }).executeTakeFirstOrThrow().catch(err => { throw duplicateSlug(err); });
        const id = Number(res.insertId);
        await recordAudit(trx, {
            action: 'event.created', entityType: 'event', entityId: id, eventId: id,
            metadata: { slug: input.slug, name: input.name, organizerOrganizationId: organizerId },
        });
        return id;
    });
    return getEventDetail(eventId);
}

export type EventUpdate = Partial<Omit<EventInput, 'organizerOrganizationId'>>;

export async function updateEvent(eventId: number, input: EventUpdate): Promise<EventDetail> {
    const before = await getManageableEvent(eventId);
    checkDates(input.startsAt ?? before.startsAt, input.endsAt ?? before.endsAt);

    const changes = diff(before as unknown as Record<string, unknown>, input as Record<string, unknown>);
    if (!changes) return before;

    await db.transaction().execute(async (trx) => {
        await trx.updateTable('events').set({
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            ...(input.name !== undefined ? { name: toJson(input.name) } : {}),
            ...(input.description !== undefined ? { description: input.description ? toJson(input.description) : null } : {}),
            ...(input.venue !== undefined ? { venue: input.venue } : {}),
            ...(input.startsAt !== undefined ? { starts_at: input.startsAt } : {}),
            ...(input.endsAt !== undefined ? { ends_at: input.endsAt } : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            ...(input.coverImageUrl !== undefined ? { cover_image_url: input.coverImageUrl } : {}),
        }).where('id', '=', eventId).execute().catch(err => { throw duplicateSlug(err); });
        await recordAudit(trx, { action: 'event.updated', entityType: 'event', entityId: eventId, eventId, changes });
    });
    return getEventDetail(eventId);
}

export async function changeStatus(eventId: number, status: EventStatus): Promise<EventDetail> {
    const event = await getManageableEvent(eventId);
    if (event.status === status) return event;
    if (!TRANSITIONS[event.status].includes(status)) {
        throw new AppError(409, `No se puede pasar de "${event.status}" a "${status}"`);
    }
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('events').set({ status }).where('id', '=', eventId).execute();
        await recordAudit(trx, {
            action: 'event.status_changed', entityType: 'event', entityId: eventId, eventId,
            changes: { status: { from: event.status, to: status } },
        });
    });
    return getEventDetail(eventId);
}

/** Solo eventos sin registros; los que ya tienen se archivan. */
export async function deleteEvent(eventId: number): Promise<void> {
    const event = await getManageableEvent(eventId);
    if (event.registrations > 0) {
        throw new AppError(409, 'El evento tiene registros: archívalo en lugar de borrarlo');
    }
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('events').set({ deleted_at: new Date() }).where('id', '=', eventId).execute();
        await recordAudit(trx, {
            action: 'event.deleted', entityType: 'event', entityId: eventId, eventId,
            metadata: { slug: event.slug, name: event.name },
        });
    });
}
