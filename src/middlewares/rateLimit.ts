import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env';

// En las pruebas automáticas se hacen muchos logins seguidos a propósito
const skip = () => env.NODE_ENV === 'test';

const limitMessage = (message: string) => ({ status: 'error', message });

/** Login: frena ataques de fuerza bruta. */
export const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip,
    skipSuccessfulRequests: true,
    message: limitMessage('Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.'),
});

/**
 * Registro público. Es generoso a propósito: un líder puede registrar
 * a varios jóvenes desde el mismo teléfono o el wifi de la iglesia.
 */
export const registerLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip,
    message: limitMessage('Demasiados registros desde esta conexión. Intenta de nuevo en unos minutos.'),
});
