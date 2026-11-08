/**
 * Estructura de los formularios dinámicos (form_versions.schema_json).
 *
 *   { steps: [ { key, title{es,en}, fields: [ { key, type, label{es,en}, ... } ] } ] }
 *
 * Dos niveles de validación:
 *   - estructura (Zod): al guardar un borrador; puede estar incompleto.
 *   - semántica: referencias entre campos, productos y, al PUBLICAR, que esté
 *     completo (nombre, apellidos y correo obligatorios, pasos con campos...).
 */
import { z } from 'zod';
import { i18nTextSchema } from '../../core/validation';

export const FIELD_KEY = /^[a-z][a-z0-9_]{0,49}$/;
const keySchema = z.string().regex(FIELD_KEY, 'Clave: minúsculas, números y guion bajo; empieza con letra (máx. 50)');
const i18n = i18nTextSchema(500);
const optionValue = z.union([z.string().trim().min(1).max(100), z.number().finite(), z.boolean()]);
type OptionValue = z.infer<typeof optionValue>;

const conditionSchema = z.object({
    field: keySchema,
    equals: optionValue.optional(),
    not_equals: optionValue.optional(),
    in: z.array(optionValue).min(1).max(50).optional(),
}).strict().refine(
    c => [c.equals, c.not_equals, c.in].filter(v => v !== undefined).length === 1,
    'La condición debe usar solo una de: equals, not_equals, in'
);

const optionsSchema = (min: number, max: number) => z.array(z.object({ value: optionValue, label: i18n }).strict()).min(min).max(max);

const base = {
    key: keySchema,
    label: i18n,
    help: i18n.optional(),
    required: z.boolean().default(false),
    visible_when: conditionSchema.optional(),
};

/** Columnas de registrations que puede llenar un campo (maps_to). */
export const CORE_COLUMNS = ['first_name', 'last_name', 'email', 'phone', 'birth_date', 'gender'] as const;
export type CoreColumn = typeof CORE_COLUMNS[number];
export const GENDER_VALUES = ['male', 'female', 'undisclosed'] as const;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha YYYY-MM-DD');

export const fieldSchema = z.discriminatedUnion('type', [
    z.object({
        ...base, type: z.literal('text'),
        maps_to: z.enum(['first_name', 'last_name', 'phone']).optional(),
        min_length: z.number().int().min(0).max(500).optional(),
        max_length: z.number().int().min(1).max(500).default(200),
    }).strict(),
    z.object({ ...base, type: z.literal('textarea'), max_length: z.number().int().min(1).max(2000).default(1000) }).strict(),
    z.object({ ...base, type: z.literal('email'), maps_to: z.literal('email').optional() }).strict(),
    z.object({ ...base, type: z.literal('phone'), maps_to: z.literal('phone').optional() }).strict(),
    z.object({
        ...base, type: z.literal('number'),
        min: z.number().finite().optional(), max: z.number().finite().optional(), integer: z.boolean().default(false),
    }).strict(),
    z.object({
        ...base, type: z.literal('date'), maps_to: z.literal('birth_date').optional(),
        min: dateString.optional(), max: dateString.optional(),
    }).strict(),
    z.object({ ...base, type: z.literal('checkbox') }).strict(),
    z.object({ ...base, type: z.literal('consent') }).strict(),
    z.object({ ...base, type: z.literal('radio'), maps_to: z.literal('gender').optional(), options: optionsSchema(2, 50) }).strict(),
    z.object({ ...base, type: z.literal('select'), maps_to: z.literal('gender').optional(), options: optionsSchema(1, 100) }).strict(),
    z.object({
        ...base, type: z.literal('checkbox_group'), options: optionsSchema(1, 50),
        min_selected: z.number().int().min(0).optional(), max_selected: z.number().int().min(1).optional(),
    }).strict(),
    // Campos de sistema
    z.object({ ...base, type: z.literal('state_conference_picker') }).strict(),
    z.object({ ...base, type: z.literal('church_picker'), allow_new: z.boolean().default(true) }).strict(),
    // Texto con sugerencias de ciudades del estado elegido (valor: texto normalizado)
    z.object({ ...base, type: z.literal('city_picker') }).strict(),
    z.object({ ...base, type: z.literal('item_toggle'), item: keySchema }).strict(),
    z.object({ ...base, type: z.literal('item_variant'), item: keySchema }).strict(),
]);

