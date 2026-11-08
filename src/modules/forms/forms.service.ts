import { db } from '../../db/client';
import { fromJson, I18nText, toJson } from '../../db/json';
import { diff, recordAudit } from '../../core/audit';
import { getContext } from '../../core/request-context';
import { AppError } from '../../middlewares/errorHandler';
import { getEventDetail, getManageableEvent } from '../events/events.service';
import { compareSchemas, FormSchema, formSchemaSchema, SchemaItem, validateFormSchema } from './form-schema';
import { AnswersResult, validateAnswers } from './answers';

export type FormStatus = 'draft' | 'open' | 'closed';

const FORM_TRANSITIONS: Record<FormStatus, FormStatus[]> = {
    draft: ['open'],
    open: ['closed'],
    closed: ['open'],
};

export interface FormSettings {
    confirmationMessage?: I18nText;
}

export interface VariantView {
    id: number;
    code: string;
    label: I18nText;
    priceCentsOverride: number | null;
    stock: number | null;
    sortOrder: number;
    isActive: boolean;
}

export interface ItemView {
    id: number;
    code: string;
    kind: 'registration_fee' | 'product';
    name: I18nText;
    description: I18nText | null;
    priceCents: number;
    isRequired: boolean;
    maxPerRegistration: number;
    sortOrder: number;
    isActive: boolean;
    variants: VariantView[];
}

const tenantId = () => {
    const t = getContext()?.tenant;
    if (!t) throw new AppError(400, 'Falta indicar el cliente');
    return t.id;
};

/** Formulario del cliente; con manage exige poder administrar el evento. */
async function loadForm(formId: number, opts: { manage: boolean }) {
    const row = await db.selectFrom('forms').selectAll()
        .where('id', '=', formId).where('tenant_id', '=', tenantId()).executeTakeFirst();
    if (!row) throw new AppError(404, 'Formulario no encontrado');
    const event = opts.manage ? await getManageableEvent(row.event_id) : await getEventDetail(row.event_id);
    return { form: row, event };
}

export async function loadItems(formId: number): Promise<ItemView[]> {
    const items = await db.selectFrom('form_items').selectAll().where('form_id', '=', formId)
        .orderBy('sort_order').orderBy('id').execute();
    const variants = items.length
        ? await db.selectFrom('form_item_variants').selectAll().where('item_id', 'in', items.map(i => i.id))
            .orderBy('sort_order').orderBy('id').execute()
        : [];
    return items.map(i => ({
        id: i.id, code: i.code, kind: i.kind, name: fromJson<I18nText>(i.name),
        description: fromJson<I18nText | null>(i.description, null), priceCents: i.price_cents,
        isRequired: !!i.is_required, maxPerRegistration: i.max_per_registration, sortOrder: i.sort_order,
        isActive: !!i.is_active,
        variants: variants.filter(v => v.item_id === i.id).map(v => ({
            id: v.id, code: v.code, label: fromJson<I18nText>(v.label), priceCentsOverride: v.price_cents_override,
            stock: v.stock, sortOrder: v.sort_order, isActive: !!v.is_active,
        })),
    }));
}

export const toSchemaItems = (items: ItemView[]): SchemaItem[] =>
    items.map(i => ({ code: i.code, isActive: i.isActive, variants: i.variants.map(v => ({ code: v.code, isActive: v.isActive })) }));

async function versionsOf(formId: number) {
    return db.selectFrom('form_versions')
        .select(['id', 'version', 'status', 'published_at', 'published_by', 'created_at', 'schema_json',
            eb => eb.selectFrom('registrations').select(eb2 => eb2.fn.countAll<number>().as('n'))
                .whereRef('registrations.form_version_id', '=', 'form_versions.id').as('registrations')])
        .where('form_id', '=', formId).orderBy('version', 'desc').execute();
}

const parseSchema = (raw: unknown): FormSchema => formSchemaSchema.parse(fromJson(raw));

