import { env } from '../config/env';
import { logger } from './logger';

/**
 * Cloudflare Turnstile (opcional). Si no hay TURNSTILE_SECRET_KEY, no se
 * exige captcha. Cuando se configura, el Front manda el token en
 * `captchaToken`.
 */
export const captchaEnabled = () => !!env.TURNSTILE_SECRET_KEY;

export async function verifyCaptcha(token: string | undefined, ip: string | undefined): Promise<boolean> {
    if (!captchaEnabled()) return true;
    if (!token) return false;
    try {
        const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!, response: token });
        if (ip) body.set('remoteip', ip);
        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
        const data = await res.json() as { success?: boolean };
        return data.success === true;
    } catch (err) {
        logger.error({ err }, '[captcha] No se pudo verificar');
        return false;
    }
}
