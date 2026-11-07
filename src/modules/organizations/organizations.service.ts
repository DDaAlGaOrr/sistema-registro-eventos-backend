import { sql } from 'kysely';
import { db } from '../../db/client';
import type { OrganizationType } from '../../db/types';
import { diff, recordAudit } from '../../core/audit';
import { getContext } from '../../core/request-context';
import { assertManageableOrganization, manageableOrganizationIds, tenantOrganizationIds } from '../../core/tenant-tree';
import { AppError } from '../../middlewares/errorHandler';

export interface OrgNode {
    id: number;
    parentId: number | null;
    type: OrganizationType;
    name: string;
    shortName: string | null;
    status: string;
    city: string | null;
    state: string | null;
    children: OrgNode[];
}

/**
 * Árbol del cliente para filtros y selects. Un usuario con alcance ve su
 * rama (y la cadena hacia arriba hasta la raíz, sin hermanos).
 */
export async function getTree(includePending: boolean): Promise<OrgNode | null> {
    const tenantIds = await tenantOrganizationIds();
    const scope = getContext()?.auth?.scopeOrganizationId;
    const visible = scope ? await manageableOrganizationIds() : tenantIds;

    const rows = await db.selectFrom('organizations as o')
        .leftJoin('us_states as s', 's.id', 'o.state_id')
        .select(['o.id', 'o.parent_id', 'o.type', 'o.name', 'o.short_name', 'o.status', 'o.city', 's.code as state'])
        .where('o.id', 'in', tenantIds)
        .where('o.status', 'in', includePending ? ['verified', 'pending'] : ['verified'])
        .orderBy('o.name')
        .execute();

    const nodes = new Map<number, OrgNode>(rows.map(r => [r.id, {
        id: r.id, parentId: r.parent_id, type: r.type, name: r.name, shortName: r.short_name,
        status: r.status, city: r.city, state: r.state, children: [],
    }]));

    // Con alcance: su rama completa + ancestros directos
    const keep = new Set<number>(visible);
    if (scope) {
        let current = nodes.get(scope)?.parentId ?? null;
        while (current !== null && nodes.has(current)) {
            keep.add(current);
            current = nodes.get(current)!.parentId;
        }
    }

    let root: OrgNode | null = null;
    for (const node of nodes.values()) {
        if (!keep.has(node.id)) continue;
        const parent = node.parentId !== null ? nodes.get(node.parentId) : undefined;
        if (parent && keep.has(parent.id)) parent.children.push(node);
        else if (node.id === getContext()!.tenant!.rootOrganizationId) root = node;
    }
    return root;
}

export interface ChurchListItem {
    id: number;
    name: string;
    status: string;
    city: string | null;
    state: string | null;
    conference: { id: number; name: string; shortName: string | null };
    source: string;
    registrations: number;
    mergedInto: { id: number; name: string } | null;
}

export async function listChurches(filters: { status?: string; conferenceId?: number; q?: string }): Promise<ChurchListItem[]> {
    const ids = await manageableOrganizationIds();
    let query = db.selectFrom('organizations as c')
        .innerJoin('organizations as conf', 'conf.id', 'c.parent_id')
        .leftJoin('organizations as m', 'm.id', 'c.merged_into_id')
        .leftJoin('us_states as s', 's.id', 'c.state_id')
        .select([
            'c.id', 'c.name', 'c.status', 'c.city', 'c.source', 's.code as state',
            'conf.id as conf_id', 'conf.name as conf_name', 'conf.short_name as conf_short',
            'm.id as merged_id', 'm.name as merged_name',
            eb => eb.selectFrom('registrations as r').select(eb2 => eb2.fn.countAll<number>().as('n'))
                .whereRef('r.church_organization_id', '=', 'c.id').where('r.deleted_at', 'is', null)
                .as('registrations'),
        ])
        .where('c.type', '=', 'church')
        .where('c.id', 'in', ids);
    if (filters.status) query = query.where('c.status', '=', filters.status as any);
    if (filters.conferenceId) query = query.where('c.parent_id', '=', filters.conferenceId);
    if (filters.q) query = query.where('c.name', 'like', `%${filters.q.replace(/[%_\\]/g, m => `\\${m}`)}%`);

    const rows = await query.orderBy('c.name').execute();
    return rows.map(r => ({
        id: r.id, name: r.name, status: r.status, city: r.city, state: r.state, source: r.source,
        conference: { id: r.conf_id, name: r.conf_name, shortName: r.conf_short },
        registrations: Number(r.registrations ?? 0),
        mergedInto: r.merged_id ? { id: r.merged_id, name: r.merged_name! } : null,
    }));
}

async function getChurch(id: number) {
    await assertManageableOrganization(id);
    const row = await db.selectFrom('organizations as c')
        .leftJoin('us_states as s', 's.id', 'c.state_id')
        .select(['c.id', 'c.parent_id', 'c.type', 'c.name', 'c.status', 'c.city', 's.code as state'])
        .where('c.id', '=', id).executeTakeFirst();
    if (!row || row.type !== 'church') throw new AppError(404, 'Iglesia no encontrada');
    return row;
}