// ── Lectura ────────────────────────────────────────────────────────────

export async function listForms(eventId: number) {
    await getEventDetail(eventId);
    const rows = await db.selectFrom('forms as f')
        .leftJoin('form_versions as v', 'v.id', 'f.published_version_id')
        .select(['f.id', 'f.title', 'f.status', 'f.opens_at', 'f.closes_at', 'f.payments_enabled', 'v.version as published_version',
            eb => eb.selectFrom('registrations').select(eb2 => eb2.fn.countAll<number>().as('n'))
                .whereRef('registrations.form_id', '=', 'f.id').where('registrations.deleted_at', 'is', null).as('registrations')])
        .where('f.event_id', '=', eventId).where('f.tenant_id', '=', tenantId()).orderBy('f.id').execute();
    return rows.map(r => ({
        id: r.id, title: fromJson<I18nText>(r.title), status: r.status,
        opensAt: r.opens_at ? new Date(r.opens_at) : null, closesAt: r.closes_at ? new Date(r.closes_at) : null,
        paymentsEnabled: !!r.payments_enabled, publishedVersion: r.published_version ?? null,
        registrations: Number(r.registrations ?? 0),
    }));
}

export async function getForm(formId: number) {
    const { form } = await loadForm(formId, { manage: false });
    const [items, versions] = await Promise.all([loadItems(formId), versionsOf(formId)]);
    const published = versions.find(v => v.id === form.published_version_id);
    const draft = versions.find(v => v.status === 'draft');
    return {
        id: form.id,
        eventId: form.event_id,
        title: fromJson<I18nText>(form.title),
        status: form.status as FormStatus,
        opensAt: form.opens_at ? new Date(form.opens_at) : null,
        closesAt: form.closes_at ? new Date(form.closes_at) : null,
        maxRegistrations: form.max_registrations,
        payments: {
            enabled: !!form.payments_enabled,
            online: !!form.allow_online_payment,
            offline: !!form.allow_offline_payment,
            currency: form.currency,
        },
        settings: fromJson<FormSettings>(form.settings, {}),
        items,
        publishedVersion: published
            ? { id: published.id, version: published.version, publishedAt: published.published_at, schema: parseSchema(published.schema_json) }
            : null,
        draftVersion: draft ? { id: draft.id, version: draft.version, schema: parseSchema(draft.schema_json) } : null,
    };
}

export async function listVersions(formId: number) {
    await loadForm(formId, { manage: false });
    const versions = await versionsOf(formId);
    return versions.map(v => ({
        id: v.id, version: v.version, status: v.status,
        publishedAt: v.published_at ? new Date(v.published_at) : null, publishedBy: v.published_by,
        registrations: Number(v.registrations ?? 0),
    }));
}

export async function getVersion(formId: number, versionId: number) {
    await loadForm(formId, { manage: false });
    const v = (await versionsOf(formId)).find(x => x.id === versionId);
    if (!v) throw new AppError(404, 'Versión no encontrada');
    return { id: v.id, version: v.version, status: v.status, schema: parseSchema(v.schema_json) };
}

// ── Formulario y configuración ─────────────────────────────────────────

export async function createForm(eventId: number, input: { title: I18nText }) {
    await getManageableEvent(eventId);
    const formId = await db.transaction().execute(async (trx) => {
        const id = Number((await trx.insertInto('forms').values({
            tenant_id: tenantId(), event_id: eventId, title: toJson(input.title), status: 'draft',
            published_version_id: null, opens_at: null, closes_at: null, max_registrations: null,
            payments_enabled: 0, allow_online_payment: 0, allow_offline_payment: 1, currency: 'usd',
            settings: null, created_by: getContext()!.auth!.userId,
        }).executeTakeFirstOrThrow()).insertId);
        await trx.insertInto('form_versions').values({
            form_id: id, version: 1, schema_json: toJson({ steps: [] }), status: 'draft', published_at: null, published_by: null,
        }).execute();
        await recordAudit(trx, { action: 'form.created', entityType: 'form', entityId: id, eventId, metadata: { title: input.title } });
        return id;
    });
    return getForm(formId);
}

