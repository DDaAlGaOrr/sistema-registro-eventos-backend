import { sql } from 'kysely';
import { db } from '../../db/client';
import { fromJson, I18nText } from '../../db/json';
import type { Locale } from '../../db/types';
import { currentTenantScope, TenantScope } from '../../core/access-scope';
import { recordAudit } from '../../core/audit';
import { AppError } from '../../middlewares/errorHandler';
import { EventSummary, findVisibleEvent } from '../events/events.repository';
import { allFields, FormField, formSchemaSchema } from '../forms/form-schema';
import { itemsOf, registrationConditions, RegistrationFilters, findVisibleRegistration } from '../registrations/registrations.repository';

async function visibleEvent(eventId: number): Promise<{ scope: TenantScope; event: EventSummary }> {
    const scope = await currentTenantScope();
    const event = await findVisibleEvent(scope, eventId);
    if (!event) throw new AppError(404, 'Evento no encontrado');
    return { scope, event };
}

const base = (scope: TenantScope, event: EventSummary, filters: RegistrationFilters = {}) =>
    db.selectFrom('registrations as r').where(eb => registrationConditions(eb, scope, event, filters));

/** Campos con opciones de las versiones del evento (para contar respuestas como la dieta). */
async function eventFields(eventId: number): Promise<FormField[]> {
    const versions = await db.selectFrom('form_versions as v').innerJoin('forms as f', 'f.id', 'v.form_id')
        .select(['v.schema_json']).where('f.event_id', '=', eventId).where('v.status', 'in', ['published', 'superseded'])
        .orderBy('v.id', 'desc').execute();
    const byKey = new Map<string, FormField>();
    for (const v of versions) {
        for (const f of allFields(formSchemaSchema.parse(fromJson(v.schema_json)))) if (!byKey.has(f.key)) byKey.set(f.key, f);
    }
    return [...byKey.values()];
}

