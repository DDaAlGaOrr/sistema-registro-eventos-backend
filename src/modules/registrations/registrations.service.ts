import { db } from '../../db/client';
import { fromJson, I18nText, toJson } from '../../db/json';
import { diff, FieldChanges, recordAudit } from '../../core/audit';
import { currentTenantScope, TenantScope } from '../../core/access-scope';
import { getContext } from '../../core/request-context';
import { manageableOrganizationIds, tenantOrganizationIds } from '../../core/tenant-tree';
import { AppError } from '../../middlewares/errorHandler';
import { allFields, FormField, formSchemaSchema } from '../forms/form-schema';
import { validateAnswers } from '../forms/answers';
import { findVisibleByPublicCode, findVisibleRegistration } from './registrations.repository';

const auth = () => getContext()!.auth!;

async function requireVisible(registrationId: number, opts: { includeDeleted?: boolean } = {}) {
    const scope = await currentTenantScope();
    const found = await findVisibleRegistration(scope, registrationId, opts);
    if (!found) throw new AppError(404, 'Registro no encontrado');
    return { ...found, scope };
}

async function versionFields(formVersionId: number): Promise<FormField[]> {
    const v = await db.selectFrom('form_versions').select('schema_json').where('id', '=', formVersionId).executeTakeFirstOrThrow();
    return allFields(formSchemaSchema.parse(fromJson(v.schema_json)));
}

async function loadItemsDetail(registrationId: number) {
    const rows = await db.selectFrom('registration_items as ri')
        .innerJoin('form_items as fi', 'fi.id', 'ri.item_id')
        .leftJoin('form_item_variants as fv', 'fv.id', 'ri.variant_id')
        .leftJoin('users as du', 'du.id', 'ri.delivered_by')
        .select([
            'ri.id', 'fi.id as item_id', 'fi.code', 'fi.kind', 'fi.name', 'fv.code as variant_code', 'fv.label as variant_label',
            'ri.unit_price_cents', 'ri.payment_status', 'ri.delivered_at', 'du.name as delivered_by_name',
        ])
        .where('ri.registration_id', '=', registrationId).orderBy('fi.sort_order').orderBy('ri.id').execute();
    return rows.map(r => ({
        id: r.id, itemId: r.item_id, code: r.code, kind: r.kind, name: fromJson<I18nText>(r.name),
        variant: r.variant_code ? { code: r.variant_code, label: fromJson<I18nText>(r.variant_label) } : null,
        unitPriceCents: r.unit_price_cents, paymentStatus: r.payment_status,
        deliveredAt: r.delivered_at ? new Date(r.delivered_at) : null, deliveredBy: r.delivered_by_name,
    }));
}