async function stateIdFor(code: string | null | undefined): Promise<number | null | undefined> {
    if (code === undefined) return undefined;
    if (code === null) return null;
    const row = await db.selectFrom('us_states').select('id').where('code', '=', code.toUpperCase()).executeTakeFirst();
    if (!row) throw new AppError(400, `Estado desconocido: ${code}`);
    return row.id;
}

const duplicateName = (err: any) => err?.code === 'ER_DUP_ENTRY'
    ? new AppError(409, 'Ya existe una iglesia con ese nombre en esa asociación') : err;

export async function createChurch(input: { conferenceId: number; name: string; city?: string | null; stateCode?: string | null }) {
    await assertManageableOrganization(input.conferenceId);
    const conf = await db.selectFrom('organizations').select('type').where('id', '=', input.conferenceId).executeTakeFirstOrThrow();
    if (conf.type !== 'conference') throw new AppError(400, 'Una iglesia debe pertenecer a una asociación');
    const stateId = await stateIdFor(input.stateCode ?? null);

    const id = await db.transaction().execute(async (trx) => {
        const res = await trx.insertInto('organizations').values({
            parent_id: input.conferenceId, type: 'church', name: input.name, short_name: null,
            city: input.city ?? null, state_id: stateId ?? null, status: 'verified', source: 'admin', merged_into_id: null,
        }).executeTakeFirstOrThrow().catch(err => { throw duplicateName(err); });
        const newId = Number(res.insertId);
        await recordAudit(trx, {
            action: 'church.created', entityType: 'organization', entityId: newId,
            metadata: { name: input.name, conferenceId: input.conferenceId },
        });
        return newId;
    });
    return getChurch(id);
}

export async function updateChurch(id: number, input: { name?: string; city?: string | null; stateCode?: string | null; status?: 'verified' | 'inactive' }) {
    const before = await getChurch(id);
    if (before.status === 'merged') throw new AppError(409, 'Esta iglesia ya se fusionó con otra');

    const changes = diff(
        { name: before.name, city: before.city, state: before.state, status: before.status },
        {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.city !== undefined ? { city: input.city } : {}),
            ...(input.stateCode !== undefined ? { state: input.stateCode?.toUpperCase() ?? null } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
        }
    );
    if (!changes) return before;

    const stateId = await stateIdFor(input.stateCode);
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('organizations').set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.city !== undefined ? { city: input.city } : {}),
            ...(stateId !== undefined ? { state_id: stateId } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
        }).where('id', '=', id).execute().catch(err => { throw duplicateName(err); });
        const action = before.status === 'pending' && input.status === 'verified' ? 'church.approved' : 'church.updated';
        await recordAudit(trx, { action, entityType: 'organization', entityId: id, changes });
    });
    return getChurch(id);
}

/**
 * Fusiona una iglesia duplicada o mal escrita en la correcta: los registros
 * pasan a la correcta y la duplicada queda como "merged" (no se borra).
 */
export async function mergeChurch(id: number, intoId: number) {
    if (id === intoId) throw new AppError(400, 'No puedes fusionar una iglesia consigo misma');
    const source = await getChurch(id);
    const target = await getChurch(intoId);
    if (source.status === 'merged') throw new AppError(409, 'Esta iglesia ya se fusionó con otra');
    if (target.status === 'merged' || target.status === 'inactive') {
        throw new AppError(409, 'La iglesia destino debe estar activa');
    }

    return db.transaction().execute(async (trx) => {
        const moved = await trx.updateTable('registrations').set({ church_organization_id: intoId })
            .where('church_organization_id', '=', id).executeTakeFirst();
        // Si alguien la había fusionado antes en esta, se redirige a la nueva destino
        await trx.updateTable('organizations').set({ merged_into_id: intoId })
            .where('merged_into_id', '=', id).execute();
        await trx.updateTable('organizations').set({ status: 'merged', merged_into_id: intoId })
            .where('id', '=', id).execute();
        const registrationsMoved = Number(moved.numUpdatedRows);
        await recordAudit(trx, {
            action: 'church.merged', entityType: 'organization', entityId: id,
            changes: { status: { from: source.status, to: 'merged' }, merged_into_id: { from: null, to: intoId } },
            metadata: { from: source.name, into: target.name, registrationsMoved },
        });
        return { mergedId: id, intoId, registrationsMoved };
    });
}

/** Para el formulario público: iglesias verificadas de una asociación. */
export async function verifiedChurchesOf(conferenceId: number) {
    return db.selectFrom('organizations').select(['id', 'name', 'city'])
        .where('parent_id', '=', conferenceId).where('type', '=', 'church').where('status', '=', 'verified')
        .orderBy(sql`name`).execute();
}