export interface FormUpdate {
    title?: I18nText;
    opensAt?: Date | null;
    closesAt?: Date | null;
    maxRegistrations?: number | null;
    paymentsEnabled?: boolean;
    allowOnlinePayment?: boolean;
    allowOfflinePayment?: boolean;
    settings?: FormSettings;
}

export async function updateForm(formId: number, input: FormUpdate) {
    const { form, event } = await loadForm(formId, { manage: true });
    const current = await getForm(formId);

    const opensAt = input.opensAt !== undefined ? input.opensAt : current.opensAt;
    const closesAt = input.closesAt !== undefined ? input.closesAt : current.closesAt;
    if (opensAt && closesAt && closesAt.getTime() <= opensAt.getTime()) {
        throw new AppError(400, 'El cierre del registro debe ser posterior a la apertura');
    }
    const enabled = input.paymentsEnabled ?? current.payments.enabled;
    const online = input.allowOnlinePayment ?? current.payments.online;
    const offline = input.allowOfflinePayment ?? current.payments.offline;
    if (enabled && !online && !offline) {
        throw new AppError(400, 'Con pagos activados, permite al menos pago en línea o pago en efectivo/otro');
    }
    if (enabled && online && !current.payments.online) {
        const stripe = await db.selectFrom('tenant_payment_accounts').select('id')
            .where('tenant_id', '=', form.tenant_id).where('provider', '=', 'stripe').where('charges_enabled', '=', 1)
            .executeTakeFirst();
        if (!stripe) throw new AppError(409, 'Para cobrar en línea primero conecta la cuenta de Stripe del cliente');
    }

    const changes = diff(
        {
            title: current.title, opensAt: current.opensAt, closesAt: current.closesAt,
            maxRegistrations: current.maxRegistrations, paymentsEnabled: current.payments.enabled,
            allowOnlinePayment: current.payments.online, allowOfflinePayment: current.payments.offline,
            settings: current.settings,
        },
        input as Record<string, unknown>
    );
    if (!changes) return current;

    await db.transaction().execute(async (trx) => {
        await trx.updateTable('forms').set({
            ...(input.title !== undefined ? { title: toJson(input.title) } : {}),
            ...(input.opensAt !== undefined ? { opens_at: input.opensAt } : {}),
            ...(input.closesAt !== undefined ? { closes_at: input.closesAt } : {}),
            ...(input.maxRegistrations !== undefined ? { max_registrations: input.maxRegistrations } : {}),
            ...(input.paymentsEnabled !== undefined ? { payments_enabled: input.paymentsEnabled ? 1 : 0 } : {}),
            ...(input.allowOnlinePayment !== undefined ? { allow_online_payment: input.allowOnlinePayment ? 1 : 0 } : {}),
            ...(input.allowOfflinePayment !== undefined ? { allow_offline_payment: input.allowOfflinePayment ? 1 : 0 } : {}),
            ...(input.settings !== undefined ? { settings: toJson(input.settings) } : {}),
        }).where('id', '=', formId).execute();
        await recordAudit(trx, { action: 'form.updated', entityType: 'form', entityId: formId, eventId: event.id, changes });
    });
    return getForm(formId);
}

export async function changeFormStatus(formId: number, status: FormStatus) {
    const { form, event } = await loadForm(formId, { manage: true });
    const from = form.status as FormStatus;
    if (from === status) return getForm(formId);
    if (!FORM_TRANSITIONS[from].includes(status)) throw new AppError(409, `No se puede pasar de "${from}" a "${status}"`);
    if (status === 'open') {
        if (!form.published_version_id) throw new AppError(409, 'Publica una versión del formulario antes de abrir el registro');
        if (event.status !== 'published') throw new AppError(409, 'Publica el evento antes de abrir el registro');
    }
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('forms').set({ status }).where('id', '=', formId).execute();
        await recordAudit(trx, {
            action: 'form.status_changed', entityType: 'form', entityId: formId, eventId: event.id,
            changes: { status: { from, to: status } },
        });
    });
    return getForm(formId);
}

