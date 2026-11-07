import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

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

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // Logs legibles en consola (solo desarrollo; pino-pretty es devDependency)
    LOG_PRETTY: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),

    // ── V2 multitenant ──────────────────────────────────────────────────
    // Dominios base de la plataforma: {slug}.<dominio> identifica al cliente
    // (ej. "tuapp.com,localhost"). Sus subdominios también pasan CORS.
    APP_BASE_DOMAINS: z.string().default('localhost'),
    // Subdominio del panel de la plataforma (sin cliente): app.tuapp.com
    PLATFORM_SUBDOMAIN: z.string().default('app'),
    // Sesión V2: access token corto + refresh token en cookie httpOnly
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    // 'lax' si Front y API comparten dominio (pacific.tuapp.com / api.tuapp.com);
    // 'none' si están en dominios distintos (requiere HTTPS)
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
    // Bloqueo de cuenta por intentos fallidos
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

    // URL del Front de cada cliente para los enlaces de los correos.
    // {slug} se reemplaza por el slug del cliente (o PLATFORM_SUBDOMAIN).
    FRONT_URL_TEMPLATE: z.string().default('http://{slug}.localhost:4200'),
    INVITE_TTL_DAYS: z.coerce.number().int().positive().default(7),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),
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

const list = (value: string) => value.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);

export const env = {
    ...parsed.data,
    CORS_ORIGINS: parsed.data.CORS_ORIGINS.split(',').map(o => o.trim()).filter(Boolean),
    APP_BASE_DOMAINS: list(parsed.data.APP_BASE_DOMAINS),
    COOKIE_SECURE: parsed.data.COOKIE_SECURE === 'auto'
        ? parsed.data.NODE_ENV === 'production'
        : parsed.data.COOKIE_SECURE === 'true',
};
