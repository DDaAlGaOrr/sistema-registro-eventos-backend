import { Kysely, sql } from 'kysely';

/**
 * audit_logs es solo de inserción: la BD rechaza UPDATE y DELETE.
 * Se manda cada trigger como una sola sentencia (no hace falta DELIMITER).
 */
export async function up(db: Kysely<any>): Promise<void> {
    await sql.raw(`
        CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW
        BEGIN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs es solo de insercion';
        END
    `).execute(db);
    await sql.raw(`
        CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW
        BEGIN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs es solo de insercion';
        END
    `).execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await sql.raw('DROP TRIGGER IF EXISTS trg_audit_no_delete').execute(db);
    await sql.raw('DROP TRIGGER IF EXISTS trg_audit_no_update').execute(db);
}
