import type { Kysely } from 'kysely';
import type { AuditActorType, Database } from '../db/types';
import { toJson } from '../db/json';
import { getContext } from './request-context';
import { ipToBuffer } from './ip';

export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

export interface AuditEntry {
    action: string;              // 'registration.updated', 'auth.login', ...
    entityType: string;          // 'registration', 'user', 'tenant', ...
    entityId?: string | number | null;
    eventId?: number | null;
    changes?: FieldChanges | null;
    metadata?: Record<string, unknown> | null;
    /** Por defecto: 'user' si hay sesión, si no 'system'. */
    actorType?: AuditActorType;
    /** Para acciones antes de tener sesión (ej. login fallido de un usuario conocido). */
    actorUserId?: number | null;
    actorName?: string | null;
    /** Por defecto el cliente de la petición. */
    tenantId?: number | null;
}

/**
 * Escribe en audit_logs tomando del contexto el cliente, el usuario, la IP,
 * el navegador y el request_id. Pasar la transacción del cambio para que el
 * log y el cambio se guarden juntos (o ninguno).
 */
export async function recordAudit(executor: Kysely<Database>, entry: AuditEntry): Promise<void> {
    const ctx = getContext();
    const auth = ctx?.auth;
    await executor.insertInto('audit_logs').values({
        tenant_id: entry.tenantId !== undefined ? entry.tenantId : ctx?.tenant?.id ?? null,
        event_id: entry.eventId ?? null,
        actor_type: entry.actorType ?? (auth ? 'user' : 'system'),
        actor_user_id: entry.actorUserId !== undefined ? entry.actorUserId : auth?.userId ?? null,
        actor_name: entry.actorName !== undefined ? entry.actorName : auth?.name ?? null,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
        changes: entry.changes && Object.keys(entry.changes).length ? toJson(entry.changes) : null,
        metadata: entry.metadata ? toJson(entry.metadata) : null,
        ip: ipToBuffer(ctx?.ip),
        user_agent: ctx?.userAgent ?? null,
        request_id: ctx?.requestId?.slice(0, 26) ?? null,
    }).execute();
}

const normalize = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString('hex');
    if (value === undefined) return null;
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
        // MySQL reordena las llaves de los JSON; MariaDB no. Comparar sin importar el orden.
        return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize((value as any)[k])]));
    }
    return value;
};

/**
 * Diferencias campo por campo entre el registro antes y después.
 * Solo revisa las llaves de `after` (lo que se intentó cambiar); devuelve
 * null si nada cambió.
 */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): FieldChanges | null {
    const changes: FieldChanges = {};
    for (const key of Object.keys(after)) {
        const from = normalize(before[key]);
        const to = normalize(after[key]);
        if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
    }
    return Object.keys(changes).length ? changes : null;
}
