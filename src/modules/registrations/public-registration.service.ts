/**
 * Registro público: una persona llena el formulario sin sesión.
 *
 *  1. El formulario debe estar abierto (estado, fechas, cupo).
 *  2. Las respuestas se validan contra la versión publicada.
 *  3. Asociación e iglesia deben ser del cliente; "mi iglesia no está" crea
 *     una iglesia pendiente (no aparece en la lista hasta que un admin la
 *     apruebe), o reutiliza la pendiente si alguien ya la escribió igual.
 *  4. Productos con precio congelado; se agregan solos los obligatorios
 *     (cuota de inscripción). Cupo y existencias se revisan con bloqueo para
 *     que dos personas no tomen el último lugar a la vez.
 *  5. Registro + productos + auditoría + correo en cola: todo o nada.
 */
import { ulid } from 'ulidx';
import { Transaction } from 'kysely';
import { db } from '../../db/client';
import type { Database, Locale } from '../../db/types';
import { fromJson, I18nText, toJson } from '../../db/json';
import { recordAudit } from '../../core/audit';
import { getContext } from '../../core/request-context';
import { tenantOrganizationIds } from '../../core/tenant-tree';
import { AppError } from '../../middlewares/errorHandler';
import { allFields } from '../forms/form-schema';
import { AnswerError, validateAnswers } from '../forms/answers';
import { ItemView, loadItems, toSchemaItems } from '../forms/forms.service';
import { availabilityOf, loadPublicForm } from '../public/public.service';
import { chargeableAccount, startCheckout } from '../payments/stripe.service';
import { stripeConfigured } from '../payments/provider';

export interface PublicRegistrationInput {
    answers: Record<string, unknown>;
    locale: Locale;
    paymentMethod?: 'online' | 'offline';
}

export interface PublicRegistrationResult {
    publicCode: string;
    status: 'confirmed' | 'pending_payment';
    paymentStatus: 'not_required' | 'unpaid';
    paymentMethod: 'online' | 'offline' | null;
    /** URL de Stripe Checkout cuando eligió pagar con tarjeta. */
    checkoutUrl: string | null;
    totalCents: number;
    currency: string;
    items: { code: string; name: I18nText; variantCode: string | null; unitPriceCents: number }[];
}

const AVAILABILITY_MESSAGES = {
    not_open_yet: 'El registro todavía no abre',
    closed: 'El registro está cerrado',
    full: 'Ya no hay lugares disponibles',
} as const;

const formErrors = (errors: AnswerError[]) =>
    new AppError(400, 'Revisa los datos del formulario', { errors });