// ── Borrador y publicación ─────────────────────────────────────────────

const schemaError = (issues: { path: string; message: string }[]) =>
    new AppError(400, 'El formulario tiene errores', { issues });

/**
 * Guarda el borrador. Puede estar incompleto: solo se rechaza si la
 * estructura está mal. Devuelve lo que falta para poder publicar.
 */
export async function saveDraft(formId: number, rawSchema: unknown) {
    const { event } = await loadForm(formId, { manage: true });
    const parsed = formSchemaSchema.safeParse(rawSchema);
    if (!parsed.success) {
        throw schemaError(parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })));
    }
    const schema = parsed.data;
    const items = toSchemaItems(await loadItems(formId));
    const issues = validateFormSchema(schema, items, { forPublish: false });
    if (issues.length) throw schemaError(issues);

    const versionId = await db.transaction().execute(async (trx) => {
        const draft = await trx.selectFrom('form_versions').select(['id', 'version'])
            .where('form_id', '=', formId).where('status', '=', 'draft').executeTakeFirst();
        if (draft) {
            await trx.updateTable('form_versions').set({ schema_json: toJson(schema) }).where('id', '=', draft.id).execute();
            return draft.id;
        }
        const last = await trx.selectFrom('form_versions').select(eb => eb.fn.max('version').as('v'))
            .where('form_id', '=', formId).executeTakeFirst();
        const id = Number((await trx.insertInto('form_versions').values({
            form_id: formId, version: Number(last?.v ?? 0) + 1, schema_json: toJson(schema), status: 'draft',
            published_at: null, published_by: null,
        }).executeTakeFirstOrThrow()).insertId);
        await recordAudit(trx, { action: 'form.draft_created', entityType: 'form', entityId: formId, eventId: event.id });
        return id;
    });

    const v = await db.selectFrom('form_versions').select('version').where('id', '=', versionId).executeTakeFirstOrThrow();
    return {
        versionId, version: v.version,
        publishIssues: validateFormSchema(schema, items, { forPublish: true }),
    };
}

/** Publica el borrador: queda inmutable y los nuevos registros lo usan. */
export async function publishDraft(formId: number) {
    const { form, event } = await loadForm(formId, { manage: true });
    const versions = await versionsOf(formId);
    const draft = versions.find(v => v.status === 'draft');
    if (!draft) throw new AppError(409, 'No hay cambios por publicar');

    const schema = parseSchema(draft.schema_json);
    const issues = validateFormSchema(schema, toSchemaItems(await loadItems(formId)), { forPublish: true });
    if (issues.length) throw schemaError(issues);

    const previous = versions.find(v => v.id === form.published_version_id);
    const summary = compareSchemas(previous ? parseSchema(previous.schema_json) : null, schema);

    await db.transaction().execute(async (trx) => {
        if (previous) {
            await trx.updateTable('form_versions').set({ status: 'superseded' }).where('id', '=', previous.id).execute();
        }
        await trx.updateTable('form_versions').set({
            status: 'published', published_at: new Date(), published_by: getContext()!.auth!.userId,
        }).where('id', '=', draft.id).execute();
        await trx.updateTable('forms').set({ published_version_id: draft.id }).where('id', '=', formId).execute();
        await recordAudit(trx, {
            action: 'form.version_published', entityType: 'form', entityId: formId, eventId: event.id,
            changes: { published_version: { from: previous?.version ?? null, to: draft.version } },
            metadata: { fields: summary },
        });
    });
    return getForm(formId);
}

