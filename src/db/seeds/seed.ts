import type { Kysely } from 'kysely';
import type { Database, OrganizationType } from '../types';
import { UNIONS, US_STATES } from './data';

export interface SeedSummary {
    states: number;
    unions: number;
    conferences: number;
}

/**
 * Busca una organización por (padre, tipo, nombre) y la crea si no existe.
 * No se usa INSERT IGNORE porque para las uniones parent_id es NULL y el
 * índice único no aplica a NULL.
 */
export async function findOrCreateOrganization(
    db: Kysely<Database>,
    org: { parentId: number | null; type: OrganizationType; name: string; shortName?: string | null; source?: 'seed' | 'admin' | 'registration'; status?: 'verified' | 'pending' }
): Promise<{ id: number; created: boolean }> {
    let query = db.selectFrom('organizations').select('id')
        .where('type', '=', org.type)
        .where('name', '=', org.name);
    query = org.parentId === null
        ? query.where('parent_id', 'is', null)
        : query.where('parent_id', '=', org.parentId);

    const existing = await query.executeTakeFirst();
    if (existing) return { id: existing.id, created: false };

    const result = await db.insertInto('organizations').values({
        parent_id: org.parentId,
        type: org.type,
        name: org.name,
        short_name: org.shortName ?? null,
        source: org.source ?? 'seed',
        status: org.status ?? 'verified',
        city: null,
        state_id: null,
        merged_into_id: null,
    }).executeTakeFirstOrThrow();
    return { id: Number(result.insertId), created: true };
}

/** Idempotente: se puede correr las veces que sea. */
export async function runSeeds(db: Kysely<Database>): Promise<SeedSummary> {
    await db.insertInto('us_states')
        .values(US_STATES.map(([code, name]) => ({ code, name })))
        .onDuplicateKeyUpdate(({ ref }) => ({ name: ref('name') as any }))
        .execute();

    const states = await db.selectFrom('us_states').select(['id', 'code']).execute();
    const stateId = new Map(states.map(s => [s.code, s.id]));

    let conferences = 0;
    for (const union of UNIONS) {
        const { id: unionId } = await findOrCreateOrganization(db, {
            parentId: null, type: 'union', name: union.name, shortName: union.shortName,
        });
        for (const conf of union.conferences) {
            const { id: confId } = await findOrCreateOrganization(db, {
                parentId: unionId, type: 'conference', name: conf.name, shortName: conf.shortName,
            });
            conferences++;
            const rows = conf.states.map(code => {
                const id = stateId.get(code);
                if (!id) throw new Error(`Estado desconocido en seed: ${code}`);
                return { organization_id: confId, state_id: id };
            });
            await db.insertInto('organization_states').ignore().values(rows).execute();
        }
    }

    return { states: states.length, unions: UNIONS.length, conferences };
}
