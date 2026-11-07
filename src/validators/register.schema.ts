import { z } from 'zod';

const GENEROS = ['Masculino', 'Femenino', 'Prefiero no decir'] as const;
const TIPOS_ALIMENTO = ['normal', 'vegetariano', 'vegano', 'otra'] as const;
const ESTATUS_PAGO = ['pendiente', 'pagado', 'no_aplica'] as const;

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Fecha inválida (formato YYYY-MM-DD)');

/** Id numérico obligatorio; acepta "3" o 3 (los selects del Front mandan strings). */
const requiredId = z.coerce.number().int().positive();

/** Id opcional: '', null o undefined → null. */
const optionalId = z.preprocess(
    v => (v === '' || v === undefined ? null : v),
    z.union([z.null(), z.coerce.number().int().positive()])
);

const optionalText = (max: number) => z.preprocess(
    v => (v === '' || v === undefined ? null : v),
    z.string().trim().max(max).nullable()
);

/** Body de POST /events/:id/register (formulario público). */
export const registerSchema = z.object({
    conferencia_id: requiredId,
    nombre_conferencia: z.string().trim().max(150).default(''),
    talla_camiseta_id: optionalId,
    nombre: z.string().trim().min(1).max(100),
    apellidos: z.string().trim().min(1).max(100),
    correo: z.string().trim().email().max(150),
    telefono: z.string().trim().min(1).max(30),
    fecha_nacimiento: fechaIso,
    genero: z.enum(GENEROS),
    estado_id: requiredId,
    nombre_estado: z.string().trim().max(100).default(''),
    ciudad: z.string().trim().min(1).max(250),
    iglesia: z.string().trim().min(1).max(200),
    incluir_lunchtime: z.boolean().nullish().transform(v => !!v),
    es_chaperon: z.boolean(),
    incluir_camisa: z.boolean().nullish().transform(v => !!v),
    alimento_especial_nota: optionalText(250),
    tipo_alimento: z.enum(TIPOS_ALIMENTO).nullish().transform(v => v ?? null),
    contacto_emergencia: z.object({
        nombre_contacto: z.string().trim().min(1).max(150),
        telefono_contacto: z.string().trim().min(1).max(30),
        relacion: z.string().trim().max(80).default(''),
    }),
});

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Body de PUT /events/register/:id/update (panel admin).
 * `.strict()` rechaza cualquier campo que no esté aquí: los nombres de
 * columna ya no pueden venir libres del cliente.
 */
export const updateRegisterSchema = z.object({
    nombre: z.string().trim().min(1).max(100),
    apellidos: z.string().trim().min(1).max(100),
    correo: z.string().trim().email().max(150),
    telefono: z.string().trim().max(30),
    fecha_nacimiento: fechaIso,
    genero: z.enum(GENEROS),
    estado_id: requiredId,
    conferencia_id: requiredId,
    ciudad: z.string().trim().max(250),
    iglesia: z.string().trim().max(200),
    es_chaperon: z.boolean(),
    tipo_alimento: z.enum(TIPOS_ALIMENTO),
    alimento_especial_nota: optionalText(250),
    talla_camiseta_id: optionalId,
    pago_camiseta: z.enum(ESTATUS_PAGO),
    pago_lunchtime: z.enum(ESTATUS_PAGO),
    checkin_at: z.boolean(),
}).partial().strict();

export type UpdateRegisterInput = z.infer<typeof updateRegisterSchema>;

/** Body de POST /events/register/:id/updatePayment. */
export const paymentSchema = z.object({
    concepto: z.enum(['camiseta', 'lunchtime']),
    estatus_nuevo: z.enum(ESTATUS_PAGO),
    notas: optionalText(200).optional(),
});
