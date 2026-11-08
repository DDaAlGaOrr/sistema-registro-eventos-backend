/**
 * Valida las respuestas de una persona contra la versión del formulario.
 *
 * - Recorre los campos en orden; un campo oculto (visible_when no se cumple)
 *   se ignora aunque venga en el body, y no se exige aunque sea obligatorio.
 * - Separa lo que va a columnas (maps_to), a selectores de sistema
 *   (asociación, iglesia), a productos y al JSON `answers`.
 * - No consulta la BD: que la asociación/iglesia/talla existan y sean del
 *   cliente lo revisa el registro (Paso 6).
 */
import type { CoreColumn, FormField, FormSchema, SchemaItem } from './form-schema';
import { allFields } from './form-schema';

export type AnswerErrorCode =
    | 'required' | 'invalid' | 'too_short' | 'too_long' | 'out_of_range'
    | 'invalid_option' | 'not_allowed' | 'must_accept';

export interface AnswerError {
    field: string;
    code: AnswerErrorCode;
    message: string;
}

export interface ValidatedAnswers {
    core: Partial<Record<CoreColumn, string>>;
    /** Respuestas que no van a columnas (se guardan en registrations.answers). */
    answers: Record<string, unknown>;
    location: { stateCode: string; conferenceId: number } | null;
    church: { id: number } | { newName: string } | null;
    items: { code: string; variantCode: string | null }[];
}

export type AnswersResult = { ok: true; value: ValidatedAnswers } | { ok: false; errors: AnswerError[] };

const MESSAGES: Record<AnswerErrorCode, string> = {
    required: 'Campo obligatorio',
    invalid: 'Valor inválido',
    too_short: 'Muy corto',
    too_long: 'Muy largo',
    out_of_range: 'Fuera del rango permitido',
    invalid_option: 'Opción inválida',
    not_allowed: 'No permitido',
    must_accept: 'Debes aceptar para continuar',
};

