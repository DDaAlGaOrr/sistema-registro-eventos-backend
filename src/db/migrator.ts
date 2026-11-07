import { Kysely, MigrationResultSet, Migrator } from 'kysely';
import { migrations } from './migrations';

export const createMigrator = (db: Kysely<any>) => new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
});

/** Lanza error si alguna migración falló; devuelve los nombres aplicados. */
export const assertMigrationResult = ({ error, results }: MigrationResultSet): string[] => {
    const failed = results?.find(r => r.status === 'Error');
    if (error || failed) {
        const name = failed?.migrationName ?? '(desconocida)';
        const cause = error instanceof Error ? error.message : String(error ?? '');
        throw new Error(`Falló la migración ${name}: ${cause}`);
    }
    return (results ?? []).filter(r => r.status === 'Success').map(r => `${r.direction} ${r.migrationName}`);
};

export async function migrateToLatest(db: Kysely<any>): Promise<string[]> {
    return assertMigrationResult(await createMigrator(db).migrateToLatest());
}