export async function createPublicRegistration(formId: number, input: PublicRegistrationInput): Promise<PublicRegistrationResult> {
    const tenant = getContext()?.tenant;
    if (!tenant) throw new AppError(400, 'Falta indicar el cliente');

    const { form, event, version } = await loadPublicForm(formId);
    const items = await loadItems(formId);

    // ── 1. Respuestas ──────────────────────────────────────────────────
    const result = validateAnswers(version.schema, toSchemaItems(items), input.answers ?? {});
    if (!result.ok) throw formErrors(result.errors);
    const v = result.value;
    const fields = allFields(version.schema);
    const keyOf = (type: string) => fields.find(f => f.type === type)?.key ?? type;

    const itemByCode = new Map(items.map(i => [i.code, i]));
    const toggleKeyOf = (code: string) => fields.find(f => (f.type === 'item_toggle' || f.type === 'item_variant') && f.item === code)?.key ?? code;
    for (const sel of v.items) {
        if (!itemByCode.get(sel.code)?.isActive) {
            throw formErrors([{ field: toggleKeyOf(sel.code), code: 'not_allowed', message: 'Este producto ya no está disponible' }]);
        }
    }

    // ── 2. Asociación (del cliente y del estado elegido) ───────────────
    const tenantIds = await tenantOrganizationIds();
    let conferenceId: number | null = null;
    if (v.location) {
        const conf = await db.selectFrom('organizations as o')
            .innerJoin('organization_states as os', 'os.organization_id', 'o.id')
            .innerJoin('us_states as s', 's.id', 'os.state_id')
            .select('o.id')
            .where('o.id', '=', v.location.conferenceId).where('o.type', '=', 'conference').where('o.status', '=', 'verified')
            .where('s.code', '=', v.location.stateCode)
            .executeTakeFirst();
        if (!conf || !tenantIds.includes(conf.id)) {
            throw formErrors([{ field: keyOf('state_conference_picker'), code: 'invalid_option', message: 'Asociación no válida para ese estado' }]);
        }
        conferenceId = conf.id;
    }

    // ── 3. Productos y totales ─────────────────────────────────────────
    const selected = new Map(v.items.map(s => [s.code, s.variantCode]));
    for (const item of items) {
        if (item.isActive && item.isRequired && !selected.has(item.code)) selected.set(item.code, null);
    }
    const lines = [...selected.entries()].map(([code, variantCode]) => {
        const item = itemByCode.get(code)!;
        const variant = variantCode ? item.variants.find(x => x.code === variantCode) ?? null : null;
        return { item, variant, unitPriceCents: variant?.priceCentsOverride ?? item.priceCents };
    });
    const totalCents = lines.reduce((sum, l) => sum + l.unitPriceCents, 0);

    // ── 4. Pago ────────────────────────────────────────────────────────
    const chargesPayment = !!form.payments_enabled && totalCents > 0;
    let paymentMethod: 'online' | 'offline' | null = null;
    if (chargesPayment) {
        const allowed = [form.allow_online_payment && 'online', form.allow_offline_payment && 'offline'].filter(Boolean) as ('online' | 'offline')[];
        paymentMethod = input.paymentMethod ?? (allowed.length === 1 ? allowed[0] : null);
        if (!paymentMethod) throw new AppError(400, 'Elige cómo vas a pagar', { errors: [{ field: 'paymentMethod', code: 'required', message: 'Campo obligatorio' }] });
        if (!allowed.includes(paymentMethod)) throw new AppError(400, 'Ese método de pago no está disponible para este registro');
        if (paymentMethod === 'online' && !(stripeConfigured() && await chargeableAccount(tenant.id))) {
            throw new AppError(409, 'El pago en línea no está disponible por ahora; elige pagar en efectivo u otro método');
        }
    }
    // Con tarjeta queda "pendiente de pago" (aparta su lugar) hasta que Stripe confirme
    const pendingOnline = paymentMethod === 'online';

    const core = v.core;
    if (!core.first_name || !core.last_name || !core.email) {
        throw formErrors([{ field: 'email', code: 'required', message: 'Faltan nombre, apellidos o correo' }]);
    }
    const fullName = `${core.first_name} ${core.last_name}`;
    const answers: Record<string, unknown> = { ...v.answers };
    if (v.location) answers.state = v.location.stateCode;

    // ── 5. Guardar (con bloqueos para cupo y existencias) ──────────────
    const saved = await db.transaction().execute(async (trx) => {
        // Bloquea el formulario: los registros simultáneos esperan su turno
        const locked = await trx.selectFrom('forms').selectAll().where('id', '=', formId).forUpdate().executeTakeFirstOrThrow();
        const count = await trx.selectFrom('registrations').select(eb => eb.fn.countAll<number>().as('n'))
            .where('form_id', '=', formId).where('deleted_at', 'is', null).where('status', '!=', 'cancelled')
            .executeTakeFirstOrThrow();
        const availability = availabilityOf(locked, event, Number(count.n));
        if (availability !== 'open') throw new AppError(409, AVAILABILITY_MESSAGES[availability], { reason: availability });

        const duplicate = await trx.selectFrom('registrations').select('id')
            .where('event_id', '=', event.id).where('email', '=', core.email!)
            .where('first_name', '=', core.first_name!).where('last_name', '=', core.last_name!)
            .where('deleted_at', 'is', null).where('status', '!=', 'cancelled')
            .executeTakeFirst();
        if (duplicate) throw new AppError(409, 'Ya hay un registro con ese nombre y correo para este evento', { reason: 'already_registered' });

        await checkStock(trx, lines);
        const church = await resolveChurch(trx, v.church, conferenceId, tenantIds, keyOf('church_picker'), fullName);

        const paymentStatus = chargesPayment ? 'unpaid' : 'not_required';
        const publicCode = ulid();
        const registrationId = Number((await trx.insertInto('registrations').values({
            public_code: publicCode, tenant_id: tenant.id, event_id: event.id, form_id: formId, form_version_id: version.id,
            conference_organization_id: conferenceId, church_organization_id: church.id, church_name_raw: church.rawName,
            first_name: core.first_name!, last_name: core.last_name!, email: core.email!, phone: core.phone ?? null,
            birth_date: core.birth_date ?? null, gender: (core.gender as 'male' | 'female' | 'undisclosed' | undefined) ?? null,
            locale: input.locale, answers: toJson(answers), status: pendingOnline ? 'pending_payment' : 'confirmed', payment_status: paymentStatus,
            total_cents: totalCents, paid_cents: 0, checked_in_at: null, checked_in_by: null, checked_in_method: null,
            source: 'public_form', deleted_at: null, deleted_by: null,
        }).executeTakeFirstOrThrow()).insertId);

        for (const line of lines) {
            await trx.insertInto('registration_items').values({
                registration_id: registrationId, item_id: line.item.id, variant_id: line.variant?.id ?? null, quantity: 1,
                unit_price_cents: line.unitPriceCents, payment_status: chargesPayment && line.unitPriceCents > 0 ? 'unpaid' : 'not_required',
                delivered_at: null, delivered_by: null,
            }).execute();
        }

        await recordAudit(trx, {
            action: 'registration.created', entityType: 'registration', entityId: registrationId, eventId: event.id,
            actorType: 'participant', actorUserId: null, actorName: fullName,
            metadata: {
                formId, formVersion: version.version, totalCents, paymentMethod,
                items: lines.map(l => ({ code: l.item.code, variant: l.variant?.code ?? null, priceCents: l.unitPriceCents })),
                newChurch: church.created ? church.rawName : undefined,
            },
        });

        // Con tarjeta, la confirmación se manda cuando Stripe avisa que se pagó
        if (!pendingOnline) {
            await trx.insertInto('email_messages').values({
                tenant_id: tenant.id, registration_id: registrationId, template: 'registration_confirmation',
                locale: input.locale, to_email: core.email!, status: 'queued', attempts: 0,
                provider_message_id: null, last_error: null, sent_at: null,
            }).execute();
        }

        return { publicCode, paymentStatus, registrationId };
    });

    let checkoutUrl: string | null = null;
    if (pendingOnline) {
        try {
            checkoutUrl = (await startCheckout(saved.registrationId)).url;
        } catch (err) {
            // El registro queda apartado; puede reintentar el pago con su código
            throw new AppError(502, 'Tu registro quedó guardado, pero no pudimos abrir el pago. Intenta pagar de nuevo.', {
                reason: 'checkout_failed', publicCode: saved.publicCode,
            });
        }
    }

    return {
        publicCode: saved.publicCode,
        status: pendingOnline ? 'pending_payment' : 'confirmed',
        paymentStatus: saved.paymentStatus as 'not_required' | 'unpaid',
        paymentMethod,
        checkoutUrl,
        totalCents,
        currency: form.currency,
        items: lines.map(l => ({ code: l.item.code, name: l.item.name, variantCode: l.variant?.code ?? null, unitPriceCents: l.unitPriceCents })),
    };
}