/** Todo lo de un registro para el panel lateral. */
export async function getRegistrationDetail(registrationId: number, opts: { includeDeleted?: boolean } = {}) {
    const { row, event } = await requireVisible(registrationId, opts);
    const [orgs, items, payments, checkedInBy, fields] = await Promise.all([
        db.selectFrom('organizations').select(['id', 'name', 'short_name', 'type', 'status'])
            .where('id', 'in', [row.conference_organization_id ?? 0, row.church_organization_id ?? 0]).execute(),
        loadItemsDetail(row.id),
        db.selectFrom('payments as p').leftJoin('users as u', 'u.id', 'p.recorded_by')
            .select(['p.id', 'p.method', 'p.status', 'p.amount_cents', 'p.refunded_cents', 'p.reference', 'p.notes', 'p.paid_at', 'u.name as recorded_by'])
            .where('p.registration_id', '=', row.id).orderBy('p.id').execute(),
        row.checked_in_by ? db.selectFrom('users').select('name').where('id', '=', row.checked_in_by).executeTakeFirst() : undefined,
        versionFields(row.form_version_id),
    ]);
    const org = (id: number | null) => {
        const o = orgs.find(x => x.id === id);
        return o ? { id: o.id, name: o.name, shortName: o.short_name, status: o.status } : null;
    };
    const answers = fromJson<Record<string, unknown>>(row.answers, {});
    return {
        id: row.id,
        publicCode: row.public_code,
        event: { id: event.id, name: event.name, slug: event.slug },
        formId: row.form_id,
        formVersionId: row.form_version_id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        phone: row.phone,
        birthDate: row.birth_date ? new Date(row.birth_date).toISOString().slice(0, 10) : null,
        gender: row.gender,
        locale: row.locale,
        conference: org(row.conference_organization_id),
        church: org(row.church_organization_id),
        churchNameRaw: row.church_name_raw,
        answers,
        // Etiquetas de los campos para mostrar las respuestas tal como se preguntaron
        answerLabels: Object.fromEntries(fields.filter(f => f.key in answers).map(f => [f.key, f.label])),
        // Etiquetas de las opciones (radio, select, grupos): el panel muestra "Vegano" y no "vegan"
        answerOptions: Object.fromEntries(fields
            .filter((f): f is typeof f & { options: { value: unknown; label: I18nText }[] } => f.key in answers && 'options' in f && Array.isArray(f.options))
            .map(f => [f.key, f.options.map(o => ({ value: o.value, label: o.label }))])),
        status: row.status,
        paymentStatus: row.payment_status,
        totalCents: row.total_cents,
        paidCents: row.paid_cents,
        items,
        payments: payments.map(p => ({
            id: p.id, method: p.method, status: p.status, amountCents: p.amount_cents, refundedCents: p.refunded_cents,
            reference: p.reference, notes: p.notes, paidAt: p.paid_at ? new Date(p.paid_at) : null, recordedBy: p.recorded_by,
        })),
        checkIn: row.checked_in_at
            ? { at: new Date(row.checked_in_at), by: checkedInBy?.name ?? null, method: row.checked_in_method }
            : null,
        source: row.source,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    };
}

// ── Edición ────────────────────────────────────────────────────────────

export interface RegistrationUpdate {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string | null;
    birthDate?: string | null;
    gender?: 'male' | 'female' | 'undisclosed' | null;
    conferenceOrganizationId?: number | null;
    churchOrganizationId?: number | null;
    /** Solo campos "normales" del formulario (no columnas ni selectores de sistema). null = borrar. */
    answers?: Record<string, unknown>;
}

const SYSTEM_TYPES = new Set(['state_conference_picker', 'church_picker', 'item_toggle', 'item_variant']);

/** Valida un solo campo con las reglas del formulario (sin su condición de visibilidad). */
function validateSingleField(field: FormField, value: unknown) {
    const { visible_when: _ignored, ...rest } = field;
    const schema = { steps: [{ key: 'edit', title: { es: 'x', en: 'x' }, fields: [rest as FormField] }] };
    const result = validateAnswers(schema, [], { [field.key]: value });
    if (!result.ok) throw new AppError(400, 'Revisa los datos', { errors: result.errors });
    return result.value.answers[field.key];
}

