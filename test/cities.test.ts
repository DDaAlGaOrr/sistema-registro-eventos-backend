import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { db, destroyDb } from '../src/db/client';
import { fromJson } from '../src/db/json';
import { canonicalCity, cleanCityName, setCityFetcherForTests } from '../src/modules/public/cities.service';
import { FEJA_FORM_SCHEMA, TSHIRT_VARIANTS } from '../src/db/import-v1/feja-form';
import { formSchemaSchema, validateFormSchema } from '../src/modules/forms/form-schema';
import { validateAnswers } from '../src/modules/forms/answers';
import { buildScenario } from './fixtures';
import { as, loginAs } from './http';
import { uniq } from './helpers';

const app = createApp();
let s: Awaited<ReturnType<typeof buildScenario>>;
let calls: string[] = [];

const citiesOf = (code: string) => request(app).get(`/api/v2/public/states/${code}/cities`).set('X-Tenant', s.tenantA.slug);

const fetcherReturning = (names: string[]) => async (state: string) => { calls.push(state); return names; };

beforeAll(async () => {
    s = await buildScenario();
});
afterEach(() => {
    setCityFetcherForTests(null);
    calls = [];
});
afterAll(async () => {
    await db.deleteFrom('us_cities').execute();
    await db.deleteFrom('us_city_syncs').execute();
    await destroyDb();
});

// Cada prueba usa un estado distinto: el catálogo es global y queda guardado en la BD
describe('sugerencias de ciudad por estado', () => {
    it('primera consulta: trae del servicio, limpia y quita repetidas; la segunda sale de la base', async () => {
        setCityFetcherForTests(fetcherReturning(['  Phoenix ', 'Tucson', 'phoenix', 'Cottonwood', 'Álamo', 'Los   Ángeles', '']));
        const first = await citiesOf('AZ');
        expect(first.status).toBe(200);
        expect(first.body.data).toEqual({ cities: ['Álamo', 'Cottonwood', 'Los Ángeles', 'Phoenix', 'Tucson'], available: true });
        expect(calls).toEqual(['Arizona']);

        const second = await citiesOf('az'); // el código acepta minúsculas
        expect(second.body.data.cities).toHaveLength(5);
        expect(calls).toHaveLength(1);
    });

    it('si el servicio externo falla y no hay nada guardado: lista vacía (escribir a mano) y no insiste de inmediato', async () => {
        setCityFetcherForTests(async (state) => { calls.push(state); throw new Error('servicio caído'); });
        const res = await citiesOf('NV');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ cities: [], available: false });
        await citiesOf('NV');
        expect(calls).toHaveLength(1); // no vuelve a pedirlo por unos minutos

        // Cuando el servicio vuelve, se llena solo
        setCityFetcherForTests(fetcherReturning(['Las Vegas', 'Reno']));
        expect((await citiesOf('NV')).body.data).toEqual({ cities: ['Las Vegas', 'Reno'], available: true });
    });

    it('si el servicio responde algo vacío no se guarda como sincronizado', async () => {
        setCityFetcherForTests(fetcherReturning([]));
        expect((await citiesOf('UT')).body.data.available).toBe(false);
        const state = await db.selectFrom('us_states').select('id').where('code', '=', 'UT').executeTakeFirstOrThrow();
        expect(await db.selectFrom('us_city_syncs').select('state_id').where('state_id', '=', state.id).executeTakeFirst()).toBeUndefined();
    });

    it('varias personas pidiendo el mismo estado a la vez: una sola consulta externa', async () => {
        setCityFetcherForTests(async (state) => { calls.push(state); await new Promise(r => setTimeout(r, 100)); return ['Honolulu', 'Hilo']; });
        const results = await Promise.all(Array.from({ length: 6 }, () => citiesOf('HI')));
        expect(results.every(r => r.body.data.cities.length === 2)).toBe(true);
        expect(calls).toHaveLength(1);
    });

    it('un estado viejo se refresca; si el refresco falla se siguen sirviendo las ciudades guardadas', async () => {
        setCityFetcherForTests(fetcherReturning(['Boise', 'Meridian']));
        await citiesOf('ID');
        const state = await db.selectFrom('us_states').select('id').where('code', '=', 'ID').executeTakeFirstOrThrow();
        await db.updateTable('us_city_syncs').set({ synced_at: new Date(Date.now() - 200 * 86_400_000) }).where('state_id', '=', state.id).execute();

        setCityFetcherForTests(async () => { throw new Error('caído'); });
        expect((await citiesOf('ID')).body.data).toEqual({ cities: ['Boise', 'Meridian'], available: true });
    });

    it('códigos inválidos o inexistentes → 404', async () => {
        for (const code of ['A', 'ABC', 'ZZ', '12']) expect((await citiesOf(code)).status).toBe(404);
    });
});

