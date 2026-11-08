import { describe, expect, it } from 'vitest';
import { FEJA_FORM_SCHEMA, TSHIRT_VARIANTS } from '../src/db/import-v1/feja-form';
import { compareSchemas, FormSchema, formSchemaSchema, SchemaItem, validateFormSchema } from '../src/modules/forms/form-schema';
import { validateAnswers } from '../src/modules/forms/answers';

const FEJA_ITEMS: SchemaItem[] = [
    { code: 'tshirt', isActive: true, variants: TSHIRT_VARIANTS.map(v => ({ code: v.code, isActive: true })) },
    { code: 'lunch', isActive: true, variants: [] },
];
const feja = formSchemaSchema.parse(FEJA_FORM_SCHEMA);

const t = (es: string) => ({ es, en: es });
const minimal = (fields: object[], extraSteps: object[] = []): FormSchema => formSchemaSchema.parse({
    steps: [{
        key: 'datos', title: t('Datos'),
        fields: [
            { key: 'first_name', type: 'text', maps_to: 'first_name', required: true, label: t('Nombre') },
            { key: 'last_name', type: 'text', maps_to: 'last_name', required: true, label: t('Apellidos') },
            { key: 'email', type: 'email', maps_to: 'email', required: true, label: t('Correo') },
            ...fields,
        ],
    }, ...extraSteps],
});
const issuesOf = (schema: FormSchema, items: SchemaItem[] = [], forPublish = true) =>
    validateFormSchema(schema, items, { forPublish }).map(i => i.message).join(' | ');

const fejaPerson = {
    first_name: 'Ana', last_name: 'López', email: 'ANA@Example.com', phone: '602-555-0101',
    birth_date: '2008-04-02', gender: 'female',
    location: { state: 'az', conference_id: 12 }, city: 'Phoenix', church: { church_id: 99 },
    is_chaperone: false,
    wants_tshirt: true, tshirt_size: 'M',
    wants_lunch: true, diet: 'vegan',
    emergency_name: 'Mamá', emergency_phone: '6025550000', emergency_relationship: 'Madre',
};

describe('formulario FEJA 2026 (migrado de V1)', () => {
    it('pasa la validación completa para publicar', () => {
        expect(validateFormSchema(feja, FEJA_ITEMS, { forPublish: true })).toEqual([]);
    });

    it('una respuesta real se reparte en columnas, selectores, productos y answers', () => {
        const res = validateAnswers(feja, FEJA_ITEMS, fejaPerson);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.value.core).toEqual({
            first_name: 'Ana', last_name: 'López', email: 'ana@example.com', phone: '602-555-0101',
            birth_date: '2008-04-02', gender: 'female',
        });
        expect(res.value.location).toEqual({ stateCode: 'AZ', conferenceId: 12 });
        expect(res.value.church).toEqual({ id: 99 });
        expect(res.value.items).toEqual([{ code: 'tshirt', variantCode: 'M' }, { code: 'lunch', variantCode: null }]);
        expect(res.value.answers).toEqual({
            city: 'Phoenix', is_chaperone: false, diet: 'vegan',
            emergency_name: 'Mamá', emergency_phone: '6025550000', emergency_relationship: 'Madre',
        });
    });

    it('lo oculto se ignora: sin comida no se guarda la dieta aunque venga', () => {
        const res = validateAnswers(feja, FEJA_ITEMS, { ...fejaPerson, wants_lunch: false, wants_tshirt: false, tshirt_size: 'XXL' });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.value.items).toEqual([]);
        expect(res.value.answers).not.toHaveProperty('diet');
    });

    it('obligatorio solo si está visible: con comida, la dieta es obligatoria', () => {
        const res = validateAnswers(feja, FEJA_ITEMS, { ...fejaPerson, diet: undefined });
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.errors).toEqual([{ field: 'diet', code: 'required', message: 'Campo obligatorio' }]);
    });

    it('condición encadenada: la nota solo aparece con dieta "other"', () => {
        const withNote = validateAnswers(feja, FEJA_ITEMS, { ...fejaPerson, diet: 'other', diet_note: 'Sin gluten' });
        expect(withNote.ok && withNote.value.answers.diet_note).toBe('Sin gluten');
        const ignored = validateAnswers(feja, FEJA_ITEMS, { ...fejaPerson, diet_note: 'no aplica' });
        expect(ignored.ok && 'diet_note' in ignored.value.answers).toBe(false);
    });

    it('junta todos los errores de una vez', () => {
        const res = validateAnswers(feja, FEJA_ITEMS, {
            ...fejaPerson, email: 'no-es-correo', gender: 'otro', tshirt_size: 'XXXL', birth_date: '2999-01-01', first_name: '',
        });
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(Object.fromEntries(res.errors.map(e => [e.field, e.code]))).toEqual({
            first_name: 'required', email: 'invalid', gender: 'invalid_option', birth_date: 'out_of_range', tshirt_size: 'invalid_option',
        });
    });

    it('acepta valores como texto ("true", "12") igual que el Front de V1', () => {
        const res = validateAnswers(feja, FEJA_ITEMS, { ...fejaPerson, is_chaperone: 'true', wants_lunch: 'false' });
        expect(res.ok && res.value.answers.is_chaperone).toBe(true);
    });
});

