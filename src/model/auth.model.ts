import pool from '../conection/index';
import { ResultSetHeader, RowDataPacket } from 'mysql2';

export async function findByEmail(email: string) {
    const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT id, nombre, correo, password_hash, rol, activo FROM admins WHERE correo = ?',
        [email]
    );
    return rows[0] || null;
}   