export async function updateRegistration(registrationId: number, input: RegistrationUpdate) {
    const { row, event } = await requireVisible(registrationId);
    if (row.status === 'cancelled') throw new AppError(409, 'El registro está cancelado');

    const set: Record<string, unknown> = {};
    const changes: FieldChanges = {};
    const track = (key: string, column: string, from: unknown, to: unknown) => {
        const d = diff({ v: from }, { v: to });
        if (d) { changes[key] = d.v; set[column] = to; }
    };

    if (input.firstName !== undefined) track('firstName', 'first_name', row.first_name, input.firstName);
    if (input.lastName !== undefined) track('lastName', 'last_name', row.last_name, input.lastName);
    if (input.email !== undefined) track('email', 'email', row.email, input.email);
    if (input.phone !== undefined) track('phone', 'phone', row.phone, input.phone);
    if (input.birthDate !== undefined) {
        track('birthDate', 'birth_date', row.birth_date ? new Date(row.birth_date).toISOString().slice(0, 10) : null, input.birthDate);
    }
    if (input.gender !== undefined) track('gender', 'gender', row.gender, input.gender);

    // Asociación / iglesia: del cliente, dentro del alcance de quien edita y coherentes entre sí
    const conferenceId = input.conferenceOrganizationId !== undefined ? input.conferenceOrganizationId : row.conference_organization_id;
    const churchId = input.churchOrganizationId !== undefined ? input.churchOrganizationId : row.church_organization_id;
    if (input.conferenceOrganizationId !== undefined || input.churchOrganizationId !== undefined) {
        const allowed = auth().scopeOrganizationId ? await manageableOrganizationIds() : await tenantOrganizationIds();
        if (conferenceId !== null) {
            const conf = await db.selectFrom('organizations').select('type').where('id', '=', conferenceId).executeTakeFirst();
            if (!conf || conf.type !== 'conference' || !allowed.includes(conferenceId)) throw new AppError(400, 'Asociación no válida');
        }
        if (churchId !== null) {
            const church = await db.selectFrom('organizations').select(['type', 'parent_id', 'name']).where('id', '=', churchId).executeTakeFirst();
            if (!church || church.type !== 'church' || !allowed.includes(churchId)) throw new AppError(400, 'Iglesia no válida');
            if (conferenceId !== null && church.parent_id !== conferenceId) throw new AppError(400, 'La iglesia no pertenece a esa asociación');
            if (churchId !== row.church_organization_id) set.church_name_raw = church.name;
        }
        track('conferenceOrganizationId', 'conference_organization_id', row.conference_organization_id, conferenceId);
        track('churchOrganizationId', 'church_organization_id', row.church_organization_id, churchId);
    }

    if (input.answers && Object.keys(input.answers).length) {
        const fields = new Map((await versionFields(row.form_version_id)).map(f => [f.key, f]));
        const current = fromJson<Record<string, unknown>>(row.answers, {});
        const next = { ...current };
        for (const [key, value] of Object.entries(input.answers)) {
            const field = fields.get(key);
            if (!field || SYSTEM_TYPES.has(field.type) || ('maps_to' in field && field.maps_to)) {
                throw new AppError(400, `"${key}" no es una respuesta editable de este formulario`);
            }
            if (value === null) delete next[key];
            else next[key] = validateSingleField(field, value);
        }
        const d = diff(current, next) ?? {};
        for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
            const fromV = current[key] ?? null;
            const toV = next[key] ?? null;
            if (JSON.stringify(fromV) !== JSON.stringify(toV)) changes[`answers.${key}`] = d[key] ?? { from: fromV, to: toV };
        }
        if (JSON.stringify(current) !== JSON.stringify(next)) set.answers = toJson(next);
    }

    if (Object.keys(changes).length) {
        await db.transaction().execute(async (trx) => {
            await trx.updateTable('registrations').set(set as any).where('id', '=', row.id).execute();
            await recordAudit(trx, { action: 'registration.updated', entityType: 'registration', entityId: row.id, eventId: event.id, changes });
        });
    }
    return getRegistrationDetail(row.id);
}

/** Cambiar la talla (u otra variante). Si cambia el precio, solo mientras no esté pagado. */
export async function changeItemVariant(registrationId: number, registrationItemId: number, variantCode: string) {
    const { row, event } = await requireVisible(registrationId);
    const item = await db.selectFrom('registration_items as ri')
        .innerJoin('form_items as fi', 'fi.id', 'ri.item_id')
        .leftJoin('form_item_variants as fv', 'fv.id', 'ri.variant_id')
        .select(['ri.id', 'ri.item_id', 'ri.unit_price_cents', 'ri.payment_status', 'ri.delivered_at', 'fi.price_cents', 'fi.code', 'fv.code as old_variant'])
        .where('ri.id', '=', registrationItemId).where('ri.registration_id', '=', row.id).executeTakeFirst();
    if (!item) throw new AppError(404, 'Producto no encontrado en este registro');
    if (item.delivered_at) throw new AppError(409, 'Ya se entregó; deshaz la entrega antes de cambiar la talla');

    const variant = await db.selectFrom('form_item_variants').selectAll()
        .where('item_id', '=', item.item_id).where('code', '=', variantCode).where('is_active', '=', 1).executeTakeFirst();
    if (!variant) throw new AppError(400, 'Esa variante no existe o no está disponible');
    if (variant.code === item.old_variant) return getRegistrationDetail(row.id);

    const newPrice = variant.price_cents_override ?? item.price_cents;
    if (newPrice !== item.unit_price_cents && item.payment_status === 'paid') {
        throw new AppError(409, 'La nueva talla tiene otro precio y este producto ya está pagado; ajústalo desde pagos');
    }

    await db.transaction().execute(async (trx) => {
        if (variant.stock !== null) {
            await trx.selectFrom('form_item_variants').select('id').where('id', '=', variant.id).forUpdate().execute();
            const sold = await trx.selectFrom('registration_items as ri').innerJoin('registrations as r', 'r.id', 'ri.registration_id')
                .select(eb => eb.fn.sum<number>('ri.quantity').as('n'))
                .where('ri.variant_id', '=', variant.id).where('r.deleted_at', 'is', null).where('r.status', '!=', 'cancelled')
                .executeTakeFirst();
            if (Number(sold?.n ?? 0) >= variant.stock) throw new AppError(409, `Se agotó la talla ${variant.code}`);
        }
        await trx.updateTable('registration_items').set({ variant_id: variant.id, unit_price_cents: newPrice }).where('id', '=', item.id).execute();
        if (newPrice !== item.unit_price_cents) {
            await trx.updateTable('registrations').set({ total_cents: row.total_cents - item.unit_price_cents + newPrice }).where('id', '=', row.id).execute();
        }
        await recordAudit(trx, {
            action: 'registration.item_changed', entityType: 'registration', entityId: row.id, eventId: event.id,
            changes: {
                [`items.${item.code}.variant`]: { from: item.old_variant, to: variant.code },
                ...(newPrice !== item.unit_price_cents ? { [`items.${item.code}.unitPriceCents`]: { from: item.unit_price_cents, to: newPrice } } : {}),
            },
        });
    });
    return getRegistrationDetail(row.id);
}