describe('normalizar la ciudad', () => {
    it('limpia espacios y usa la escritura del catálogo (sin importar mayúsculas ni acentos)', async () => {
        setCityFetcherForTests(fetcherReturning(['Phoenix', 'Álamo', 'San José']));
        await citiesOf('OR');
        expect(cleanCityName('  Los   Angeles ')).toBe('Los Angeles');
        expect(await canonicalCity('OR', 'phoenix ')).toBe('Phoenix');
        expect(await canonicalCity('OR', 'ALAMO')).toBe('Álamo');
        expect(await canonicalCity('OR', 'san  jose')).toBe('San José');
        // Una ciudad que no está en el catálogo se conserva como la escribieron
        expect(await canonicalCity('OR', ' Pueblo   Chico ')).toBe('Pueblo Chico');
        // Sin estado no hay catálogo: solo se limpia
        expect(await canonicalCity(null, '  phoenix ')).toBe('phoenix');
    });
});

describe('campo city_picker en el formulario', () => {
    const t = (es: string) => ({ es, en: es });
    const schemaWith = (fields: object[]) => formSchemaSchema.parse({
        steps: [{
            key: 'a', title: t('A'), fields: [
                { key: 'first_name', type: 'text', maps_to: 'first_name', required: true, label: t('N') },
                { key: 'last_name', type: 'text', maps_to: 'last_name', required: true, label: t('A') },
                { key: 'email', type: 'email', maps_to: 'email', required: true, label: t('E') },
                ...fields,
            ],
        }],
    });
    const issues = (fields: object[]) => validateFormSchema(schemaWith(fields), [], { forPublish: true }).map(i => i.message).join(' | ');

    it('necesita antes el selector de estado y solo puede haber uno', () => {
        expect(issues([{ key: 'ciudad', type: 'city_picker', label: t('Ciudad') }])).toMatch(/necesita antes el selector de estado/);
        const ok = [{ key: 'u', type: 'state_conference_picker', label: t('U') }, { key: 'ciudad', type: 'city_picker', label: t('Ciudad') }];
        expect(issues(ok)).toBe('');
        expect(issues([...ok, { key: 'otra', type: 'city_picker', label: t('Otra') }])).toMatch(/Solo puede haber un selector de ciudad/);
    });

    it('la respuesta es texto normalizado; obligatorio y con largo máximo', () => {
        const schema = schemaWith([{ key: 'ciudad', type: 'city_picker', required: true, label: t('Ciudad') }]);
        const base = { first_name: 'A', last_name: 'B', email: 'a@b.co' };
        const ok = validateAnswers(schema, [], { ...base, ciudad: '  Los   Angeles ' });
        expect(ok.ok && ok.value.answers.ciudad).toBe('Los Angeles');
        const missing = validateAnswers(schema, [], base);
        expect(!missing.ok && missing.errors[0]).toMatchObject({ field: 'ciudad', code: 'required' });
        const long = validateAnswers(schema, [], { ...base, ciudad: 'x'.repeat(121) });
        expect(!long.ok && long.errors[0]).toMatchObject({ field: 'ciudad', code: 'too_long' });
        const wrongType = validateAnswers(schema, [], { ...base, ciudad: 123 });
        expect(!wrongType.ok && wrongType.errors[0].code).toBe('invalid');
    });
});

