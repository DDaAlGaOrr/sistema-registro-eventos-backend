import pool from '../conection/index';
import { Pool, PoolConnection } from 'mysql2/promise';

/**
 * Guarda un movimiento en admin_logs.
 * Si se pasa `conn`, se escribe dentro de esa transacción: si el cambio
 * falla no queda log, y si el log falla el cambio se revierte.
 */
export const logAdminAction = async (
    adminId: number,
    accion: string,
    registroId: number | null,
    detalles: any = null,
    conn: Pool | PoolConnection = pool
) => {
    const query = `
        INSERT INTO admin_logs (admin_id, accion, registro_afectado_id, detalles)
        VALUES (?, ?, ?, ?)
    `;
    const detallesJson = detalles ? JSON.stringify(detalles) : null;

    await conn.query(query, [adminId, accion, registroId, detallesJson]);
};
