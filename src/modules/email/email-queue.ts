/**
 * Bandeja de salida (email_messages con status 'queued').
 *
 * El registro guarda el correo en la cola dentro de su transacción y
 * responde de inmediato; un proceso en segundo plano lo envía y, si falla,
 * lo reintenta hasta MAX_ATTEMPTS veces. Si el servidor se reinicia, lo
 * pendiente sigue en la BD.
 */
import { env } from '../../config/env';
import { db } from '../../db/client';
import { deliverMail, OutgoingMail, DeliveryResult } from '../../core/mailer';
import { logger } from '../../core/logger';
import { buildConfirmationEmail } from '../registrations/confirmation-email';

export const MAX_ATTEMPTS = 5;

const BUILDERS: Record<string, (registrationId: number) => Promise<OutgoingMail>> = {
    registration_confirmation: buildConfirmationEmail,
};

export interface QueueRunSummary {
    sent: number;
    retrying: number;
    failed: number;
}

export async function processEmailQueue(opts: { limit?: number; deliver?: (m: OutgoingMail) => Promise<DeliveryResult> } = {}): Promise<QueueRunSummary> {
    const deliver = opts.deliver ?? deliverMail;
    const summary: QueueRunSummary = { sent: 0, retrying: 0, failed: 0 };

    const pending = await db.selectFrom('email_messages').select(['id', 'template', 'registration_id', 'attempts'])
        .where('status', '=', 'queued').where('attempts', '<', MAX_ATTEMPTS)
        .orderBy('id').limit(opts.limit ?? 20).execute();

    for (const row of pending) {
        // "Toma" el correo: si otra instancia ya lo tomó, attempts ya cambió
        const claim = await db.updateTable('email_messages').set({ attempts: row.attempts + 1 })
            .where('id', '=', row.id).where('status', '=', 'queued').where('attempts', '=', row.attempts)
            .executeTakeFirst();
        if (Number(claim.numUpdatedRows) === 0) continue;
        const attempt = row.attempts + 1;

        let result: DeliveryResult;
        try {
            const builder = BUILDERS[row.template];
            if (!builder || !row.registration_id) throw new Error(`Plantilla desconocida: ${row.template}`);
            result = await deliver(await builder(row.registration_id));
        } catch (err) {
            result = { ok: false, providerMessageId: null, error: err instanceof Error ? err.message : String(err) };
        }

        if (result.ok) {
            await db.updateTable('email_messages').set({
                status: 'sent', sent_at: new Date(), provider_message_id: result.providerMessageId, last_error: null,
            }).where('id', '=', row.id).execute();
            summary.sent++;
        } else if (attempt >= MAX_ATTEMPTS) {
            await db.updateTable('email_messages').set({ status: 'failed', last_error: result.error })
                .where('id', '=', row.id).execute();
            summary.failed++;
            logger.error({ emailId: row.id, error: result.error }, '[mail] Correo descartado tras varios intentos');
        } else {
            await db.updateTable('email_messages').set({ last_error: result.error }).where('id', '=', row.id).execute();
            summary.retrying++;
        }
    }
    return summary;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Procesa la bandeja cada EMAIL_QUEUE_INTERVAL_SECONDS (no en pruebas). */
export function startEmailWorker() {
    if (env.NODE_ENV === 'test' || timer) return;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const s = await processEmailQueue();
            if (s.sent || s.failed || s.retrying) logger.info(s, '[mail] Bandeja procesada');
        } catch (err) {
            logger.error({ err }, '[mail] Error procesando la bandeja');
        } finally {
            running = false;
        }
    };
    timer = setInterval(tick, env.EMAIL_QUEUE_INTERVAL_SECONDS * 1000);
    timer.unref();
    void tick();
}

/** Para no esperar al siguiente ciclo después de un registro. */
export function kickEmailWorker() {
    if (env.NODE_ENV === 'test' || !timer || running) return;
    setImmediate(() => { void processEmailQueue().catch(err => logger.error({ err }, '[mail] Error procesando la bandeja')); });
}

export function stopEmailWorker() {
    if (timer) clearInterval(timer);
    timer = null;
}