/** Fecha local del evento (YYYY-MM-DD) para agrupar por día en su zona horaria. */
const localDate = (d: Date, timezone: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export async function getEventReport(eventId: number) {
    const { scope, event } = await visibleEvent(eventId);

    const [totals] = await base(scope, event).select([
        eb => eb.fn.countAll<number>().as('registrations'),
        eb => eb.fn.sum<number>(sql`CASE WHEN r.checked_in_at IS NOT NULL THEN 1 ELSE 0 END`).as('checked_in'),
        eb => eb.fn.sum<number>('r.total_cents').as('total_cents'),
        eb => eb.fn.sum<number>('r.paid_cents').as('paid_cents'),
    ]).execute();

    const groupCount = async (column: 'r.status' | 'r.payment_status' | 'r.gender') =>
        Object.fromEntries((await base(scope, event).select([column, eb => eb.fn.countAll<number>().as('n')]).groupBy(column).execute())
            .map((r: any) => [r[column.slice(2)] ?? 'unknown', Number(r.n)]));

    const [byStatus, byPaymentStatus, byGender] = await Promise.all([
        groupCount('r.status'), groupCount('r.payment_status'), groupCount('r.gender'),
    ]);

    const byConference = (await base(scope, event)
        .leftJoin('organizations as c', 'c.id', 'r.conference_organization_id')
        .select(['c.id', 'c.name', 'c.short_name',
            eb => eb.fn.countAll<number>().as('n'),
            eb => eb.fn.sum<number>(sql`CASE WHEN r.checked_in_at IS NOT NULL THEN 1 ELSE 0 END`).as('checked_in')])
        .groupBy(['c.id', 'c.name', 'c.short_name']).orderBy('n', 'desc').execute())
        .map(r => ({ id: r.id, name: r.name ?? null, shortName: r.short_name ?? null, registrations: Number(r.n), checkedIn: Number(r.checked_in ?? 0) }));

    const byChurch = (await base(scope, event)
        .leftJoin('organizations as ch', 'ch.id', 'r.church_organization_id')
        .select(['ch.id', 'ch.name', 'ch.status', eb => eb.fn.countAll<number>().as('n')])
        .groupBy(['ch.id', 'ch.name', 'ch.status']).orderBy('n', 'desc').execute())
        .map(r => ({ id: r.id, name: r.name ?? null, status: r.status ?? null, registrations: Number(r.n) }));

    // Por día, en la zona horaria del evento
    const created = await base(scope, event).select('r.created_at').execute();
    const daily = new Map<string, number>();
    for (const r of created) {
        const day = localDate(new Date(r.created_at), event.timezone);
        daily.set(day, (daily.get(day) ?? 0) + 1);
    }

    // Productos por variante: total, pagados, pendientes, entregados
    const items = (await base(scope, event)
        .innerJoin('registration_items as ri', 'ri.registration_id', 'r.id')
        .innerJoin('form_items as fi', 'fi.id', 'ri.item_id')
        .leftJoin('form_item_variants as fv', 'fv.id', 'ri.variant_id')
        .select(['fi.code', 'fi.name', 'fv.code as variant', 'ri.payment_status',
            eb => eb.fn.countAll<number>().as('n'),
            eb => eb.fn.sum<number>(sql`CASE WHEN ri.delivered_at IS NOT NULL THEN 1 ELSE 0 END`).as('delivered'),
            eb => eb.fn.sum<number>('ri.unit_price_cents').as('cents')])
        .groupBy(['fi.code', 'fi.name', 'fv.code', 'ri.payment_status']).execute());
    const itemReport = new Map<string, { code: string; name: I18nText; variants: Map<string, any> }>();
    for (const r of items) {
        const it = itemReport.get(r.code) ?? { code: r.code, name: fromJson<I18nText>(r.name), variants: new Map() };
        const key = r.variant ?? '';
        const v = it.variants.get(key) ?? { variant: r.variant, total: 0, paid: 0, unpaid: 0, notRequired: 0, delivered: 0, cents: 0, paidCents: 0 };
        const n = Number(r.n);
        v.total += n;
        v.delivered += Number(r.delivered ?? 0);
        v.cents += Number(r.cents ?? 0);
        if (r.payment_status === 'paid') { v.paid += n; v.paidCents += Number(r.cents ?? 0); }
        else if (r.payment_status === 'unpaid') v.unpaid += n;
        else v.notRequired += n;
        it.variants.set(key, v);
        itemReport.set(r.code, it);
    }

    // Respuestas con opciones (dieta, chaperón, etc.)
    const fields = (await eventFields(event.id)).filter(f => ['radio', 'select', 'checkbox'].includes(f.type) && !('maps_to' in f && f.maps_to));
    const answers = [];
    for (const field of fields) {
        const path = `$.${field.key}`;
        const rows = await base(scope, event)
            .select([sql<string>`JSON_UNQUOTE(JSON_EXTRACT(r.answers, ${path}))`.as('value'), eb => eb.fn.countAll<number>().as('n')])
            .groupBy(sql`JSON_UNQUOTE(JSON_EXTRACT(r.answers, ${path}))`).execute();
        const options = 'options' in field ? field.options : [{ value: true, label: { es: 'Sí', en: 'Yes' } }, { value: false, label: { es: 'No', en: 'No' } }];
        answers.push({
            key: field.key, label: field.label,
            counts: rows.filter(r => r.value !== null).map(r => ({
                value: r.value,
                label: options.find(o => String(o.value) === r.value)?.label ?? null,
                count: Number(r.n),
            })).sort((a, b) => b.count - a.count),
            unanswered: Number(rows.find(r => r.value === null)?.n ?? 0),
        });
    }

    // Dinero cobrado por método (pagos exitosos, menos reembolsos)
    const byMethod = (await base(scope, event)
        .innerJoin('payments as p', 'p.registration_id', 'r.id')
        .select(['p.method', eb => eb.fn.sum<number>(sql`p.amount_cents - p.refunded_cents`).as('cents'), eb => eb.fn.countAll<number>().as('n')])
        .where('p.status', 'in', ['succeeded', 'partially_refunded']).groupBy('p.method').execute())
        .map(r => ({ method: r.method, cents: Number(r.cents ?? 0), payments: Number(r.n) }));

    const totalCents = Number(totals.total_cents ?? 0);
    const paidCents = Number(totals.paid_cents ?? 0);
    return {
        event: { id: event.id, name: event.name, timezone: event.timezone },
        totals: {
            registrations: Number(totals.registrations), checkedIn: Number(totals.checked_in ?? 0),
            totalCents, paidCents, pendingCents: totalCents - paidCents,
        },
        byStatus, byPaymentStatus, byGender, byConference, byChurch,
        daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
        items: [...itemReport.values()].map(i => ({ code: i.code, name: i.name, variants: [...i.variants.values()] })),
        answers,
        paymentsByMethod: byMethod,
    };
}

// ── Exportar CSV ───────────────────────────────────────────────────────

const csvCell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Evita que Excel ejecute fórmulas (=, +, -, @) escritas por el público
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const localDateTime = (d: Date | string | null, timezone: string) => d
    ? new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(d))
    : '';

