import type { I18nText } from '../json';

/**
 * Formulario de FEJA 2026 expresado como formulario dinámico V2
 * (Anexo A de docs/v2/schema-propuesta.sql). Es lo que llenaron los 641
 * registrados en V1, con las mismas opciones.
 */
export const FEJA_FORM_TITLE: I18nText = { es: 'Registro FEJA 2026', en: 'FEJA 2026 Registration' };

export const FEJA_EVENT_NAME: I18nText = {
    es: 'Congreso FEJA Nivel Unión 2026',
    en: 'FEJA Union-Level Congress 2026',
};

const t = (es: string, en: string): I18nText => ({ es, en });

export const FEJA_FORM_SCHEMA = {
    steps: [
        {
            key: 'personal',
            title: t('Datos personales', 'Personal information'),
            fields: [
                { key: 'first_name', type: 'text', maps_to: 'first_name', required: true, label: t('Nombre', 'First name') },
                { key: 'last_name', type: 'text', maps_to: 'last_name', required: true, label: t('Apellidos', 'Last name') },
                { key: 'email', type: 'email', maps_to: 'email', required: true, label: t('Correo', 'Email') },
                { key: 'phone', type: 'phone', maps_to: 'phone', required: true, label: t('Teléfono', 'Phone') },
                { key: 'birth_date', type: 'date', maps_to: 'birth_date', required: true, label: t('Fecha de nacimiento', 'Date of birth') },
                {
                    key: 'gender', type: 'radio', maps_to: 'gender', required: true, label: t('Género', 'Gender'),
                    options: [
                        { value: 'male', label: t('Masculino', 'Male') },
                        { value: 'female', label: t('Femenino', 'Female') },
                    ],
                },
                { key: 'location', type: 'state_conference_picker', required: true, label: t('Estado y asociación', 'State and conference') },
                { key: 'city', type: 'text', required: true, label: t('Ciudad', 'City') },
                { key: 'church', type: 'church_picker', allow_new: true, required: true, label: t('Iglesia', 'Church') },
                {
                    key: 'is_chaperone', type: 'radio', required: true, label: t('¿Eres chaperón?', 'Are you a chaperone?'),
                    options: [
                        { value: true, label: t('Sí', 'Yes') },
                        { value: false, label: t('No', 'No') },
                    ],
                },
                { key: 'wants_tshirt', type: 'item_toggle', item: 'tshirt', label: t('Quiero playera', 'I want a T-shirt') },
                {
                    key: 'tshirt_size', type: 'item_variant', item: 'tshirt', required: true,
                    visible_when: { field: 'wants_tshirt', equals: true }, label: t('Talla', 'Size'),
                },
                { key: 'wants_lunch', type: 'item_toggle', item: 'lunch', label: t('Agregar comida', 'Add lunch') },
                {
                    key: 'diet', type: 'select', required: true,
                    visible_when: { field: 'wants_lunch', equals: true },
                    label: t('Preferencia alimenticia', 'Dietary preference'),
                    options: [
                        { value: 'regular', label: t('Normal', 'Regular') },
                        { value: 'vegetarian', label: t('Vegetariana', 'Vegetarian') },
                        { value: 'vegan', label: t('Vegana', 'Vegan') },
                        { value: 'other', label: t('Otra', 'Other') },
                    ],
                },
                {
                    key: 'diet_note', type: 'text',
                    visible_when: { field: 'diet', equals: 'other' }, label: t('Especifica', 'Please specify'),
                },
            ],
        },
        {
            key: 'emergency',
            title: t('Contacto de emergencia', 'Emergency contact'),
            fields: [
                { key: 'emergency_name', type: 'text', required: true, label: t('Nombre', 'Name') },
                { key: 'emergency_phone', type: 'phone', required: true, label: t('Teléfono', 'Phone') },
                { key: 'emergency_relationship', type: 'text', required: true, label: t('Relación', 'Relationship') },
            ],
        },
    ],
} as const;

/** Tallas de V1 (tabla tallas_camiseta) → variantes V2. 'N/A' (id 7) no es variante. */
export const TSHIRT_VARIANTS: ReadonlyArray<{ code: string; label: I18nText }> = [
    { code: 'XS', label: t('Extra chica (XS)', 'Extra Small (XS)') },
    { code: 'S', label: t('Chica (S)', 'Small (S)') },
    { code: 'M', label: t('Mediana (M)', 'Medium (M)') },
    { code: 'L', label: t('Grande (L)', 'Large (L)') },
    { code: 'XL', label: t('Extra grande (XL)', 'Extra Large (XL)') },
];

export const TSHIRT_PRICE_CENTS = 400; // $4
export const LUNCH_PRICE_CENTS = 200;  // $2
