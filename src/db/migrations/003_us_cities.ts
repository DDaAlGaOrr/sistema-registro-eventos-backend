import { Kysely, sql } from 'kysely';

/**
 * Ciudades por estado para las sugerencias del formulario.
 *
 * El catálogo se llena solo: la primera vez que alguien pide las ciudades de
 * un estado se consultan a un servicio externo y se guardan aquí; después se
 * sirven desde esta tabla. La comparación ignora acentos y mayúsculas
 * (utf8mb4_unicode_ci), igual que las iglesias: "phoenix" = "Phoenix".
 */
export async function up(db: Kysely<any>): Promise<void> {
    await sql.raw(`
        CREATE TABLE us_cities (
          id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          state_id  SMALLINT UNSIGNED NOT NULL,
          name      VARCHAR(120) NOT NULL,
          UNIQUE KEY uq_city (state_id, name),
          CONSTRAINT fk_city_state FOREIGN KEY (state_id) REFERENCES us_states(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).execute(db);

    // Qué estados ya se sincronizaron y cuándo (para no volver a pedirlos cada vez
    // y para refrescarlos de vez en cuando)
    await sql.raw(`
        CREATE TABLE us_city_syncs (
          state_id   SMALLINT UNSIGNED NOT NULL PRIMARY KEY,
          synced_at  DATETIME NOT NULL,
          city_count INT UNSIGNED NOT NULL DEFAULT 0,
          CONSTRAINT fk_city_sync_state FOREIGN KEY (state_id) REFERENCES us_states(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await sql.raw('DROP TABLE IF EXISTS us_city_syncs').execute(db);
    await sql.raw('DROP TABLE IF EXISTS us_cities').execute(db);
}
