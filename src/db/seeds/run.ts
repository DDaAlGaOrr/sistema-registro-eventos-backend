/** npm run seed → carga estados de EE. UU. y uniones/asociaciones base. */
import { db, destroyDb } from '../client';
import { env } from '../../config/env';
import { runSeeds } from './seed';

runSeeds(db)
    .then((summary) => {
        console.log(`[seed] BD: ${env.DB_NAME}`);
        console.log(`  ✔ ${summary.states} estados, ${summary.unions} unión(es), ${summary.conferences} asociaciones`);
    })
    .catch((err) => {
        console.error(`[seed] ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
    })
    .finally(() => destroyDb());