export const stepSchema = z.object({
    key: keySchema,
    title: i18n,
    description: i18n.optional(),
    fields: z.array(fieldSchema).max(50),
}).strict();

export const formSchemaSchema = z.object({
    steps: z.array(stepSchema).max(10),
}).strict();

export type FormField = z.infer<typeof fieldSchema>;
export type FormStep = z.infer<typeof stepSchema>;
export type FormSchema = z.infer<typeof formSchemaSchema>;
export type Condition = z.infer<typeof conditionSchema>;

/** Producto del formulario, como lo necesita la validación. */
export interface SchemaItem {
    code: string;
    isActive: boolean;
    variants: { code: string; isActive: boolean }[];
}

export interface SchemaIssue {
    path: string;
    message: string;
}

export const allFields = (schema: FormSchema): FormField[] => schema.steps.flatMap(s => s.fields);

const BOOLEAN_TYPES = new Set(['checkbox', 'consent', 'item_toggle']);

const optionsOf = (field: FormField): OptionValue[] | null =>
    'options' in field ? field.options.map(o => o.value) : null;

const conditionValues = (c: Condition): OptionValue[] =>
    c.in ?? [c.equals ?? c.not_equals] as OptionValue[];

/**
 * Revisión semántica. Con `forPublish` también exige que esté completo.
 * Devuelve la lista de problemas (vacía = válido).
 */