/** Prueba de respuestas contra el borrador o la versión publicada (vista previa del constructor). */
export async function previewAnswers(formId: number, which: 'draft' | 'published', answers: Record<string, unknown>): Promise<AnswersResult> {
    const form = await getForm(formId);
    const version = which === 'draft' ? form.draftVersion : form.publishedVersion;
    if (!version) throw new AppError(404, which === 'draft' ? 'No hay borrador' : 'No hay versión publicada');
    return validateAnswers(version.schema, toSchemaItems(form.items), answers);
}

// ── Productos ──────────────────────────────────────────────────────────

export interface VariantInput {
    code: string;
    label: I18nText;
    priceCentsOverride?: number | null;
    stock?: number | null;
    sortOrder?: number;
    isActive?: boolean;
}

export interface ItemInput {
    code: string;
    kind: 'registration_fee' | 'product';
    name: I18nText;
    description?: I18nText | null;
    priceCents: number;
    isRequired?: boolean;
    sortOrder?: number;
    variants?: VariantInput[];
}

async function assertSingleRegistrationFee(formId: number, exceptItemId?: number) {
    let q = db.selectFrom('form_items').select('id')
        .where('form_id', '=', formId).where('kind', '=', 'registration_fee').where('is_active', '=', 1);
    if (exceptItemId) q = q.where('id', '!=', exceptItemId);
    if (await q.executeTakeFirst()) throw new AppError(409, 'El formulario ya tiene una cuota de inscripción activa');
}

const duplicateCode = (err: any, what: string) => err?.code === 'ER_DUP_ENTRY' ? new AppError(409, `Ya existe ${what} con ese código`) : err;

export async function createItem(formId: number, input: ItemInput): Promise<ItemView> {
    const { event } = await loadForm(formId, { manage: true });
    if (input.kind === 'registration_fee') await assertSingleRegistrationFee(formId);

    const itemId = await db.transaction().execute(async (trx) => {
        const id = Number((await trx.insertInto('form_items').values({
            tenant_id: tenantId(), form_id: formId, code: input.code, kind: input.kind, name: toJson(input.name),
            description: input.description ? toJson(input.description) : null, price_cents: input.priceCents,
            // La cuota de inscripción siempre es obligatoria
            is_required: input.kind === 'registration_fee' || input.isRequired ? 1 : 0,
            max_per_registration: 1, sort_order: input.sortOrder ?? 0, is_active: 1,
        }).executeTakeFirstOrThrow().catch(err => { throw duplicateCode(err, 'un producto'); })).insertId);
        for (const [i, v] of (input.variants ?? []).entries()) {
            await trx.insertInto('form_item_variants').values({
                item_id: id, code: v.code, label: toJson(v.label), price_cents_override: v.priceCentsOverride ?? null,
                stock: v.stock ?? null, sort_order: v.sortOrder ?? i + 1, is_active: v.isActive === false ? 0 : 1,
            }).execute().catch(err => { throw duplicateCode(err, 'una variante'); });
        }
        await recordAudit(trx, {
            action: 'form.item_created', entityType: 'form_item', entityId: id, eventId: event.id,
            metadata: { formId, code: input.code, kind: input.kind, priceCents: input.priceCents, variants: input.variants?.map(v => v.code) ?? [] },
        });
        return id;
    });
    return (await loadItems(formId)).find(i => i.id === itemId)!;
}

async function getItem(formId: number, itemId: number): Promise<ItemView> {
    const item = (await loadItems(formId)).find(i => i.id === itemId);
    if (!item) throw new AppError(404, 'Producto no encontrado');
    return item;
}

export type ItemUpdate = Partial<Pick<ItemInput, 'name' | 'description' | 'priceCents' | 'isRequired' | 'sortOrder'>> & { isActive?: boolean };