class FieldError extends Error {
    constructor(public code: AnswerErrorCode, message?: string) { super(message ?? MESSAGES[code]); }
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Busca la opción por valor exacto o por su texto ("true" → true, "3" → 3). */
function matchOption(field: FormField & { options: { value: unknown }[] }, raw: unknown) {
    const found = field.options.find(o => o.value === raw || String(o.value) === String(raw));
    if (!found) throw new FieldError('invalid_option');
    return found.value;
}

const isValidDate = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Convierte y revisa un valor ya presente (no vacío). */
function parseValue(field: FormField, raw: unknown, items: Map<string, SchemaItem>): unknown {
    switch (field.type) {
        case 'text':
        case 'textarea': {
            if (typeof raw !== 'string' && typeof raw !== 'number') throw new FieldError('invalid');
            const v = String(raw).trim();
            if (v.length > field.max_length) throw new FieldError('too_long');
            if (field.type === 'text' && field.min_length !== undefined && v.length < field.min_length) throw new FieldError('too_short');
            return v;
        }
        case 'email': {
            const v = String(raw).trim().toLowerCase();
            if (v.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw new FieldError('invalid', 'Correo inválido');
            return v;
        }
        case 'phone': {
            const v = String(raw).trim();
            const digits = v.replace(/\D/g, '');
            if (!/^[+\d\s().-]+$/.test(v) || digits.length < 7 || digits.length > 15 || v.length > 30) {
                throw new FieldError('invalid', 'Teléfono inválido');
            }
            return v;
        }
        case 'number': {
            const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
            if (!Number.isFinite(n)) throw new FieldError('invalid');
            if (field.integer && !Number.isInteger(n)) throw new FieldError('invalid', 'Debe ser un número entero');
            if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) throw new FieldError('out_of_range');
            return n;
        }
        case 'date': {
            const v = String(raw).trim().slice(0, 10);
            if (!isValidDate(v)) throw new FieldError('invalid', 'Fecha inválida');
            if ((field.min && v < field.min) || (field.max && v > field.max)) throw new FieldError('out_of_range');
            if (field.maps_to === 'birth_date' && v > new Date().toISOString().slice(0, 10)) throw new FieldError('out_of_range', 'La fecha no puede ser futura');
            return v;
        }
        case 'checkbox':
        case 'consent':
        case 'item_toggle': {
            if (typeof raw === 'boolean') return raw;
            if (raw === 'true') return true;
            if (raw === 'false') return false;
            throw new FieldError('invalid');
        }
        case 'radio':
        case 'select':
            return matchOption(field, raw);
        case 'checkbox_group': {
            if (!Array.isArray(raw)) throw new FieldError('invalid');
            const values = raw.map(r => matchOption(field, r));
            if (new Set(values.map(v => JSON.stringify(v))).size !== values.length) throw new FieldError('invalid', 'Opciones repetidas');
            if (field.min_selected !== undefined && values.length < field.min_selected) throw new FieldError('too_short', `Elige al menos ${field.min_selected}`);
            if (field.max_selected !== undefined && values.length > field.max_selected) throw new FieldError('too_long', `Elige máximo ${field.max_selected}`);
            return values;
        }
        case 'state_conference_picker': {
            const v = raw as { state?: unknown; conference_id?: unknown };
            const state = typeof v?.state === 'string' ? v.state.trim().toUpperCase() : '';
            const conferenceId = Number(v?.conference_id);
            if (!/^[A-Z]{2}$/.test(state) || !Number.isInteger(conferenceId) || conferenceId <= 0) throw new FieldError('invalid');
            return { stateCode: state, conferenceId };
        }
        case 'church_picker': {
            const v = raw as { church_id?: unknown; new_name?: unknown };
            if (v?.church_id !== undefined && v?.church_id !== null) {
                const id = Number(v.church_id);
                if (!Number.isInteger(id) || id <= 0) throw new FieldError('invalid');
                return { id };
            }
            if (typeof v?.new_name === 'string' && v.new_name.trim()) {
                if (!field.allow_new) throw new FieldError('not_allowed', 'Elige una iglesia de la lista');
                const name = v.new_name.trim().replace(/\s+/g, ' ');
                if (name.length < 2) throw new FieldError('too_short');
                if (name.length > 200) throw new FieldError('too_long');
                return { newName: name };
            }
            throw new FieldError('invalid');
        }
        case 'city_picker': {
            if (typeof raw !== 'string') throw new FieldError('invalid');
            const v = raw.replace(/\s+/g, ' ').trim();
            if (v.length > 120) throw new FieldError('too_long');
            return v;
        }
        case 'item_variant': {
            const item = items.get(field.item);
            const code = String(raw).trim();
            if (!item?.variants.some(v => v.isActive && v.code === code)) throw new FieldError('invalid_option');
            return code;
        }
    }
}

const conditionMet = (field: FormField, values: Map<string, unknown>, visible: Set<string>): boolean => {
    const c = field.visible_when;
    if (!c) return true;
    // Si el campo del que depende está oculto, este también
    if (!visible.has(c.field)) return false;
    const current = values.get(c.field);
    const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (c.in) return Array.isArray(current) ? current.some(v => c.in!.some(x => eq(x, v))) : c.in.some(x => eq(x, current));
    if (c.equals !== undefined) return Array.isArray(current) ? current.some(v => eq(v, c.equals)) : eq(current, c.equals);
    return !eq(current, c.not_equals);
};

export function validateAnswers(schema: FormSchema, items: SchemaItem[], input: Record<string, unknown>): AnswersResult {
    const itemByCode = new Map(items.map(i => [i.code, i]));
    const errors: AnswerError[] = [];
    const values = new Map<string, unknown>();
    const visible = new Set<string>();
    const out: ValidatedAnswers = { core: {}, answers: {}, location: null, church: null, items: [] };
    const toggled = new Map<string, boolean>();
    const variants = new Map<string, string>();

    for (const field of allFields(schema)) {
        if (!conditionMet(field, values, visible)) continue;
        visible.add(field.key);

        const raw = input[field.key];
        let value: unknown;
        if (isEmpty(raw) || (Array.isArray(raw) && raw.length === 0 && field.type !== 'checkbox_group')) {
            if (field.required) errors.push({ field: field.key, code: 'required', message: MESSAGES.required });
            if (field.type === 'checkbox' || field.type === 'item_toggle') value = false;
            else if (field.type === 'checkbox_group') value = [];
            else continue;
        } else {
            try {
                value = parseValue(field, raw, itemByCode);
            } catch (err) {
                const e = err instanceof FieldError ? err : new FieldError('invalid');
                errors.push({ field: field.key, code: e.code, message: e.message });
                continue;
            }
        }
        if (field.required && (field.type === 'consent' || field.type === 'checkbox') && value !== true) {
            if (!errors.some(e => e.field === field.key)) {
                errors.push({ field: field.key, code: 'must_accept', message: MESSAGES.must_accept });
            }
            continue;
        }
        if (field.type === 'checkbox_group' && field.required && (value as unknown[]).length === 0) continue;

        values.set(field.key, value);

        // A dónde va cada respuesta
        if ('maps_to' in field && field.maps_to) out.core[field.maps_to] = String(value);
        else if (field.type === 'state_conference_picker') out.location = value as ValidatedAnswers['location'];
        else if (field.type === 'church_picker') out.church = value as ValidatedAnswers['church'];
        else if (field.type === 'item_toggle') toggled.set(field.item, value as boolean);
        else if (field.type === 'item_variant') variants.set(field.item, value as string);
        else out.answers[field.key] = value;
    }

    // Productos: los marcados, y los que solo tienen selector de variante (sin "lo quiero")
    for (const [code, on] of toggled) if (on) out.items.push({ code, variantCode: variants.get(code) ?? null });
    for (const [code, variant] of variants) {
        if (!toggled.has(code)) out.items.push({ code, variantCode: variant });
    }

    return errors.length ? { ok: false, errors } : { ok: true, value: out };
}