// ── Borrar / restaurar ─────────────────────────────────────────────────

/** Borrado lógico: el registro se conserva (papelera) y la auditoría guarda una copia. */
export async function deleteRegistration(registrationId: number, reason: string | null) {
    const detail = await getRegistrationDetail(registrationId);
    if (detail.payments.some(p => p.status === 'succeeded' && p.amountCents > p.refundedCents)) {
        throw new AppError(409, 'El registro tiene pagos; reembólsalos o cancélalos antes de borrarlo');
    }
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('registrations').set({ deleted_at: new Date(), deleted_by: auth().userId })
            .where('id', '=', registrationId).execute();
        await recordAudit(trx, {
            action: 'registration.deleted', entityType: 'registration', entityId: registrationId, eventId: detail.event.id,
            metadata: {
                reason,
                snapshot: {
                    publicCode: detail.publicCode, firstName: detail.firstName, lastName: detail.lastName, email: detail.email,
                    phone: detail.phone, conference: detail.conference?.name ?? null, church: detail.church?.name ?? detail.churchNameRaw,
                    items: detail.items.map(i => ({ code: i.code, variant: i.variant?.code ?? null, paymentStatus: i.paymentStatus })),
                },
            },
        });
    });
}

export async function restoreRegistration(registrationId: number) {
    const { row, event } = await requireVisible(registrationId, { includeDeleted: true });
    if (!row.deleted_at) return getRegistrationDetail(row.id);
    const duplicate = await db.selectFrom('registrations').select('id')
        .where('event_id', '=', row.event_id).where('email', '=', row.email)
        .where('first_name', '=', row.first_name).where('last_name', '=', row.last_name)
        .where('deleted_at', 'is', null).where('id', '!=', row.id).executeTakeFirst();
    if (duplicate) throw new AppError(409, 'Ya existe otro registro activo de esta persona en el evento');
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('registrations').set({ deleted_at: null, deleted_by: null }).where('id', '=', row.id).execute();
        await recordAudit(trx, { action: 'registration.restored', entityType: 'registration', entityId: row.id, eventId: event.id });
    });
    return getRegistrationDetail(row.id);
}

// ── Check-in y entregas ────────────────────────────────────────────────

async function staffSummary(registrationId: number) {
    const d = await getRegistrationDetail(registrationId);
    const pendingCents = d.items.filter(i => i.paymentStatus === 'unpaid').reduce((s, i) => s + i.unitPriceCents, 0);
    return {
        id: d.id, publicCode: d.publicCode, firstName: d.firstName, lastName: d.lastName,
        conference: d.conference, church: d.church ?? (d.churchNameRaw ? { name: d.churchNameRaw } : null),
        status: d.status, paymentStatus: d.paymentStatus, pendingCents,
        items: d.items.map(i => ({ id: i.id, code: i.code, name: i.name, variant: i.variant, paymentStatus: i.paymentStatus, deliveredAt: i.deliveredAt })),
        checkIn: d.checkIn,
    };
}

