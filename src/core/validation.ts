import { z } from 'zod';

/** Texto obligatorio en español e inglés. */
export const i18nTextSchema = (max = 200) => z.object({
    es: z.string().trim().min(1).max(max),
    en: z.string().trim().min(1).max(max),
}).strict();

/** Slug para URLs y subdominios: minúsculas, números y guiones. */
export const slugSchema = z.string().trim().toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Solo minúsculas, números y guiones (sin empezar ni terminar en guion)');

export const hexColorSchema = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Color en formato #RRGGBB');

export const httpsUrlSchema = z.string().trim().max(500).url()
    .refine(u => u.startsWith('https://'), 'Debe empezar con https://');

export const timezoneSchema = z.string().trim().refine((tz) => {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}, 'Zona horaria inválida (ej. America/Phoenix)');

export const passwordSchema = z.string()
    .min(10, 'La contraseña debe tener al menos 10 caracteres')
    .max(200)
    .refine(p => /[A-Za-z]/.test(p) && /\d/.test(p), 'La contraseña debe tener letras y números');

export const emailSchema = z.string().trim().toLowerCase().email().max(150);

export const isoDateTimeSchema = z.string().datetime({ offset: true }).transform(v => new Date(v));