describe('validación de la estructura', () => {
    it('una condición solo puede depender de un campo anterior (no hay ciclos)', () => {
        const schema = minimal([
            { key: 'a', type: 'text', label: t('A'), visible_when: { field: 'b', equals: 'x' } },
            { key: 'b', type: 'select', label: t('B'), options: [{ value: 'x', label: t('X') }] },
        ]);
        expect(issuesOf(schema)).toMatch(/"b" no existe antes/);
    });

    it('la condición debe usar valores válidos del campo del que depende', () => {
        const schema = minimal([
            { key: 'quiere', type: 'checkbox', label: t('¿Quiere?') },
            { key: 'detalle', type: 'text', label: t('Detalle'), visible_when: { field: 'quiere', equals: 'si' } },
            { key: 'color', type: 'radio', label: t('Color'), options: [{ value: 'rojo', label: t('Rojo') }, { value: 'azul', label: t('Azul') }] },
            { key: 'tono', type: 'text', label: t('Tono'), visible_when: { field: 'color', in: ['verde'] } },
        ]);
        const issues = issuesOf(schema);
        expect(issues).toMatch(/"quiere" es sí\/no/);
        expect(issues).toMatch(/no es una opción de "color"/);
    });

    it('detecta claves repetidas, productos inexistentes y género con valores raros', () => {
        const schema = minimal([
            { key: 'email', type: 'text', label: t('Repetido') },
            { key: 'playera', type: 'item_toggle', item: 'no_existe', label: t('Playera') },
            { key: 'genero', type: 'radio', maps_to: 'gender', label: t('Género'), options: [{ value: 'm', label: t('M') }, { value: 'f', label: t('F') }] },
        ]);
        const issues = issuesOf(schema);
        expect(issues).toMatch(/Campo repetido: email/);
        expect(issues).toMatch(/"no_existe" no existe/);
        expect(issues).toMatch(/género los valores/);
    });

    it('para publicar exige nombre, apellidos y correo obligatorios y visibles', () => {
        const schema = formSchemaSchema.parse({
            steps: [{ key: 'x', title: t('X'), fields: [{ key: 'nombre', type: 'text', maps_to: 'first_name', label: t('Nombre') }] }],
        });
        const issues = issuesOf(schema);
        expect(issues).toMatch(/"first_name" debe ser obligatorio/);
        expect(issues).toMatch(/Falta un campo para "last_name"/);
        expect(issues).toMatch(/Falta un campo para "email"/);
        // Como borrador sí se puede guardar
        expect(issuesOf(schema, [], false)).toBe('');
    });

    it('el selector de iglesia necesita antes el de estado/asociación', () => {
        const schema = minimal([{ key: 'iglesia', type: 'church_picker', label: t('Iglesia') }]);
        expect(issuesOf(schema)).toMatch(/necesita antes el selector/);
    });

    it('la estructura rechaza tipos y propiedades desconocidas', () => {
        expect(formSchemaSchema.safeParse({ steps: [{ key: 's', title: t('S'), fields: [{ key: 'x', type: 'archivo', label: t('X') }] }] }).success).toBe(false);
        expect(formSchemaSchema.safeParse({ steps: [{ key: 's', title: t('S'), fields: [{ key: 'x', type: 'text', label: t('X'), hack: 1 }] }] }).success).toBe(false);
        expect(formSchemaSchema.safeParse({ steps: [{ key: 's', title: { es: 'Solo español' }, fields: [] }] }).success).toBe(false);
    });
});

describe('otros tipos de campo', () => {
    const schema = minimal([
        { key: 'talleres', type: 'checkbox_group', label: t('Talleres'), min_selected: 1, max_selected: 2,
            options: [{ value: 'musica', label: t('Música') }, { value: 'teatro', label: t('Teatro') }, { value: 'deporte', label: t('Deporte') }] },
        { key: 'edad', type: 'number', label: t('Edad'), integer: true, min: 12, max: 35 },
        { key: 'acepto', type: 'consent', required: true, label: t('Acepto el reglamento') },
    ]);
    const ok = { first_name: 'A', last_name: 'B', email: 'a@b.co', talleres: ['musica'], edad: 16, acepto: true };

    it('respuestas válidas', () => {
        const res = validateAnswers(schema, [], ok);
        expect(res.ok && res.value.answers).toEqual({ talleres: ['musica'], edad: 16, acepto: true });
    });

    it('límites de selección, rango numérico y consentimiento', () => {
        const res = validateAnswers(schema, [], { ...ok, talleres: ['musica', 'teatro', 'deporte'], edad: 15.5, acepto: false });
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(Object.fromEntries(res.errors.map(e => [e.field, e.code]))).toEqual({
            talleres: 'too_long', edad: 'invalid', acepto: 'must_accept',
        });
    });

    it('iglesia nueva solo si el campo lo permite', () => {
        const withPicker = minimal([
            { key: 'ubicacion', type: 'state_conference_picker', required: true, label: t('Ubicación') },
            { key: 'iglesia', type: 'church_picker', allow_new: false, required: true, label: t('Iglesia') },
        ]);
        const res = validateAnswers(withPicker, [], {
            first_name: 'A', last_name: 'B', email: 'a@b.co', ubicacion: { state: 'CA', conference_id: 3 }, iglesia: { new_name: 'Nueva' },
        });
        expect(!res.ok && res.errors[0]).toMatchObject({ field: 'iglesia', code: 'not_allowed' });
    });
});

describe('comparar versiones', () => {
    it('reporta campos agregados, quitados y cambiados', () => {
        const v1 = minimal([{ key: 'ciudad', type: 'text', label: t('Ciudad') }, { key: 'viejo', type: 'text', label: t('Viejo') }]);
        const v2 = minimal([{ key: 'ciudad', type: 'text', label: t('Ciudad'), required: true }, { key: 'nuevo', type: 'text', label: t('Nuevo') }]);
        expect(compareSchemas(v1, v2)).toMatchObject({ added: ['nuevo'], removed: ['viejo'], changed: ['ciudad'] });
    });
});
