import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { db } from '../db/client';
import type { Locale } from '../db/types';
import { logger } from './logger';

export interface MailAttachment {
    filename: string;
    content: Buffer;
    contentType: string;
    /** Para usarla dentro del HTML: <img src="cid:..."> (Gmail bloquea data: URIs). */
    cid?: string;
}

export interface OutgoingMail {
    to: string;
    subject: string;
    html: string;
    text: string;
    fromName?: string | null;
    replyTo?: string | null;
    attachments?: MailAttachment[];
}

export interface DeliveryResult {
    ok: boolean;
    providerMessageId: string | null;
    error: string | null;
}

export interface MailRecord {
    tenantId: number | null;
    template: string;
    locale: Locale;
    registrationId?: number | null;
}

/** En pruebas los correos se guardan aquí en lugar de enviarse. */
export const sentMailsForTests: OutgoingMail[] = [];

let transporter: Transporter | null = null;
const getTransporter = () => {
    transporter ??= nodemailer.createTransport({
        service: 'gmail',
        auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASS },
    });
    return transporter;
};

/**
 * Solo entrega el correo (sin registrar nada).
 *   - test: no envía; lo guarda en sentMailsForTests
 *   - sin EMAIL_USER/EMAIL_PASS: no envía; lo escribe en el log (útil en local
 *     para copiar el enlace de invitación)
 */
export async function deliverMail(mail: OutgoingMail): Promise<DeliveryResult> {
    if (env.NODE_ENV === 'test') {
        sentMailsForTests.push(mail);
        return { ok: true, providerMessageId: null, error: null };
    }
    if (!env.EMAIL_USER || !env.EMAIL_PASS) {
        logger.warn({ to: mail.to, subject: mail.subject, text: mail.text }, '[mail] Sin EMAIL_USER/EMAIL_PASS: correo no enviado (contenido en el log)');
        return { ok: true, providerMessageId: null, error: null };
    }
    try {
        const info = await getTransporter().sendMail({
            from: `${mail.fromName ?? 'Registro de eventos'} <${env.EMAIL_USER}>`,
            to: mail.to,
            replyTo: mail.replyTo ?? undefined,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
            attachments: mail.attachments?.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid })),
        });
        return { ok: true, providerMessageId: info.messageId ?? null, error: null };
    } catch (err) {
        logger.error({ err, to: mail.to }, '[mail] Error al enviar');
        return { ok: false, providerMessageId: null, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Envía un correo en el momento y deja constancia en email_messages (sin el
 * cuerpo: los enlaces llevan tokens que no deben quedar guardados en la BD).
 * Para correos que pueden esperar y reintentarse, usar la bandeja (email-queue).
 */
export async function sendMail(mail: OutgoingMail, record: MailRecord): Promise<boolean> {
    const result = await deliverMail(mail);
    const status: 'sent' | 'failed' = result.ok ? 'sent' : 'failed';
    const providerMessageId = result.providerMessageId;
    const lastError = result.error;

    if (record.tenantId !== null) {
        await db.insertInto('email_messages').values({
            tenant_id: record.tenantId,
            registration_id: record.registrationId ?? null,
            template: record.template,
            locale: record.locale,
            to_email: mail.to,
            status,
            attempts: 1,
            provider_message_id: providerMessageId,
            last_error: lastError,
            sent_at: status === 'sent' ? new Date() : null,
        }).execute().catch(err => logger.error({ err }, '[mail] No se pudo registrar el envío'));
    }
    return status === 'sent';
}

/** URL del Front de un cliente ({slug}.tuapp.com) o de la plataforma. */
export const frontUrl = (slug: string | null, path: string) =>
    `${env.FRONT_URL_TEMPLATE.replace('{slug}', slug ?? env.PLATFORM_SUBDOMAIN).replace(/\/$/, '')}${path}`;

/** Escapa HTML de datos que vienen del usuario. */
export const escapeHtml = (value: unknown): string => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
