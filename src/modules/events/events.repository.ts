import { db } from '../../db/client';
import { fromJson, I18nText } from '../../db/json';
import type { TenantScope } from '../../core/access-scope';

export interface EventSummary {
    id: number;
    slug: string;
    name: I18nText;
    venue: string | null;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    status: string;
    organizer: { id: number; name: string; type: string; shortName: string | null };
}

function visibleEventsQuery(scope: TenantScope) {
    let query = db.selectFrom('events')
        .innerJoin('organizations as org', 'org.id', 'events.organizer_organization_id')
        .select([
            'events.id', 'events.slug', 'events.name', 'events.venue', 'events.starts_at', 'events.ends_at',
            'events.timezone', 'events.status', 'events.organizer_organization_id',
            'org.name as organizer_name', 'org.type as organizer_type', 'org.short_name as organizer_short_name',
        ])
        .where('events.tenant_id', '=', scope.tenantId)
        .where('events.deleted_at', 'is', null);

    if (scope.access.kind === 'organization') {
        // Sus eventos y los de niveles superiores; no los de otras asociaciones
        query = query.where('events.organizer_organization_id', 'in',
            [...scope.access.subtreeIds, ...scope.access.ancestorIds]);
    }
    return query;
}

const toSummary = (row: Awaited<ReturnType<ReturnType<typeof visibleEventsQuery>['executeTakeFirstOrThrow']>>): EventSummary => ({
    id: row.id,
    slug: row.slug,
    name: fromJson<I18nText>(row.name),
    venue: row.venue,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    timezone: row.timezone,
    status: row.status,
    organizer: {
        id: row.organizer_organization_id,
        name: row.organizer_name,
        type: row.organizer_type,
        shortName: row.organizer_short_name,
    },
});

export async function listEvents(scope: TenantScope): Promise<EventSummary[]> {
    const rows = await visibleEventsQuery(scope).orderBy('events.starts_at', 'desc').execute();
    return rows.map(toSummary);
}

/** null si no existe, es de otro cliente o el usuario no puede verlo. */
export async function findVisibleEvent(scope: TenantScope, eventId: number): Promise<EventSummary | null> {
    const row = await visibleEventsQuery(scope).where('events.id', '=', eventId).executeTakeFirst();
    return row ? toSummary(row) : null;
}