/** El código y el tipo no cambian; el precio sí (los registros guardan el precio con que se registraron). */
export async function updateItem(formId: number, itemId: number, input: ItemUpdate): Promise<ItemView> {
    const { event } = await loadForm(formId, { manage: true });
    const before = await getItem(formId, itemId);
    if (before.kind === 'registration_fee' && input.isActive === true && !before.isActive) {
        await assertSingleRegistrationFee(formId, itemId);
    }
    if (before.kind === 'registration_fee' && input.isRequired === false) {
        throw new AppError(400, 'La cuota de inscripción siempre es obligatoria');
    }
    const changes = diff(before as unknown as Record<string, unknown>, input as Record<string, unknown>);
    if (!changes) return before;

    await db.transaction().execute(async (trx) => {
        await trx.updateTable('form_items').set({
            ...(input.name !== undefined ? { name: toJson(input.name) } : {}),
            ...(input.description !== undefined ? { description: input.description ? toJson(input.description) : null } : {}),
            ...(input.priceCents !== undefined ? { price_cents: input.priceCents } : {}),
            ...(input.isRequired !== undefined ? { is_required: input.isRequired ? 1 : 0 } : {}),
            ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
            ...(input.isActive !== undefined ? { is_active: input.isActive ? 1 : 0 } : {}),
        }).where('id', '=', itemId).execute();
        await recordAudit(trx, {
            action: 'form.item_updated', entityType: 'form_item', entityId: itemId, eventId: event.id,
            changes, metadata: { formId, code: before.code },
        });
    });
    return getItem(formId, itemId);
}

/**
 * Reemplaza las variantes (tallas) por código: crea las nuevas, actualiza
 * las existentes y desactiva las que ya no vienen (no se borran: puede haber
 * registros que las usan).
 */
export async function setVariants(formId: number, itemId: number, variants: VariantInput[]): Promise<ItemView> {
    const { event } = await loadForm(formId, { manage: true });
    const item = await getItem(formId, itemId);
    const codes = variants.map(v => v.code);
    if (new Set(codes).size !== codes.length) throw new AppError(400, 'Hay variantes con el mismo código');

    const existing = new Map(item.variants.map(v => [v.code, v]));
    const summary = { added: [] as string[], updated: [] as string[], deactivated: [] as string[] };

    await db.transaction().execute(async (trx) => {
        for (const [i, v] of variants.entries()) {
            const values = {
                label: toJson(v.label), price_cents_override: v.priceCentsOverride ?? null, stock: v.stock ?? null,
                sort_order: v.sortOrder ?? i + 1, is_active: v.isActive === false ? 0 : 1,
            };
            const prev = existing.get(v.code);
            if (prev) {
                const changed = diff(
                    { label: prev.label, priceCentsOverride: prev.priceCentsOverride, stock: prev.stock, sortOrder: prev.sortOrder, isActive: prev.isActive },
                    { label: v.label, priceCentsOverride: v.priceCentsOverride ?? null, stock: v.stock ?? null, sortOrder: v.sortOrder ?? i + 1, isActive: v.isActive !== false }
                );
                if (changed) {
                    await trx.updateTable('form_item_variants').set(values).where('id', '=', prev.id).execute();
                    summary.updated.push(v.code);
                }
            } else {
                await trx.insertInto('form_item_variants').values({ item_id: itemId, code: v.code, ...values }).execute();
                summary.added.push(v.code);
            }
        }
        for (const prev of item.variants) {
            if (!codes.includes(prev.code) && prev.isActive) {
                await trx.updateTable('form_item_variants').set({ is_active: 0 }).where('id', '=', prev.id).execute();
                summary.deactivated.push(prev.code);
            }
        }
        if (summary.added.length || summary.updated.length || summary.deactivated.length) {
            await recordAudit(trx, {
                action: 'form.item_variants_updated', entityType: 'form_item', entityId: itemId, eventId: event.id,
                metadata: { formId, code: item.code, ...summary },
            });
        }
    });
    return getItem(formId, itemId);
}
