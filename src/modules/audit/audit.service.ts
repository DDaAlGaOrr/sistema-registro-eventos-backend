import { db } from '../../db/client';
import { fromJson } from '../../db/json';
import { getContext } from '../../core/request-context';
import { currentTenantScope } from '../../core/access-scope';
import { AppError } from '../../middlewares/errorHandler';
import { findVisibleRegistration, Page } from '../registrations/registrations.repository';

/** 16 bytes (VARBINARY) → texto. IPv4-mapped se muestra como IPv4. */
export function bufferToIp(buf: Buffer | null): string | null {
    if (!buf || buf.length !== 16) return null;
    const isV4Mapped = buf.subarray(0, 10).every(b => b === 0) && buf[10] === 0xff && buf[11] === 0xff;
    if (isV4Mapped) return [...buf.subarray(12)].join('.');
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(i).toString(16));
    return groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
}

export interface AuditFilters {
    eventId?: number;
    entityType?: string;
    entityId?: string;
    actorUserId?: number;
    action?: string;
    from?: Date;
    to?: Date;
}

export interface AuditEntry {
    id: number;
    action: string;
    entityType: string;
    entityId: string | null;
    eventId: number | null;
    actor: { type: string; userId: number | null; name: string | null };
    changes: unknown;
    metadata: unknown;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
    createdAt: Date;
}

function toEntry(r: any): AuditEntry {
    return {
        id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, eventId: r.event_id,
        actor: { type: r.actor_type, userId: r.actor_user_id, name: r.actor_name },
        changes: fromJson(r.changes, null), metadata: fromJson(r.metadata, null),
        ip: bufferToIp(r.ip), userAgent: r.user_agent, requestId: r.request_id, createdAt: new Date(r.created_at),
    };
}

/**
 * Auditoría del cliente. Solo para quien ve todo el cliente: un usuario
 * limitado a una asociación solo ve el historial de los registros que puede ver.
 */
export async function listAudit(filters: AuditFilters, page: number, pageSize: number): Promise<Page<AuditEntry>> {
    const ctx = getContext()!;
    if (ctx.auth?.scopeOrganizationId) throw new AppError(403, 'La auditoría completa es solo para quien administra todo el cliente');
    const tenantId = ctx.tenant!.id;

    let query = db.selectFrom('audit_logs').where('tenant_id', '=', tenantId);
    if (filters.eventId) query = query.where('event_id', '=', filters.eventId);
    if (filters.entityType) query = query.where('entity_type', '=', filters.entityType);
    if (filters.entityId) query = query.where('entity_id', '=', filters.entityId);
    if (filters.actorUserId) query = query.where('actor_user_id', '=', filters.actorUserId);
    if (filters.action) query = query.where('action', 'like', `${filters.action.replace(/[\\%_]/g, m => `\\${m}`)}%`);
    if (filters.from) query = query.where('created_at', '>=', filters.from);
    if (filters.to) query = query.where('created_at', '<', filters.to);

    const [{ total }] = await query.select(eb => eb.fn.countAll<number>().as('total')).execute();
    const rows = await query.selectAll().orderBy('id', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute();
    return { page, pageSize, total: Number(total), items: rows.map(toEntry) };
}

/** Historial de un registro visible para el usuario. */
export async function registrationHistory(registrationId: number): Promise<AuditEntry[]> {
    const scope = await currentTenantScope();
    const found = await findVisibleRegistration(scope, registrationId, { includeDeleted: true });
    if (!found) throw new AppError(404, 'Registro no encontrado');
    const rows = await db.selectFrom('audit_logs').selectAll()
        .where('tenant_id', '=', scope.tenantId).where('entity_type', '=', 'registration')
        .where('entity_id', '=', String(registrationId))
        .orderBy('id', 'asc').execute();
    return rows.map(toEntry);
}