/** Lo que ve staff al escanear: quién es, qué pidió, qué debe y si ya entró. */
export async function lookupForCheckIn(eventId: number, publicCode: string) {
    const scope = await currentTenantScope();
    const found = await findVisibleByPublicCode(scope, eventId, publicCode);
    if (!found) throw new AppError(404, 'Código no encontrado en este evento');
    return staffSummary(found.row.id);
}

async function doCheckIn(scope: TenantScope, registrationId: number, method: 'qr' | 'manual') {
    const found = await findVisibleRegistration(scope, registrationId);
    if (!found) throw new AppError(404, 'Registro no encontrado');
    const { row, event } = found;
    if (row.status === 'cancelled') throw new AppError(409, 'El registro está cancelado');
    if (!['published', 'closed'].includes(event.status)) throw new AppError(409, 'El evento no está activo');

    // Solo uno gana si dos personas escanean el mismo QR a la vez
    const updated = await db.transaction().execute(async (trx) => {
        const res = await trx.updateTable('registrations')
            .set({ checked_in_at: new Date(), checked_in_by: auth().userId, checked_in_method: method })
            .where('id', '=', row.id).where('checked_in_at', 'is', null).executeTakeFirst();
        if (Number(res.numUpdatedRows) === 0) return false;
        await recordAudit(trx, {
            action: 'registration.checked_in', entityType: 'registration', entityId: row.id, eventId: event.id,
            metadata: { method },
        });
        return true;
    });
    return { result: updated ? 'checked_in' as const : 'already_checked_in' as const, registration: await staffSummary(row.id) };
}

export async function checkInByCode(eventId: number, publicCode: string) {
    const scope = await currentTenantScope();
    const found = await findVisibleByPublicCode(scope, eventId, publicCode);
    if (!found) throw new AppError(404, 'Código no encontrado en este evento');
    return doCheckIn(scope, found.row.id, 'qr');
}

export async function checkInManual(registrationId: number) {
    return doCheckIn(await currentTenantScope(), registrationId, 'manual');
}

export async function undoCheckIn(registrationId: number) {
    const { row, event } = await requireVisible(registrationId);
    if (!row.checked_in_at) throw new AppError(409, 'Este registro no tiene check-in');
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('registrations').set({ checked_in_at: null, checked_in_by: null, checked_in_method: null })
            .where('id', '=', row.id).execute();
        await recordAudit(trx, {
            action: 'registration.check_in_undone', entityType: 'registration', entityId: row.id, eventId: event.id,
            changes: { checkedInAt: { from: new Date(row.checked_in_at!).toISOString(), to: null } },
        });
    });
    return staffSummary(row.id);
}

/** Entregar playera / canjear comida. Solo lo pagado (o que no requiere pago). */
export async function setDelivered(registrationId: number, registrationItemId: number, delivered: boolean) {
    const { row, event } = await requireVisible(registrationId);
    const item = await db.selectFrom('registration_items as ri').innerJoin('form_items as fi', 'fi.id', 'ri.item_id')
        .select(['ri.id', 'ri.payment_status', 'ri.delivered_at', 'fi.code'])
        .where('ri.id', '=', registrationItemId).where('ri.registration_id', '=', row.id).executeTakeFirst();
    if (!item) throw new AppError(404, 'Producto no encontrado en este registro');
    if (delivered === !!item.delivered_at) return staffSummary(row.id);
    if (delivered && !['paid', 'not_required'].includes(item.payment_status)) {
        throw new AppError(409, 'Este producto está pendiente de pago', { reason: 'unpaid' });
    }
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('registration_items')
            .set({ delivered_at: delivered ? new Date() : null, delivered_by: delivered ? auth().userId : null })
            .where('id', '=', item.id).execute();
        await recordAudit(trx, {
            action: delivered ? 'registration.item_delivered' : 'registration.item_delivery_undone',
            entityType: 'registration', entityId: row.id, eventId: event.id, metadata: { item: item.code },
        });
    });
    return staffSummary(row.id);
}
