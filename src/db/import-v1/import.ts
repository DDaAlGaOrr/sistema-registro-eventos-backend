/**
 * Migración de datos V1 → V2 (FEJA Nivel Unión 2026 → tenant Pacific Union).
 *
 * Lee las tablas de V1 (registros, admins, admin_logs...) que viven en la
 * misma BD y escribe en las tablas V2. Todo corre en UNA transacción:
 *   - si algo falla o la verificación final no cuadra, no queda nada escrito;
 *   - con dryRun se hace todo, se verifica y se revierte al final.
 * Las tablas de V1 no se modifican.
 *
 * Zona horaria de V1 (verificado con los datos, leyendo con sesión en UTC):
 *   - checkin_at, updated_at, admin_logs, log_checkins, admins.created_at y
 *     eventos.created_at son TIMESTAMP con CURRENT_TIMESTAMP: ya están en UTC.
 *   - registros.created_at quedó 7 h atrás: V1 hacía
 *     CONVERT_TZ(NOW(), '+00:00', '-07:00') y guardaba la hora local de
 *     Phoenix como si fuera UTC. Prueba: ningún registro hecho en sitio tiene
 *     menos de 7 h entre created_at y su check-in. Se corrige sumando 7 h.
 *   OJO: el cliente `mysql` muestra los TIMESTAMP en la zona del servidor;
 *   para revisar valores reales usar SET time_zone = '+00:00'.
 */
import { Kysely, sql, Transaction } from 'kysely';
import { ulid } from 'ulidx';
import type { Database, MembershipRole } from '../types';
import { toJson } from '../json';
import { findOrCreateOrganization, runSeeds } from '../seeds/seed';
import { normalizarIglesia } from '../../legacy/church-normalizer';
import {
    FEJA_EVENT_NAME, FEJA_FORM_SCHEMA, FEJA_FORM_TITLE,
    LUNCH_PRICE_CENTS, TSHIRT_PRICE_CENTS, TSHIRT_VARIANTS,
} from './feja-form';

export const V1_EVENT_ID = 2;
export const TENANT_SLUG = 'pacific';
const UNION_NAME = 'Pacific Union Conference';

