/**
 * Sugerencias de ciudad por estado.
 *
 * V1 consultaba directo a un servicio externo desde el navegador en cada
 * registro. Aquí el backend lo consulta UNA vez por estado, guarda las
 * ciudades en us_cities y desde entonces responde desde la base:
 *   - el formulario no depende de que el servicio externo esté arriba;
 *   - si no responde y no hay nada guardado, el formulario sigue funcionando
 *     (la ciudad se escribe a mano);
 *   - las ciudades se refrescan cada REFRESH_DAYS días.
 */
import { db } from '../../db/client';
import { env } from '../../config/env';
import { logger } from '../../core/logger';
import { AppError } from '../../middlewares/errorHandler';

export type CityFetcher = (stateName: string) => Promise<string[]>;

const SOURCE_URL = 'https://countriesnow.space/api/v0.1/countries/state/cities';
const REFRESH_DAYS = 180;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const MAX_NAME = 120;

const defaultFetcher: CityFetcher = async (stateName) => {
    // Las pruebas nunca salen a internet: instalan su propio fetcher
    if (env.NODE_ENV === 'test') throw new Error('Sin red en pruebas');
    const res = await fetch(SOURCE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: 'United States', state: stateName }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`El servicio de ciudades respondió ${res.status}`);
    const json = await res.json() as { error?: boolean; data?: unknown };
    if (json.error || !Array.isArray(json.data)) throw new Error('Respuesta inesperada del servicio de ciudades');
    return json.data.filter((x): x is string => typeof x === 'string');
};

let fetcher: CityFetcher = defaultFetcher;

/** Solo pruebas. */
export function setCityFetcherForTests(custom: CityFetcher | null) {
    fetcher = custom ?? defaultFetcher;
    failedUntil.clear();
}

/** "  Los   Angeles " → "Los Angeles". */
export const cleanCityName = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Clave para comparar sin importar mayúsculas ni acentos. */
const keyOf = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const failedUntil = new Map<number, number>();
const inflight = new Map<number, Promise<void>>();

async function findState(code: string) {
    return db.selectFrom('us_states').select(['id', 'name']).where('code', '=', code.trim().toUpperCase()).executeTakeFirst();
}

async function sync(state: { id: number; name: string }) {
    const names = await fetcher(state.name);
    const unique = new Map<string, string>();
    for (const raw of names) {
        const name = cleanCityName(raw);
        if (name && name.length <= MAX_NAME && !unique.has(keyOf(name))) unique.set(keyOf(name), name);
    }
    if (unique.size === 0) throw new Error(`El servicio no devolvió ciudades para ${state.name}`);

    const list = [...unique.values()];
    await db.transaction().execute(async (trx) => {
        for (let i = 0; i < list.length; i += 400) {
            await trx.insertInto('us_cities').ignore()
                .values(list.slice(i, i + 400).map(name => ({ state_id: state.id, name }))).execute();
        }
        await trx.insertInto('us_city_syncs')
            .values({ state_id: state.id, synced_at: new Date(), city_count: list.length })
            .onDuplicateKeyUpdate({ synced_at: new Date(), city_count: list.length }).execute();
    });
}

async function ensureSynced(state: { id: number; name: string }) {
    const row = await db.selectFrom('us_city_syncs').select('synced_at').where('state_id', '=', state.id).executeTakeFirst();
    const fresh = row && Date.now() - new Date(row.synced_at).getTime() < REFRESH_DAYS * 86_400_000;
    if (fresh || (failedUntil.get(state.id) ?? 0) > Date.now()) return;

    // Varias personas pidiendo el mismo estado a la vez: una sola consulta externa
    let pending = inflight.get(state.id);
    if (!pending) {
        pending = sync(state)
            .catch((err) => {
                failedUntil.set(state.id, Date.now() + RETRY_AFTER_FAILURE_MS);
                logger.warn({ err: err instanceof Error ? err.message : err, state: state.name }, '[cities] No se pudieron actualizar las ciudades');
            })
            .finally(() => inflight.delete(state.id));
        inflight.set(state.id, pending);
    }
    await pending;
}

/** Ciudades de un estado (por su código, ej. "AZ"). `available: false` = escribirla a mano. */
export async function citiesOfState(code: string): Promise<{ cities: string[]; available: boolean }> {
    const state = await findState(code);
    if (!state) throw new AppError(404, 'Estado no encontrado');
    await ensureSynced(state);
    const rows = await db.selectFrom('us_cities').select('name').where('state_id', '=', state.id).orderBy('name').execute();
    return { cities: rows.map(r => r.name), available: rows.length > 0 };
}

/**
 * Deja la ciudad escrita de una sola forma: sin espacios de más y, si está
 * en el catálogo, con su escritura oficial ("phoenix " → "Phoenix").
 * Una ciudad que no está en el catálogo se conserva como la escribieron.
 * No consulta el servicio externo (no debe frenar un registro).
 */
export async function canonicalCity(stateCode: string | null | undefined, input: string): Promise<string> {
    const cleaned = cleanCityName(input);
    if (!cleaned || !stateCode) return cleaned;
    const state = await findState(stateCode);
    if (!state) return cleaned;
    const match = await db.selectFrom('us_cities').select('name')
        .where('state_id', '=', state.id).where('name', '=', cleaned).executeTakeFirst();
    return match?.name ?? cleaned;
}