describe('registro con ciudad y relación', () => {
    let owner: ReturnType<typeof as>;
    let formId: number;
    let azChurch: number;

    beforeAll(async () => {
        owner = as(app, (await loginAs(app, s.users.owner.email, s.tenantA.slug)).token, s.tenantA.slug);
        const az = await db.selectFrom('us_states').select('id').where('code', '=', 'AZ').executeTakeFirstOrThrow();
        await db.insertInto('organization_states').ignore().values({ organization_id: s.orgs.az, state_id: az.id }).execute();
        azChurch = (await owner.post('/organizations/churches', { conferenceId: s.orgs.az, name: `Shalom ${uniq()}` })).body.data.id;

        const t2 = (es: string, en = es) => ({ es, en });
        const ev = await owner.post('/events', {
            slug: `ciudad-${uniq()}`, name: t2('Evento'), startsAt: '2027-10-15T17:00:00-07:00', endsAt: '2027-10-17T18:00:00-07:00', timezone: 'America/Phoenix',
        });
        formId = (await owner.post(`/events/${ev.body.data.id}/forms`, { title: t2('Registro') })).body.data.id;
        await owner.post(`/forms/${formId}/items`, { code: 'tshirt', kind: 'product', name: t2('Playera'), priceCents: 400, variants: TSHIRT_VARIANTS.map(v => ({ code: v.code, label: v.label })) });
        await owner.post(`/forms/${formId}/items`, { code: 'lunch', kind: 'product', name: t2('Comida'), priceCents: 200 });
        await owner.put(`/forms/${formId}/draft`, { schema: FEJA_FORM_SCHEMA });
        await owner.post(`/forms/${formId}/publish`);
        await owner.post(`/events/${ev.body.data.id}/status`, { status: 'published' });
        await owner.post(`/forms/${formId}/status`, { status: 'open' });
    });

    const person = (o: Record<string, unknown> = {}) => ({
        first_name: 'Ana', last_name: `Ciudad ${uniq()}`, email: `c-${uniq()}@example.test`, phone: '6025550101',
        birth_date: '2008-04-02', gender: 'female', location: { state: 'AZ', conference_id: s.orgs.az }, city: 'Phoenix',
        church: { church_id: azChurch }, is_chaperone: false, wants_tshirt: false, wants_lunch: false,
        emergency_name: 'Mamá', emergency_phone: '6025550000', emergency_relationship: 'padres', ...o,
    });
    const register = (answers: Record<string, unknown>) =>
        request(app).post(`/api/v2/public/forms/${formId}/registrations`).set('X-Tenant', s.tenantA.slug).send({ answers, locale: 'es' });
    const savedCity = async (publicCode: string) => {
        const r = await db.selectFrom('registrations').select('answers').where('public_code', '=', publicCode).executeTakeFirstOrThrow();
        return fromJson<Record<string, unknown>>(r.answers).city;
    };

    it('la ciudad se guarda con su escritura oficial aunque la escriban distinto', async () => {
        setCityFetcherForTests(fetcherReturning(['Phoenix', 'Tucson']));
        await citiesOf('AZ'); // lo que hace el formulario al elegir el estado
        for (const typed of ['phoenix', 'PHOENIX  ', '  Phoenix']) {
            const res = await register(person({ city: typed }));
            expect(res.status).toBe(201);
            expect(await savedCity(res.body.data.publicCode)).toBe('Phoenix');
        }
    });

    it('una ciudad que no está en la lista se conserva (solo limpia)', async () => {
        const res = await register(person({ city: '  Pueblo   Chico ' }));
        expect(await savedCity(res.body.data.publicCode)).toBe('Pueblo Chico');
    });

    it('la relación con el contacto es una de las opciones; otro valor se rechaza', async () => {
        for (const value of ['esposo(a)', 'padres', 'hermano', 'familia', 'amigo', 'otro']) {
            expect((await register(person({ emergency_relationship: value }))).status).toBe(201);
        }
        const bad = await register(person({ emergency_relationship: 'mi tío segundo' }));
        expect(bad.status).toBe(400);
        expect(bad.body.details.errors).toEqual([expect.objectContaining({ field: 'emergency_relationship', code: 'invalid_option' })]);
    });
});