/** Pagar con tarjeta después (sesión vencida o registro hecho "en efectivo"). */
export async function retryCheckoutByCode(publicCode: string) {
    const tenant = getContext()?.tenant;
    if (!tenant) throw new AppError(400, 'Falta indicar el cliente');
    const r = await db.selectFrom('registrations').select('id')
        .where('public_code', '=', publicCode.toUpperCase()).where('tenant_id', '=', tenant.id).where('deleted_at', 'is', null)
        .executeTakeFirst();
    if (!r) throw new AppError(404, 'Registro no encontrado');
    return { checkoutUrl: (await startCheckout(r.id)).url };
}

/** Revisa existencias de las variantes con límite, bloqueándolas mientras tanto. */
async function checkStock(trx: Transaction<Database>, lines: { item: ItemView; variant: ItemView['variants'][number] | null }[]) {
    for (const line of lines) {
        if (!line.variant || line.variant.stock === null) continue;
        await trx.selectFrom('form_item_variants').select('id').where('id', '=', line.variant.id).forUpdate().execute();
        const sold = await trx.selectFrom('registration_items as ri')
            .innerJoin('registrations as r', 'r.id', 'ri.registration_id')
            .select(eb => eb.fn.sum<number>('ri.quantity').as('n'))
            .where('ri.variant_id', '=', line.variant.id).where('r.deleted_at', 'is', null).where('r.status', '!=', 'cancelled')
            .executeTakeFirst();
        if (Number(sold?.n ?? 0) >= line.variant.stock) {
            throw new AppError(409, `Se agotó: ${line.item.name.es} ${line.variant.code}`, { reason: 'sold_out', item: line.item.code, variant: line.variant.code });
        }
    }
}

/**
 * Iglesia elegida o escrita. Una iglesia fusionada se redirige a la
 * correcta; una escrita a mano se busca primero (sin importar acentos ni
 * mayúsculas) y si no existe se crea como pendiente.
 */
