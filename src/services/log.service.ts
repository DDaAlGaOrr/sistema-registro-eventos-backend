import pool from '../conection/index';
import { ResultSetHeader, RowDataPacket } from 'mysql2';

export const logAdminAction = async (adminId: number, accion: string, registroId: number | null, detalles: any = null) => {
    const query = `
        INSERT INTO admin_logs (admin_id, accion, registro_afectado_id, detalles) 
        VALUES (?, ?, ?, ?)
    `;
    // Convertimos los detalles a string JSON si existen, si no, guardamos null
    const detallesJson = detalles ? JSON.stringify(detalles) : null;

    await pool.query(query, [adminId, accion, registroId, detallesJson]);
};