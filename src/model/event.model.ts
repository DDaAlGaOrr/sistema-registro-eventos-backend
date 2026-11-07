import pool from '../conection/index';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { PoolConnection } from 'mysql2/promise';
import { PayData, UserDataRegister } from '../interfaces/register.interface';
import { AppError } from '../middlewares/errorHandler';
import { logAdminAction } from '../services/log.service';
import { EditableField } from '../config/roles';
import { UpdateRegisterInput } from '../validators/register.schema';

/** Ejecuta `fn` dentro de una transacción y libera la conexión al final. */
async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const result = await fn(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

export async function getEvents() {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT  * FROM eventos');
    return rows
}

export async function getEventById(id: number) {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT  * FROM eventos where id = ?', [id]);
    return rows
}


export async function saveUserRegister(data: UserDataRegister, eventId: number) {
    return withTransaction(async (connection) => {
        const registerQuery = `
            INSERT INTO registros (
                evento_id, conferencia_id, talla_camiseta_id,incluir_camisa, nombre, apellidos,
                correo, telefono, fecha_nacimiento, genero, estado_id, ciudad,
                iglesia, incluir_lunchtime, es_chaperon, pago_camiseta, pago_lunchtime,alimento_especial_nota,tipo_alimento,created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,CONVERT_TZ(NOW(), '+00:00', '-07:00'))
        `;
        const registerData = [
            eventId, data.conferencia_id, data.talla_camiseta_id, data.incluir_camisa,
            data.nombre, data.apellidos, data.correo,
            data.telefono, data.fecha_nacimiento, data.genero,
            data.estado_id, data.ciudad, data.iglesia,
            data.incluir_lunchtime, data.es_chaperon,
            data.pago_camiseta, data.pago_lunchtime, data.alimento_especial_nota, data.tipo_alimento
        ];

        const [resultRegister] = await connection.execute<ResultSetHeader>(registerQuery, registerData);

        if (resultRegister.affectedRows === 0) {
            throw new Error('Error al insertar el registro principal, no se afectaron filas.');
        }

        const newRegisterId = resultRegister.insertId;

        const queryContactData = `
            INSERT INTO contactos_emergencia (registro_id, nombre_contacto, telefono_contacto, relacion)
            VALUES (?, ?, ?, ?)
        `;
        const contactData = [
            newRegisterId, data.contacto_emergencia.nombre_contacto,
            data.contacto_emergencia.telefono_contacto, data.contacto_emergencia.relacion
        ];

        const [resultContact] = await connection.execute<ResultSetHeader>(queryContactData, contactData);

        if (resultContact.affectedRows === 0) {
            throw new Error('Error al insertar el contacto de emergencia, no se afectaron filas.');
        }

        return newRegisterId;
    });
}

export async function getEventRegistrations(eventId: number) {
    const [rows] = await pool.query<RowDataPacket[]>(`
         select
  r.conferencia_id,
  r.talla_camiseta_id,
  r.estado_id,
  r.ciudad,
  r.id,
  r.nombre,
  r.apellidos,
  r.iglesia,
  r.telefono,
  r.correo,
  r.checkin_at,
  r.pago_camiseta,
  r.incluir_camisa,
  r.tipo_alimento,
  r.alimento_especial_nota,
  r.pago_lunchtime,
  r.incluir_lunchtime,
  r.created_at,
  c.nombre as conferencia ,
  e.nombre as estado ,
  tc.talla
        from registros r
        inner join conferencias c on c.id = r.conferencia_id
        inner join 	estados e on e.id = r.estado_id
        left join tallas_camiseta tc on tc.id = r.talla_camiseta_id where r.evento_id = ?
        ORDER BY r.created_at DESC;
        `, [eventId]);
    return rows
}


export async function lastRegisters(eventId: number) {
    const [rows] = await pool.query<RowDataPacket[]>(`
        select
  r.nombre,
  r.apellidos,
  r.correo,
  r.created_at,
  c.nombre as conferencia
        from registros r
        inner join conferencias c on c.id = r.conferencia_id
        WHERE r.evento_id = ? order by r.id DESC LIMIT 5
        `, [eventId]);
    return rows
}


export async function getRegistration(registerId: number) {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM registros where id = ?', [registerId]);
    return rows[0] ?? null;
}

async function assertRegistrationExists(conn: PoolConnection, registerId: number) {
    const [rows] = await conn.query<RowDataPacket[]>('SELECT id FROM registros WHERE id = ?', [registerId]);
    if (rows.length === 0) {
        throw new AppError(404, 'Registro no encontrado');
    }
}

export async function checkIn(registerId: number, adminId: number) {
    return withTransaction(async (connection) => {
        const queryUpdate = `
            UPDATE registros
            SET checkin_at = CURRENT_TIMESTAMP
            WHERE id = ? AND checkin_at IS NULL
        `;
        const [resultUpdate] = await connection.execute<ResultSetHeader>(queryUpdate, [registerId]);

        if (resultUpdate.affectedRows === 0) {
            await assertRegistrationExists(connection, registerId);
            throw new AppError(409, 'El registro ya tiene check-in.');
        }

        await connection.execute<ResultSetHeader>(
            'INSERT INTO log_checkins (registro_id, admin_id) VALUES (?, ?)',
            [registerId, adminId]
        );
        await logAdminAction(adminId, 'CHECK_IN', registerId, null, connection);
        return true;
    });
}

export async function updatePaymentRegister(registroId: number, adminId: number, data: PayData) {
    return withTransaction(async (connection) => {
        // concepto ya viene validado ('camiseta' | 'lunchtime'), así que la
        // columna sale de esta lista fija y nunca del body.
        const columnaPago = data.concepto === 'camiseta' ? 'pago_camiseta' : 'pago_lunchtime';
        const columnaIncluir = data.concepto === 'camiseta' ? 'incluir_camisa' : 'incluir_lunchtime';
        const incluir = data.estatus_nuevo === 'no_aplica' ? 0 : 1;

        const [resultUpdate] = await connection.execute<ResultSetHeader>(
            `UPDATE registros SET ${columnaPago} = ?, ${columnaIncluir} = ? WHERE id = ?`,
            [data.estatus_nuevo, incluir, registroId]
        );

        if (resultUpdate.affectedRows === 0) {
            throw new AppError(404, 'Registro no encontrado');
        }

        await connection.execute<ResultSetHeader>(
            `INSERT INTO log_pagos (registro_id, admin_id, concepto, estatus_nuevo, notas) VALUES (?, ?, ?, ?, ?)`,
            [registroId, adminId, data.concepto, data.estatus_nuevo, data.notas ?? null]
        );

        await logAdminAction(adminId, 'UPDATE_PAYMENT', registroId, {
            concepto: data.concepto,
            nuevo_estatus: data.estatus_nuevo
        }, connection);

        return true;
    });
}

export async function removeRegister(registerId: number, adminId: number) {
    return withTransaction(async (connection) => {
        const [rows] = await connection.query<RowDataPacket[]>(
            'SELECT id, nombre, apellidos, correo, conferencia_id, iglesia FROM registros WHERE id = ? FOR UPDATE',
            [registerId]
        );
        const registro = rows[0];
        if (!registro) {
            throw new AppError(404, 'Registro no encontrado');
        }

        try {
            await connection.execute('DELETE FROM registros WHERE id = ?', [registerId]);
        } catch (error: any) {
            // log_pagos no tiene ON DELETE CASCADE (a propósito: no se borra auditoría)
            if (error?.code === 'ER_ROW_IS_REFERENCED_2') {
                throw new AppError(409, 'No se puede eliminar: el registro tiene movimientos de pago registrados.');
            }
            throw error;
        }

        await logAdminAction(adminId, 'DELETE_REGISTER', registerId, {
            nombre_eliminado: `${registro.nombre} ${registro.apellidos}`.trim(),
            correo: registro.correo,
            conferencia_id: registro.conferencia_id,
            iglesia: registro.iglesia,
        }, connection);
    });
}

/**
 * `data` ya viene validado y filtrado por rol (solo columnas de la lista
 * blanca de config/roles.ts), así que los nombres de columna son seguros.
 */
export async function updateRegister(input: UpdateRegisterInput, id: number, adminId: number) {
    const data: Record<string, unknown> = { ...input };

    if (input.pago_lunchtime !== undefined) {
        data.incluir_lunchtime = input.pago_lunchtime === 'no_aplica' ? 0 : 1;
    }
    if (input.pago_camiseta !== undefined) {
        data.incluir_camisa = input.pago_camiseta === 'no_aplica' ? 0 : 1;
    }
    if (input.checkin_at !== undefined) {
        data.checkin_at = input.checkin_at ? new Date() : null;
    }

    const keys = Object.keys(data) as (EditableField | 'incluir_lunchtime' | 'incluir_camisa')[];
    if (keys.length === 0) return { affectedRows: 0 };

    const setClause = keys.map(key => `\`${key}\` = ?`).join(', ');
    const values = [...keys.map(k => data[k]), id];

    return withTransaction(async (connection) => {
        const [result] = await connection.query<ResultSetHeader>(
            `UPDATE registros SET ${setClause} WHERE id = ?`,
            values
        );
        if (result.affectedRows === 0) {
            throw new AppError(404, 'Registro no encontrado');
        }
        await logAdminAction(adminId, 'UPDATE_REGISTER', id, data, connection);
        return result;
    });
}

export async function wasFoodPaid(registerId: number) {
    const [rows] = await pool.query<RowDataPacket[]>(`
        SELECT 1 FROM registros WHERE pago_lunchtime = 'pagado' AND incluir_lunchtime = 1 AND id = ?;
        `, [registerId]);
    return rows.length > 0
}
