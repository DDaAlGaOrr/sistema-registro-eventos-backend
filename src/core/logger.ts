import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
    level: env.LOG_LEVEL,
    redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[oculto]',
    },
    ...(env.LOG_PRETTY
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
});

/** Quita valores sensibles de la URL antes de escribirla en el log (ej. ?token= del SSE). */
export const sanitizeUrl = (url: string | undefined): string | undefined =>
    url?.replace(/([?&](token|password)=)[^&]*/gi, '$1[oculto]');