export function validateFormSchema(schema: FormSchema, items: SchemaItem[], opts: { forPublish: boolean }): SchemaIssue[] {
    const issues: SchemaIssue[] = [];
    const add = (path: string, message: string) => issues.push({ path, message });

    const stepKeys = new Set<string>();
    const seen = new Map<string, FormField>();
    const mapped = new Map<string, string>();
    const itemToggles = new Set<string>();
    const itemVariants = new Set<string>();
    const itemByCode = new Map(items.map(i => [i.code, i]));
    let pickerSeen = false;
    let churchSeen = false;
    let citySeen = false;
    let total = 0;

    schema.steps.forEach((step, si) => {
        const sp = `steps[${si}]`;
        if (stepKeys.has(step.key)) add(`${sp}.key`, `Paso repetido: ${step.key}`);
        stepKeys.add(step.key);
        if (opts.forPublish && step.fields.length === 0) add(`${sp}.fields`, 'El paso no tiene campos');

        step.fields.forEach((field, fi) => {
            const fp = `${sp}.fields[${fi}]`;
            total++;
            if (seen.has(field.key)) add(`${fp}.key`, `Campo repetido: ${field.key}`);

            // Condición: solo puede depender de un campo ANTERIOR (evita ciclos)
            if (field.visible_when) {
                const ref = seen.get(field.visible_when.field);
                if (!ref) {
                    add(`${fp}.visible_when.field`, `"${field.visible_when.field}" no existe antes de este campo`);
                } else {
                    const values = conditionValues(field.visible_when);
                    const allowed = optionsOf(ref);
                    if (allowed && values.some(v => !allowed.includes(v))) {
                        add(`${fp}.visible_when`, `El valor de la condición no es una opción de "${ref.key}"`);
                    }
                    if (BOOLEAN_TYPES.has(ref.type) && values.some(v => typeof v !== 'boolean')) {
                        add(`${fp}.visible_when`, `"${ref.key}" es sí/no: la condición debe usar true o false`);
                    }
                }
            }

            const options = optionsOf(field);
            if (options && new Set(options.map(v => JSON.stringify(v))).size !== options.length) {
                add(`${fp}.options`, 'Hay opciones con el mismo valor');
            }

            if ('maps_to' in field && field.maps_to) {
                if (mapped.has(field.maps_to)) add(`${fp}.maps_to`, `"${field.maps_to}" ya lo llena el campo "${mapped.get(field.maps_to)}"`);
                mapped.set(field.maps_to, field.key);
                if (field.maps_to === 'gender' && options?.some(v => !(GENDER_VALUES as readonly unknown[]).includes(v))) {
                    add(`${fp}.options`, `Para género los valores deben ser: ${GENDER_VALUES.join(', ')}`);
                }
            }

            switch (field.type) {
                case 'text':
                    if (field.min_length !== undefined && field.min_length > field.max_length) add(fp, 'min_length es mayor que max_length');
                    break;
                case 'number':
                    if (field.min !== undefined && field.max !== undefined && field.min > field.max) add(fp, 'min es mayor que max');
                    break;
                case 'date':
                    if (field.min && field.max && field.min > field.max) add(fp, 'min es posterior a max');
                    break;
                case 'checkbox_group':
                    if (field.max_selected !== undefined && field.max_selected > field.options.length) add(fp, 'max_selected es mayor que el número de opciones');
                    if (field.min_selected !== undefined && field.max_selected !== undefined && field.min_selected > field.max_selected) add(fp, 'min_selected es mayor que max_selected');
                    break;
                case 'state_conference_picker':
                    if (pickerSeen) add(fp, 'Solo puede haber un selector de estado/asociación');
                    pickerSeen = true;
                    break;
                case 'church_picker':
                    if (churchSeen) add(fp, 'Solo puede haber un selector de iglesia');
                    if (!pickerSeen) add(fp, 'El selector de iglesia necesita antes el selector de estado/asociación');
                    churchSeen = true;
                    break;
                case 'city_picker':
                    if (citySeen) add(fp, 'Solo puede haber un selector de ciudad');
                    if (!pickerSeen) add(fp, 'El selector de ciudad necesita antes el selector de estado/asociación');
                    citySeen = true;
                    break;
                case 'item_toggle':
                case 'item_variant': {
                    const set = field.type === 'item_toggle' ? itemToggles : itemVariants;
                    if (set.has(field.item)) add(`${fp}.item`, `El producto "${field.item}" ya tiene un campo de este tipo`);
                    set.add(field.item);
                    const item = itemByCode.get(field.item);
                    if (!item) {
                        add(`${fp}.item`, `El producto "${field.item}" no existe en este formulario`);
                    } else {
                        if (opts.forPublish && !item.isActive) add(`${fp}.item`, `El producto "${field.item}" está desactivado`);
                        if (field.type === 'item_variant' && !item.variants.some(v => v.isActive)) {
                            add(`${fp}.item`, `El producto "${field.item}" no tiene variantes (tallas) activas`);
                        }
                    }
                    break;
                }
            }
            seen.set(field.key, field);
        });
    });

    if (total > 100) add('steps', 'Máximo 100 campos por formulario');

    if (opts.forPublish) {
        if (schema.steps.length === 0) add('steps', 'El formulario no tiene pasos');
        for (const col of ['first_name', 'last_name', 'email'] as const) {
            const key = mapped.get(col);
            const field = key ? seen.get(key) : undefined;
            if (!field) add('steps', `Falta un campo para "${col}" (maps_to)`);
            else if (!field.required || field.visible_when) add('steps', `El campo de "${col}" debe ser obligatorio y siempre visible`);
        }
    }
    return issues;
}

/** Resumen de cambios entre dos versiones (para la auditoría al publicar). */
export function compareSchemas(before: FormSchema | null, after: FormSchema) {
    // MySQL reordena llaves JSON: comparar con llaves ordenadas
    const stable = (v: unknown): string => JSON.stringify(v, (_k, val) =>
        val && typeof val === 'object' && !Array.isArray(val)
            ? Object.fromEntries(Object.keys(val).sort().map(k => [k, val[k]]))
            : val);
    const map = (s: FormSchema | null) => new Map((s ? allFields(s) : []).map(f => [f.key, stable(f)]));
    const a = map(before);
    const b = map(after);
    return {
        added: [...b.keys()].filter(k => !a.has(k)),
        removed: [...a.keys()].filter(k => !b.has(k)),
        changed: [...b.keys()].filter(k => a.has(k) && a.get(k) !== b.get(k)),
        steps: { before: before?.steps.length ?? 0, after: after.steps.length },
    };
}
