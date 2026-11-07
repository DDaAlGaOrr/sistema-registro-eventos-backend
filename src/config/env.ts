import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const DEFAULT_CORS_ORIGINS = 'http://localhost:4200,https://congreso-union.fesjaz.com';

const envSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().int().positive().default(3306),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().default(''),
    DB_NAME: z.string().min(1),
    DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),

    JWT_SECRET: z.string().min(1),
    JWT_EXPIRES_IN: z.string().min(1).default('8h'),

    EMAIL_USER: z.string().optional(),
    EMAIL_PASS: z.string().optional(),

    // Orígenes permitidos para CORS, separados por coma
    CORS_ORIGINS: z.string().default(DEFAULT_CORS_ORIGINS),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    const missing = parsed.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`[config] Variables de entorno inválidas o faltantes:\n${missing}`);
    process.exit(1);
}

if (parsed.data.JWT_SECRET.length < 32) {
    console.warn('[config] JWT_SECRET tiene menos de 32 caracteres; se recomienda uno más largo y aleatorio.');
}

export const env = {
    ...parsed.data,
    CORS_ORIGINS: parsed.data.CORS_ORIGINS.split(',').map(o => o.trim()).filter(Boolean),
};