const HOUR_MS = 3_600_000;
/** TIMESTAMP de V1 con CURRENT_TIMESTAMP: ya es UTC (la sesión de V2 lee en +00:00). */
const v1TimestampToUtc = (d: Date | null): Date | null => d;
/** registros.created_at: hora local de Phoenix (UTC-7 todo el año) guardada como UTC. */
const v1CreatedAtToUtc = (d: Date): Date => new Date(d.getTime() + 7 * HOUR_MS);
const dateOnly = (d: Date | string | null): string | null =>
    d === null ? null : (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

const ROLE_MAP: Record<string, MembershipRole> = {
    superadmin: 'owner',
    finanzas: 'finance',
    staff: 'staff',
    admin: 'viewer',
    vicePresident: 'viewer',
};
/** "Hispanic Coordinator AZ" → asociación. CA tiene 4 asociaciones: no se puede inferir. */
const SCOPE_BY_SUFFIX: Record<string, string> = { AZ: 'AZ', NV: 'NUC', UT: 'NUC', HI: 'HIC' };
const GENDER_MAP: Record<string, 'male' | 'female' | 'undisclosed'> = {
    Masculino: 'male', Femenino: 'female', 'Prefiero no decir': 'undisclosed',
};
const DIET_MAP: Record<string, string> = { normal: 'regular', vegetariano: 'vegetarian', vegano: 'vegan', otra: 'other' };
const ACTION_MAP: Record<string, string> = {
    CHECK_IN: 'registration.checked_in',
    UPDATE_REGISTER: 'registration.updated',
    DELETE_REGISTER: 'registration.deleted',
    UPDATE_PAYMENT: 'registration.payment_updated',
};

export interface ImportReport {
    tenantId: number;
    eventId: number;
    users: number;
    platformAdmins: number;
    memberships: number;
    viewersWithoutScope: string[];
    churches: number;
    registrations: number;
    tshirts: { total: number; paid: number };
    lunches: { total: number; paid: number };
    payments: number;
    paidCents: number;
    checkedIn: number;
    auditLogs: number;
}

type Log = (message: string) => void;

class DryRunRollback extends Error { }

export async function importV1(db: Kysely<Database>, opts: { dryRun: boolean; log?: Log }): Promise<ImportReport> {
    const log = opts.log ?? (() => undefined);

    const v1Tables = await sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name IN ('registros', 'admins', 'admin_logs', 'eventos')`.execute(db);
    if (Number(v1Tables.rows[0]?.n) !== 4) {
        throw new Error('No se encontraron las tablas de V1 (registros, admins, admin_logs, eventos) en esta BD.');
    }
    const existing = await db.selectFrom('tenants').select('id').where('slug', '=', TENANT_SLUG).executeTakeFirst();
    if (existing) {
        throw new Error(`Ya existe el tenant "${TENANT_SLUG}" (id ${existing.id}): los datos de V1 ya se migraron.`);
    }

    let report: ImportReport | undefined;
    try {
        await db.transaction().execute(async (trx) => {
            report = await runImport(trx, log);
            if (opts.dryRun) throw new DryRunRollback();
        });
    } catch (err) {
        if (!(err instanceof DryRunRollback)) throw err;
        log('Modo prueba (--dry-run): todo se revirtió, no quedó nada escrito.');
    }
    return report!;
}

async function rows<T>(trx: Transaction<Database>, query: ReturnType<typeof sql<T>>): Promise<T[]> {
    return (await query.execute(trx)).rows;
}

async function runImport(trx: Transaction<Database>, log: Log): Promise<ImportReport> {
    // ── 0. Catálogo base ────────────────────────────────────────────────
    await runSeeds(trx);

    // ── 1. Leer V1 ─────────────────────────────────────────────────────
    const admins = await rows<any>(trx, sql`SELECT id, nombre, correo, password_hash, rol, activo, created_at FROM admins ORDER BY id`);
    const conferencias = await rows<any>(trx, sql`SELECT id, codigo FROM conferencias`);
    const estados = await rows<any>(trx, sql`SELECT id, codigo FROM estados`);
    const tallas = await rows<any>(trx, sql`SELECT id, talla FROM tallas_camiseta`);
    const [evento] = await rows<any>(trx, sql`SELECT * FROM eventos WHERE id = ${V1_EVENT_ID}`);
    if (!evento) throw new Error(`No existe el evento ${V1_EVENT_ID} en V1.`);
    const registros = await rows<any>(trx, sql`
        SELECT r.*, c.nombre_contacto, c.telefono_contacto, c.relacion
        FROM registros r LEFT JOIN contactos_emergencia c ON c.registro_id = r.id
        WHERE r.evento_id = ${V1_EVENT_ID} ORDER BY r.id`);
    const logCheckins = await rows<any>(trx, sql`SELECT registro_id, admin_id FROM log_checkins ORDER BY id`);
    const adminLogs = await rows<any>(trx, sql`SELECT * FROM admin_logs ORDER BY id`);
    log(`V1: ${registros.length} registros, ${admins.length} admins, ${adminLogs.length} logs`);

    const v1StateCode = new Map<number, string>(estados.map((e: any) => [e.id, e.codigo]));
    const v1ConfCode = new Map<number, string>(conferencias.map((c: any) => [c.id, c.codigo]));
    const v1TallaCode = new Map<number, string>(tallas.map((t: any) => [t.id, t.talla]));

    // ── 2. Organizaciones ──────────────────────────────────────────────
    const union = await trx.selectFrom('organizations').select('id')
        .where('type', '=', 'union').where('name', '=', UNION_NAME).where('parent_id', 'is', null)
        .executeTakeFirstOrThrow();
    const confs = await trx.selectFrom('organizations').select(['id', 'short_name'])
        .where('parent_id', '=', union.id).where('type', '=', 'conference').execute();
    const confIdByCode = new Map(confs.map(c => [c.short_name!, c.id]));
    const confOrgId = (v1ConferenciaId: number): number => {
        const id = confIdByCode.get(v1ConfCode.get(v1ConferenciaId) ?? '');
        if (!id) throw new Error(`Conferencia V1 ${v1ConferenciaId} sin asociación en V2.`);
        return id;
    };
    const usStates = await trx.selectFrom('us_states').select(['id', 'code']).execute();
    const usStateId = new Map(usStates.map(s => [s.code, s.id]));

    // ── 3. Tenant ──────────────────────────────────────────────────────
    const tenantId = Number((await trx.insertInto('tenants').values({
        root_organization_id: union.id, name: UNION_NAME, slug: TENANT_SLUG,
        default_locale: 'es', timezone: 'America/Los_Angeles',
        logo_url: null, primary_color: null, secondary_color: null, email_from_name: null, email_reply_to: null,
    }).executeTakeFirstOrThrow()).insertId);

    // ── 4. Usuarios y membresías ───────────────────────────────────────
    const userIdByAdmin = new Map<number, number>();
    const viewersWithoutScope: string[] = [];
    let memberships = 0;
    let platformAdmins = 0;
    for (const a of admins) {
        const isPlatformAdmin = a.rol === 'developer';
        const userId = Number((await trx.insertInto('users').values({
            name: a.nombre, email: String(a.correo).trim(), password_hash: a.password_hash,
            is_platform_admin: isPlatformAdmin ? 1 : 0, is_active: a.activo ? 1 : 0, must_change_password: 0,
            locked_until: null, last_login_at: null, created_at: v1TimestampToUtc(a.created_at) ?? undefined,
        }).executeTakeFirstOrThrow()).insertId);
        userIdByAdmin.set(a.id, userId);
        if (isPlatformAdmin) { platformAdmins++; continue; }

        const role = ROLE_MAP[a.rol];
        if (!role) throw new Error(`Rol V1 desconocido: ${a.rol} (admin ${a.id})`);
        let scope: number | null = null;
        if (role === 'viewer' && a.rol === 'admin') {
            const suffix = String(a.nombre).trim().match(/\b([A-Z]{2})$/)?.[1];
            const code = suffix ? SCOPE_BY_SUFFIX[suffix] : undefined;
            scope = code ? confIdByCode.get(code) ?? null : null;
            if (!scope) viewersWithoutScope.push(a.nombre);
        }
        await trx.insertInto('tenant_memberships').values({
            tenant_id: tenantId, user_id: userId, role, scope_organization_id: scope,
            is_active: a.activo ? 1 : 0, created_by: null, created_at: v1TimestampToUtc(a.created_at) ?? undefined,
        }).execute();
        memberships++;
    }

    // ── 5. Evento, formulario, productos ───────────────────────────────
    const d0 = new Date(evento.fecha_inicio);
    const d1 = new Date(evento.fecha_fin);
    // Inicio 00:00 y fin 23:59:59 hora de Phoenix (UTC-7)
    const startsAt = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate(), 7));
    const endsAt = new Date(Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate() + 1, 6, 59, 59));
    const eventCreatedAt = v1TimestampToUtc(evento.created_at) ?? new Date();

    const eventId = Number((await trx.insertInto('events').values({
        tenant_id: tenantId, organizer_organization_id: union.id, slug: 'feja-2026',
        name: toJson(FEJA_EVENT_NAME), description: null, venue: evento.lugar ?? null,
        starts_at: startsAt, ends_at: endsAt, timezone: 'America/Phoenix', status: 'closed',
        cover_image_url: null, created_by: null, created_at: eventCreatedAt, deleted_at: null,
    }).executeTakeFirstOrThrow()).insertId);

    const formId = Number((await trx.insertInto('forms').values({
        tenant_id: tenantId, event_id: eventId, title: toJson(FEJA_FORM_TITLE), status: 'closed',
        published_version_id: null, opens_at: null, closes_at: endsAt, max_registrations: null,
        payments_enabled: 1, allow_online_payment: 0, allow_offline_payment: 1, currency: 'usd',
        settings: null, created_by: null, created_at: eventCreatedAt,
    }).executeTakeFirstOrThrow()).insertId);

    const formVersionId = Number((await trx.insertInto('form_versions').values({
        form_id: formId, version: 1, schema_json: toJson(FEJA_FORM_SCHEMA), status: 'published',
        published_at: eventCreatedAt, published_by: null, created_at: eventCreatedAt,
    }).executeTakeFirstOrThrow()).insertId);
    await trx.updateTable('forms').set({ published_version_id: formVersionId }).where('id', '=', formId).execute();

    const insertItem = async (code: string, name: { es: string; en: string }, price: number, sort: number) =>
        Number((await trx.insertInto('form_items').values({
            tenant_id: tenantId, form_id: formId, code, kind: 'product', name: toJson(name), description: null,
            price_cents: price, is_required: 0, max_per_registration: 1, sort_order: sort, is_active: 1,
        }).executeTakeFirstOrThrow()).insertId);
    const tshirtItemId = await insertItem('tshirt', { es: 'Playera', en: 'T-shirt' }, TSHIRT_PRICE_CENTS, 1);
    const lunchItemId = await insertItem('lunch', { es: 'Comida', en: 'Lunch' }, LUNCH_PRICE_CENTS, 2);

    const variantIdByCode = new Map<string, number>();
    for (const [i, v] of TSHIRT_VARIANTS.entries()) {
        const id = Number((await trx.insertInto('form_item_variants').values({
            item_id: tshirtItemId, code: v.code, label: toJson(v.label), price_cents_override: null,
            stock: null, sort_order: i + 1, is_active: 1,
        }).executeTakeFirstOrThrow()).insertId);
        variantIdByCode.set(v.code, id);
    }

    // ── 6. Catálogo de iglesias ────────────────────────────────────────
    // Cada nombre normalizado va a la asociación donde más gente lo eligió.
    const tally = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
    const top = <K>(m: Map<K, number>): K | undefined => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const churchStats = new Map<string, { confs: Map<number, number>; cities: Map<string, number>; states: Map<string, number> }>();
    for (const r of registros) {
        if (!r.iglesia || !String(r.iglesia).trim()) continue;
        const name = normalizarIglesia(r.iglesia);
        const s = churchStats.get(name) ?? { confs: new Map(), cities: new Map(), states: new Map() };
        tally(s.confs, r.conferencia_id);
        if (r.ciudad?.trim()) tally(s.cities, r.ciudad.trim());
        const st = v1StateCode.get(r.estado_id);
        if (st) tally(s.states, st);
        churchStats.set(name, s);
    }
    const churchIdByName = new Map<string, number>();
    for (const [name, s] of churchStats) {
        const { id } = await findOrCreateOrganization(trx, {
            parentId: confOrgId(top(s.confs)!), type: 'church', name, source: 'registration', status: 'verified',
        });
        const stateCode = top(s.states);
        await trx.updateTable('organizations').set({
            city: top(s.cities)?.slice(0, 120) ?? null,
            state_id: stateCode ? usStateId.get(stateCode) ?? null : null,
        }).where('id', '=', id).execute();
        churchIdByName.set(name, id);
    }
    log(`Iglesias en el catálogo: ${churchIdByName.size}`);

    // ── 7. Registros, productos y pagos ────────────────────────────────
    // Último admin que marcó algo como "pagado" en cada registro (para el pago migrado)
    const lastPaidLog = new Map<number, any>();
    for (const l of adminLogs) {
        if (l.registro_afectado_id && typeof l.detalles === 'string' && l.detalles.includes('pagado')) {
            lastPaidLog.set(l.registro_afectado_id, l);
        }
    }
    const lastCheckinAdmin = new Map<number, number>(logCheckins.map((c: any) => [c.registro_id, c.admin_id]));

    const registrationIdByV1 = new Map<number, number>();
    let tshirtTotal = 0, tshirtPaid = 0, lunchTotal = 0, lunchPaid = 0, paymentsCount = 0, paidCentsTotal = 0, checkedIn = 0;

    for (const r of registros) {
        const items: Array<{ itemId: number; variantId: number | null; price: number; paid: boolean }> = [];
        if (r.incluir_camisa && r.pago_camiseta !== 'no_aplica') {
            const variantCode = v1TallaCode.get(r.talla_camiseta_id);
            items.push({
                itemId: tshirtItemId, variantId: variantCode ? variantIdByCode.get(variantCode) ?? null : null,
                price: TSHIRT_PRICE_CENTS, paid: r.pago_camiseta === 'pagado',
            });
        }
        if (r.incluir_lunchtime && r.pago_lunchtime !== 'no_aplica') {
            items.push({ itemId: lunchItemId, variantId: null, price: LUNCH_PRICE_CENTS, paid: r.pago_lunchtime === 'pagado' });
        }
        const total = items.reduce((s, i) => s + i.price, 0);
        const paid = items.filter(i => i.paid).reduce((s, i) => s + i.price, 0);
        const paymentStatus = items.length === 0 ? 'not_required' : paid === total ? 'paid' : paid > 0 ? 'partially_paid' : 'unpaid';

        const answers: Record<string, unknown> = {
            is_chaperone: !!r.es_chaperon,
            state: v1StateCode.get(r.estado_id) ?? null,
            city: r.ciudad?.trim() || null,
            emergency_name: r.nombre_contacto ?? null,
            emergency_phone: r.telefono_contacto ?? null,
            emergency_relationship: r.relacion ?? null,
        };
        if (r.incluir_lunchtime) {
            answers.diet = DIET_MAP[r.tipo_alimento] ?? 'regular';
            if (r.alimento_especial_nota?.trim()) answers.diet_note = r.alimento_especial_nota.trim();
        }

        const createdAt = v1CreatedAtToUtc(r.created_at);
        const churchName = r.iglesia && String(r.iglesia).trim() ? normalizarIglesia(r.iglesia) : null;
        const checkedInAt = v1TimestampToUtc(r.checkin_at);
        if (checkedInAt) checkedIn++;

        const registrationId = Number((await trx.insertInto('registrations').values({
            public_code: ulid(createdAt.getTime()),
            tenant_id: tenantId, event_id: eventId, form_id: formId, form_version_id: formVersionId,
            conference_organization_id: confOrgId(r.conferencia_id),
            church_organization_id: churchName ? churchIdByName.get(churchName) ?? null : null,
            church_name_raw: r.iglesia ?? null,
            first_name: String(r.nombre).trim(), last_name: String(r.apellidos).trim(),
            email: String(r.correo).trim(), phone: r.telefono ?? null,
            birth_date: dateOnly(r.fecha_nacimiento), gender: GENDER_MAP[r.genero] ?? null, locale: 'es',
            answers: toJson(answers), status: 'confirmed', payment_status: paymentStatus,
            total_cents: total, paid_cents: paid,
            checked_in_at: checkedInAt,
            checked_in_by: checkedInAt ? userIdByAdmin.get(lastCheckinAdmin.get(r.id) ?? -1) ?? null : null,
            checked_in_method: null, source: 'import',
            created_at: createdAt, updated_at: v1TimestampToUtc(r.updated_at) ?? createdAt,
            deleted_at: null, deleted_by: null,
        }).executeTakeFirstOrThrow()).insertId);
        registrationIdByV1.set(r.id, registrationId);

        const paidItemIds: Array<{ id: number; price: number }> = [];
        for (const item of items) {
            const riId = Number((await trx.insertInto('registration_items').values({
                registration_id: registrationId, item_id: item.itemId, variant_id: item.variantId,
                quantity: 1, unit_price_cents: item.price, payment_status: item.paid ? 'paid' : 'unpaid',
                delivered_at: null, delivered_by: null, created_at: createdAt,
            }).executeTakeFirstOrThrow()).insertId);
            if (item.paid) paidItemIds.push({ id: riId, price: item.price });
            if (item.itemId === tshirtItemId) { tshirtTotal++; if (item.paid) tshirtPaid++; }
            else { lunchTotal++; if (item.paid) lunchPaid++; }
        }

        if (paidItemIds.length > 0) {
            const paidLog = lastPaidLog.get(r.id);
            const paymentId = Number((await trx.insertInto('payments').values({
                tenant_id: tenantId, event_id: eventId, registration_id: registrationId,
                method: 'legacy', status: 'succeeded', amount_cents: paid, currency: 'usd',
                stripe_account_id: null, stripe_checkout_session_id: null, stripe_payment_intent_id: null,
                reference: null, notes: 'Pago registrado en V1 (método no registrado)',
                recorded_by: paidLog ? userIdByAdmin.get(paidLog.admin_id) ?? null : null,
                paid_at: v1TimestampToUtc(paidLog?.created_at ?? r.updated_at),
            }).executeTakeFirstOrThrow()).insertId);
            await trx.insertInto('payment_items').values(
                paidItemIds.map(i => ({ payment_id: paymentId, registration_item_id: i.id, amount_cents: i.price }))
            ).execute();
            paymentsCount++;
            paidCentsTotal += paid;
        }
    }
    log(`Registros migrados: ${registrationIdByV1.size}`);

    // ── 8. Auditoría ───────────────────────────────────────────────────
    const adminName = new Map<number, string>(admins.map((a: any) => [a.id, a.nombre]));
    const auditRows = adminLogs.map((l: any) => {
        let details: any = l.detalles;
        try { details = l.detalles ? JSON.parse(l.detalles) : null; } catch { /* se deja el texto */ }

        let changes: Record<string, { to: unknown }> | null = null;
        if (l.accion === 'UPDATE_REGISTER' && details && typeof details === 'object') {
            changes = Object.fromEntries(Object.entries(details).map(([k, v]) => [k, { to: v }]));
        } else if (l.accion === 'UPDATE_PAYMENT' && details?.concepto) {
            changes = { [`pago_${details.concepto}`]: { to: details.nuevo_estatus } };
        }
        const v2Id = l.registro_afectado_id ? registrationIdByV1.get(l.registro_afectado_id) : undefined;
        return {
            tenant_id: tenantId,
            event_id: v2Id ? eventId : null,
            actor_type: 'user' as const,
            actor_user_id: userIdByAdmin.get(l.admin_id) ?? null,
            actor_name: adminName.get(l.admin_id) ?? null,
            action: ACTION_MAP[l.accion] ?? `v1.${String(l.accion).toLowerCase()}`,
            entity_type: 'registration',
            entity_id: v2Id ? String(v2Id) : (l.registro_afectado_id ? `v1:${l.registro_afectado_id}` : null),
            changes: changes ? toJson(changes) : null,
            metadata: toJson({
                source: 'v1', v1_log_id: l.id, v1_registro_id: l.registro_afectado_id,
                ...(l.accion === 'DELETE_REGISTER' ? { deleted: details } : {}),
            }),
            ip: null, user_agent: null, request_id: null,
            created_at: v1TimestampToUtc(l.created_at) ?? undefined,
        };
    });
    for (let i = 0; i < auditRows.length; i += 200) {
        await trx.insertInto('audit_logs').values(auditRows.slice(i, i + 200)).execute();
    }

    const report: ImportReport = {
        tenantId, eventId,
        users: userIdByAdmin.size, platformAdmins, memberships, viewersWithoutScope,
        churches: churchIdByName.size,
        registrations: registrationIdByV1.size,
        tshirts: { total: tshirtTotal, paid: tshirtPaid },
        lunches: { total: lunchTotal, paid: lunchPaid },
        payments: paymentsCount, paidCents: paidCentsTotal, checkedIn,
        auditLogs: auditRows.length,
    };

    await trx.insertInto('audit_logs').values({
        tenant_id: tenantId, event_id: eventId, actor_type: 'system', actor_user_id: null, actor_name: 'Migración V1',
        action: 'system.v1_imported', entity_type: 'tenant', entity_id: String(tenantId),
        changes: null, metadata: toJson(report), ip: null, user_agent: null, request_id: null,
    }).execute();

    await verify(trx, report);
    return report;
}

/** Compara contra V1 calculado directo en SQL; si algo no cuadra, revienta y se revierte todo. */
async function verify(trx: Transaction<Database>, report: ImportReport) {
    const [v1] = await rows<any>(trx, sql`
        SELECT
          COUNT(*) AS registros,
          SUM(incluir_camisa = 1 AND pago_camiseta <> 'no_aplica') AS camisas,
          SUM(incluir_camisa = 1 AND pago_camiseta = 'pagado') AS camisas_pagadas,
          SUM(incluir_lunchtime = 1 AND pago_lunchtime <> 'no_aplica') AS comidas,
          SUM(incluir_lunchtime = 1 AND pago_lunchtime = 'pagado') AS comidas_pagadas,
          SUM(checkin_at IS NOT NULL) AS checkins
        FROM registros WHERE evento_id = ${V1_EVENT_ID}`);
    const [v1Admins] = await rows<any>(trx, sql`SELECT COUNT(*) AS n, SUM(rol = 'developer') AS devs FROM admins`);
    const [v1Logs] = await rows<any>(trx, sql`SELECT COUNT(*) AS n FROM admin_logs`);

    const [v2] = await rows<any>(trx, sql`
        SELECT
          (SELECT COUNT(*) FROM registrations WHERE event_id = ${report.eventId}) AS registrations,
          (SELECT COUNT(*) FROM registrations WHERE event_id = ${report.eventId} AND checked_in_at IS NOT NULL) AS checkins,
          (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE event_id = ${report.eventId}) AS paid_cents,
          (SELECT COALESCE(SUM(paid_cents), 0) FROM registrations WHERE event_id = ${report.eventId}) AS reg_paid_cents,
          (SELECT COUNT(*) FROM registrations WHERE event_id = ${report.eventId} AND conference_organization_id IS NULL) AS sin_asociacion,
          (SELECT COUNT(*) FROM audit_logs WHERE tenant_id = ${report.tenantId} AND JSON_EXTRACT(metadata, '$.source') = 'v1') AS audit`);

    const expectedCents = Number(v1.camisas_pagadas) * TSHIRT_PRICE_CENTS + Number(v1.comidas_pagadas) * LUNCH_PRICE_CENTS;
    const checks: Array<[string, number, number]> = [
        ['registros', Number(v1.registros), Number(v2.registrations)],
        ['playeras', Number(v1.camisas), report.tshirts.total],
        ['playeras pagadas', Number(v1.camisas_pagadas), report.tshirts.paid],
        ['comidas', Number(v1.comidas), report.lunches.total],
        ['comidas pagadas', Number(v1.comidas_pagadas), report.lunches.paid],
        ['centavos pagados (pagos)', expectedCents, Number(v2.paid_cents)],
        ['centavos pagados (registros)', expectedCents, Number(v2.reg_paid_cents)],
        ['check-ins', Number(v1.checkins), Number(v2.checkins)],
        ['usuarios', Number(v1Admins.n), report.users],
        ['membresías', Number(v1Admins.n) - Number(v1Admins.devs), report.memberships],
        ['logs de auditoría', Number(v1Logs.n), Number(v2.audit)],
        ['registros sin asociación', 0, Number(v2.sin_asociacion)],
    ];
    const failed = checks.filter(([, expected, actual]) => expected !== actual);
    if (failed.length > 0) {
        throw new Error('La verificación no cuadra (no se escribió nada):\n' +
            failed.map(([name, e, a]) => `  - ${name}: V1=${e} V2=${a}`).join('\n'));
    }
}