async function resolveChurch(
    trx: Transaction<Database>,
    choice: { id: number } | { newName: string } | null,
    conferenceId: number | null,
    tenantIds: number[],
    fieldKey: string,
    participantName: string
): Promise<{ id: number | null; rawName: string | null; created: boolean }> {
    if (!choice) return { id: null, rawName: null, created: false };
    const invalid = () => new AppError(400, 'Revisa los datos del formulario', {
        errors: [{ field: fieldKey, code: 'invalid_option', message: 'Iglesia no válida para esa asociación' }],
    });

    if ('id' in choice) {
        let church = await trx.selectFrom('organizations').select(['id', 'name', 'parent_id', 'status', 'merged_into_id', 'type'])
            .where('id', '=', choice.id).executeTakeFirst();
        if (church?.status === 'merged' && church.merged_into_id) {
            church = await trx.selectFrom('organizations').select(['id', 'name', 'parent_id', 'status', 'merged_into_id', 'type'])
                .where('id', '=', church.merged_into_id).executeTakeFirst();
        }
        if (!church || church.type !== 'church' || church.status !== 'verified' || !tenantIds.includes(church.id)) throw invalid();
        if (conferenceId !== null && church.parent_id !== conferenceId) throw invalid();
        return { id: church.id, rawName: church.name, created: false };
    }

    if (conferenceId === null) return { id: null, rawName: choice.newName, created: false };
    const existing = await trx.selectFrom('organizations').select(['id', 'status', 'merged_into_id'])
        .where('parent_id', '=', conferenceId).where('type', '=', 'church').where('name', '=', choice.newName)
        .executeTakeFirst();
    if (existing) {
        const id = existing.status === 'merged' && existing.merged_into_id ? existing.merged_into_id : existing.id;
        return { id: existing.status === 'inactive' ? null : id, rawName: choice.newName, created: false };
    }
    const id = Number((await trx.insertInto('organizations').values({
        parent_id: conferenceId, type: 'church', name: choice.newName, short_name: null, city: null, state_id: null,
        status: 'pending', source: 'registration', merged_into_id: null,
    }).executeTakeFirstOrThrow()).insertId);
    await recordAudit(trx, {
        action: 'church.suggested', entityType: 'organization', entityId: id,
        actorType: 'participant', actorUserId: null, actorName: participantName,
        metadata: { name: choice.newName, conferenceId },
    });
    return { id, rawName: choice.newName, created: true };
}

/** Página de confirmación (con el código del QR): sin datos de contacto. */
export async function getPublicRegistration(publicCode: string) {
    const tenant = getContext()?.tenant;
    if (!tenant) throw new AppError(400, 'Falta indicar el cliente');
    const r = await db.selectFrom('registrations as r')
        .innerJoin('events as e', 'e.id', 'r.event_id')
        .innerJoin('forms as f', 'f.id', 'r.form_id')
        .select([
            'r.id', 'r.public_code', 'r.first_name', 'r.status', 'r.payment_status', 'r.total_cents', 'r.paid_cents',
            'r.checked_in_at', 'r.locale', 'r.created_at',
            'e.name as event_name', 'e.starts_at', 'e.ends_at', 'e.timezone', 'e.venue', 'f.settings', 'f.currency',
        ])
        .where('r.public_code', '=', publicCode).where('r.tenant_id', '=', tenant.id).where('r.deleted_at', 'is', null)
        .executeTakeFirst();
    if (!r) throw new AppError(404, 'Registro no encontrado');

    const lines = await db.selectFrom('registration_items as ri')
        .innerJoin('form_items as fi', 'fi.id', 'ri.item_id')
        .leftJoin('form_item_variants as v', 'v.id', 'ri.variant_id')
        .select(['fi.code', 'fi.name', 'v.code as variant_code', 'v.label as variant_label', 'ri.unit_price_cents', 'ri.payment_status'])
        .where('ri.registration_id', '=', r.id).execute();

    return {
        publicCode: r.public_code,
        firstName: r.first_name,
        status: r.status,
        paymentStatus: r.payment_status,
        totalCents: r.total_cents,
        paidCents: r.paid_cents,
        currency: r.currency,
        checkedIn: !!r.checked_in_at,
        locale: r.locale,
        createdAt: new Date(r.created_at),
        event: {
            name: fromJson<I18nText>(r.event_name), startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at),
            timezone: r.timezone, venue: r.venue,
        },
        confirmationMessage: fromJson<{ confirmationMessage?: I18nText }>(r.settings, {}).confirmationMessage ?? null,
        items: lines.map(l => ({
            code: l.code, name: fromJson<I18nText>(l.name),
            variant: l.variant_code ? { code: l.variant_code, label: fromJson<I18nText>(l.variant_label) } : null,
            unitPriceCents: l.unit_price_cents, paymentStatus: l.payment_status,
        })),
    };
}
