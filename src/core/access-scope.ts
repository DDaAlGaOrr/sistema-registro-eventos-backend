import type { Kysely } from 'kysely';
import { db } from '../db/client';
import type { Database } from '../db/types';
import { getContext } from './request-context';
import { AppError } from '../middlewares/errorHandler';

/**
 * Qué parte del cliente puede ver el usuario.
 *   tenant       → todo el cliente
 *   organization → una asociación (o iglesia) y lo que cuelga de ella:
 *     - eventos organizados por su asociación/iglesias → los ve completos
 *     - eventos de niveles superiores (ej. la Unión)  → solo los registrados
 *       de su asociación
 *     - eventos de otras asociaciones                 → no los ve
 */
export type AccessScope =
    | { kind: 'tenant' }
    | { kind: 'organization'; orgId: number; subtreeIds: number[]; ancestorIds: number[] };

/**
 * Lo que necesita cualquier consulta de datos de un cliente. Los
 * repositorios lo piden como primer parámetro: no se puede consultar
 * sin saber de qué cliente y con qué alcance.
 */
export interface TenantScope {
    tenantId: number;
    access: AccessScope;
}

/** Ids de la organización y todos sus descendientes (máximo 3 niveles). */
export async function organizationSubtree(executor: Kysely<Database>, orgId: number): Promise<number[]> {
    const ids = [orgId];
    let frontier = [orgId];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
        const children = await executor.selectFrom('organizations').select('id')
            .where('parent_id', 'in', frontier).execute();
        frontier = children.map(c => c.id);
        ids.push(...frontier);
    }
    return ids;
}

/** Ids de los ancestros (padre, abuelo...), sin incluir la organización. */
export async function organizationAncestors(executor: Kysely<Database>, orgId: number): Promise<number[]> {
    const ids: number[] = [];
    let current: number | null = orgId;
    for (let depth = 0; depth < 4 && current !== null; depth++) {
        const row: { parent_id: number | null } | undefined = await executor.selectFrom('organizations')
            .select('parent_id').where('id', '=', current).executeTakeFirst();
        current = row?.parent_id ?? null;
        if (current !== null) ids.push(current);
    }
    return ids;
}

/** Alcance del usuario autenticado en el cliente de la petición. */
export async function currentTenantScope(): Promise<TenantScope> {
    const ctx = getContext();
    if (!ctx?.tenant) throw new AppError(400, 'Falta indicar el cliente (header X-Tenant o subdominio)');
    if (!ctx.auth) throw new AppError(401, 'No autenticado');

    const orgId = ctx.auth.scopeOrganizationId;
    if (!orgId) return { tenantId: ctx.tenant.id, access: { kind: 'tenant' } };
    const [subtreeIds, ancestorIds] = await Promise.all([
        organizationSubtree(db, orgId),
        organizationAncestors(db, orgId),
    ]);
    return { tenantId: ctx.tenant.id, access: { kind: 'organization', orgId, subtreeIds, ancestorIds } };
}

/** ¿El usuario ve completo un evento organizado por `organizerId`? */
export const seesWholeEvent = (access: AccessScope, organizerId: number) =>
    access.kind === 'tenant' || access.subtreeIds.includes(organizerId);