/** CSV con los mismos filtros y alcance que la lista; se audita (son datos personales). */
export async function exportRegistrationsCsv(eventId: number, filters: RegistrationFilters, locale: Locale) {
    const { scope, event } = await visibleEvent(eventId);
    const rows = await base(scope, event, filters)
        .leftJoin('organizations as conf', 'conf.id', 'r.conference_organization_id')
        .leftJoin('organizations as church', 'church.id', 'r.church_organization_id')
        .select([
            'r.id', 'r.public_code', 'r.created_at', 'r.first_name', 'r.last_name', 'r.email', 'r.phone', 'r.birth_date', 'r.gender',
            'conf.name as conference', 'church.name as church', 'r.church_name_raw', 'r.status', 'r.payment_status',
            'r.total_cents', 'r.paid_cents', 'r.checked_in_at', 'r.answers',
        ])
        .orderBy('r.last_name').orderBy('r.first_name').execute();
    const items = await itemsOf(rows.map(r => r.id));
    const answerFields = (await eventFields(event.id))
        .filter(f => !['state_conference_picker', 'church_picker', 'item_toggle', 'item_variant'].includes(f.type) && !('maps_to' in f && f.maps_to));

    const es = locale === 'es';
    const header = [
        es ? 'Código' : 'Code', es ? 'Fecha de registro' : 'Registered at', es ? 'Nombre' : 'First name', es ? 'Apellidos' : 'Last name',
        es ? 'Correo' : 'Email', es ? 'Teléfono' : 'Phone', es ? 'Nacimiento' : 'Birth date', es ? 'Género' : 'Gender',
        es ? 'Asociación' : 'Conference', es ? 'Iglesia' : 'Church', es ? 'Estado' : 'Status', es ? 'Pago' : 'Payment',
        'Total', es ? 'Pagado' : 'Paid', 'Check-in', es ? 'Productos' : 'Items',
        ...answerFields.map(f => f.label[locale]),
    ];
    const money = (c: number) => (c / 100).toFixed(2);
    const lines = rows.map(r => {
        const answers = fromJson<Record<string, unknown>>(r.answers, {});
        const its = (items.get(r.id) ?? []).map(i => `${i.code}${i.variantCode ? `:${i.variantCode}` : ''} (${i.paymentStatus}${i.deliveredAt ? ', entregado' : ''})`).join('; ');
        return [
            r.public_code, localDateTime(r.created_at, event.timezone), r.first_name, r.last_name, r.email, r.phone,
            r.birth_date ? new Date(r.birth_date).toISOString().slice(0, 10) : '', r.gender, r.conference,
            r.church ?? r.church_name_raw, r.status, r.payment_status, money(r.total_cents), money(r.paid_cents),
            localDateTime(r.checked_in_at, event.timezone), its,
            ...answerFields.map(f => {
                const v = answers[f.key];
                if (Array.isArray(v)) return v.join(', ');
                if (typeof v === 'boolean') return v ? (es ? 'Sí' : 'Yes') : 'No';
                return v;
            }),
        ].map(csvCell).join(',');
    });

    await recordAudit(db, {
        action: 'registrations.exported', entityType: 'event', entityId: event.id, eventId: event.id,
        metadata: { rows: rows.length, filters },
    });
    // BOM para que Excel abra bien los acentos
    return { filename: `registros-${event.slug}.csv`, content: `﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n` };
}

// ── Actividad reciente (para refrescar el panel cada pocos segundos) ────

const ACTIVITY_ACTIONS = ['registration.created', 'registration.checked_in', 'registration.check_in_undone', 'registration.deleted'];

export async function getActivity(eventId: number, afterId: number | null, limit = 30) {
    const { scope, event } = await visibleEvent(eventId);
    let query = db.selectFrom('audit_logs').select(['id', 'action', 'entity_id', 'actor_name', 'created_at'])
        .where('tenant_id', '=', scope.tenantId).where('event_id', '=', event.id).where('action', 'in', ACTIVITY_ACTIONS)
        .orderBy('id', 'desc').limit(limit);
    if (afterId) query = query.where('id', '>', afterId);
    const logs = await query.execute();

    const items = [];
    for (const log of logs) {
        const registrationId = Number(log.entity_id);
        // Los logs migrados de V1 pueden apuntar a registros que ya no existen ("v1:123")
        if (!Number.isInteger(registrationId) || registrationId <= 0) continue;
        const reg = await findVisibleRegistration(scope, registrationId, { includeDeleted: true });
        if (!reg) continue;
        items.push({
            id: log.id, action: log.action, at: new Date(log.created_at), by: log.actor_name,
            registration: { id: reg.row.id, firstName: reg.row.first_name, lastName: reg.row.last_name, conferenceId: reg.row.conference_organization_id },
        });
    }
    const latest = await db.selectFrom('audit_logs').select(eb => eb.fn.max('id').as('max'))
        .where('event_id', '=', event.id).where('action', 'in', ACTIVITY_ACTIONS).executeTakeFirst();
    return { items, cursor: Number(latest?.max ?? afterId ?? 0) };
}
