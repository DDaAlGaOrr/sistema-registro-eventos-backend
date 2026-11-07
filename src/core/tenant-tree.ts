import { db } from '../db/client';
import { getContext } from './request-context';
import { organizationSubtree } from './access-scope';
import { AppError } from '../middlewares/errorHandler';

/** Organizaciones del cliente: su raíz (unión/asociación) y todo lo que cuelga de ella. */
export async function tenantOrganizationIds(): Promise<number[]> {
    const tenant = getContext()?.tenant;
    if (!tenant) throw new AppError(400, 'Falta indicar el cliente');
    return organizationSubtree(db, tenant.rootOrganizationId);
}

/**
 * Lo que el usuario puede administrar: todo el cliente, o solo el subárbol
 * de su alcance (un owner limitado a una asociación no toca otras).
 */
export async function manageableOrganizationIds(): Promise<number[]> {
    const ctx = getContext();
    const scope = ctx?.auth?.scopeOrganizationId;
    return scope ? organizationSubtree(db, scope) : tenantOrganizationIds();
}

/** 404 si la organización no es del cliente o está fuera del alcance del usuario. */
export async function assertManageableOrganization(orgId: number): Promise<void> {
    const ids = await manageableOrganizationIds();
    if (!ids.includes(orgId)) throw new AppError(404, 'Organización no encontrada');
}
