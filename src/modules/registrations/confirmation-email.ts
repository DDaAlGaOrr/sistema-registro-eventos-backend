import QRCode from 'qrcode';
import { db } from '../../db/client';
import { fromJson, I18nText } from '../../db/json';
import type { Locale } from '../../db/types';
import { escapeHtml, frontUrl, OutgoingMail } from '../../core/mailer';
import { getBranding } from '../tenants/tenant.service';

const COPY = {
    es: {
        subject: (event: string) => `Registro confirmado: ${event}`,
        title: '¡Registro confirmado!',
        hello: (name: string) => `Hola ${name}, tu registro quedó guardado.`,
        when: 'Fecha', where: 'Lugar', items: 'Lo que elegiste', total: 'Total',
        paid: 'Pagado', pending: 'Pendiente de pago',
        payOffline: 'Puedes pagar en efectivo u otro método con el equipo de finanzas antes o durante el evento.',
        qr: 'Presenta este código QR en la entrada para tu check-in:',
        code: 'Código de registro', view: 'Ver mi registro',
        footer: 'Este es un correo automático, por favor no respondas a esta dirección.',
    },
    en: {
        subject: (event: string) => `Registration confirmed: ${event}`,
        title: 'Registration confirmed!',
        hello: (name: string) => `Hi ${name}, your registration has been saved.`,
        when: 'Date', where: 'Location', items: 'Your selections', total: 'Total',
        paid: 'Paid', pending: 'Payment pending',
        payOffline: 'You can pay in cash or by another method with the finance team before or during the event.',
        qr: 'Show this QR code at the entrance for check-in:',
        code: 'Registration code', view: 'View my registration',
        footer: 'This is an automated email, please do not reply to this address.',
    },
} as const;

const formatDateRange = (start: Date, end: Date, timezone: string, locale: Locale) => {
    const fmt = new Intl.DateTimeFormat(locale === 'es' ? 'es-MX' : 'en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: timezone });
    return `${fmt.format(start)} – ${fmt.format(end)}`;
};

const money = (cents: number, currency: string, locale: Locale) =>
    new Intl.NumberFormat(locale === 'es' ? 'es-MX' : 'en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);

/** Arma el correo de confirmación desde la BD (se llama al procesar la bandeja). */
export async function buildConfirmationEmail(registrationId: number): Promise<OutgoingMail> {
    const r = await db.selectFrom('registrations as r')
        .innerJoin('events as e', 'e.id', 'r.event_id')
        .innerJoin('forms as f', 'f.id', 'r.form_id')
        .select([
            'r.public_code', 'r.first_name', 'r.email', 'r.locale', 'r.tenant_id', 'r.payment_status', 'r.total_cents',
            'e.name as event_name', 'e.starts_at', 'e.ends_at', 'e.timezone', 'e.venue',
            'f.settings', 'f.currency', 'f.payments_enabled',
        ])
        .where('r.id', '=', registrationId).executeTakeFirstOrThrow();
    const lines = await db.selectFrom('registration_items as ri')
        .innerJoin('form_items as fi', 'fi.id', 'ri.item_id')
        .leftJoin('form_item_variants as v', 'v.id', 'ri.variant_id')
        .select(['fi.name', 'v.label as variant_label', 'ri.unit_price_cents'])
        .where('ri.registration_id', '=', registrationId).execute();

    const locale: Locale = r.locale;
    const c = COPY[locale];
    const { brand, slug } = await getBranding(r.tenant_id);
    const eventName = fromJson<I18nText>(r.event_name)[locale];
    const confirmation = fromJson<{ confirmationMessage?: I18nText }>(r.settings, {}).confirmationMessage?.[locale];
    const url = frontUrl(slug, `/registro/confirmacion/${r.public_code}`);
    const color = brand?.primaryColor ?? '#0f172a';
    const showPrices = !!r.payments_enabled && r.total_cents > 0;

    const qr = await QRCode.toBuffer(r.public_code, { width: 240, margin: 1, errorCorrectionLevel: 'M' });

    const itemRows = lines.map((l) => {
        const name = fromJson<I18nText>(l.name)[locale];
        const variant = l.variant_label ? ` (${fromJson<I18nText>(l.variant_label)[locale]})` : '';
        const price = showPrices ? money(l.unit_price_cents, r.currency, locale) : '';
        return `<tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9">${escapeHtml(name + variant)}</td>`
            + `<td style="padding:8px 0;border-bottom:1px solid #f1f5f9;text-align:right;color:#64748b">${escapeHtml(price)}</td></tr>`;
    }).join('');
    const totalRow = showPrices
        ? `<tr><td style="padding:10px 0"><strong>${c.total}</strong></td><td style="padding:10px 0;text-align:right"><strong>${escapeHtml(money(r.total_cents, r.currency, locale))}</strong>`
          + ` <span style="color:#64748b;font-size:13px">· ${r.payment_status === 'paid' ? c.paid : c.pending}</span></td></tr>`
        : '';
    const when = formatDateRange(new Date(r.starts_at), new Date(r.ends_at), r.timezone, locale);
    const logo = brand?.logoUrl ? `<img src="${escapeHtml(brand.logoUrl)}" alt="" style="max-height:56px;margin-bottom:8px"/>` : '';

    const html = `
<div style="font-family:'Segoe UI',Tahoma,Verdana,sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;background:#f8fafc;color:#334155">
  <div style="text-align:center;margin-bottom:20px">${logo}<div style="font-size:14px;color:#64748b">${escapeHtml(brand?.name ?? '')}</div></div>
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <h1 style="font-size:22px;color:#0f172a;margin:0 0 6px">${c.title}</h1>
    <p style="margin:0 0 20px">${escapeHtml(c.hello(r.first_name))}</p>
    <h2 style="font-size:18px;color:#0f172a;margin:0 0 8px">${escapeHtml(eventName)}</h2>
    <p style="margin:0 0 4px;font-size:14px"><strong>${c.when}:</strong> ${escapeHtml(when)}</p>
    ${r.venue ? `<p style="margin:0 0 16px;font-size:14px"><strong>${c.where}:</strong> ${escapeHtml(r.venue)}</p>` : ''}
    ${lines.length ? `<h3 style="font-size:15px;margin:20px 0 4px">${c.items}</h3><table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${itemRows}${totalRow}</table>` : ''}
    ${showPrices && r.payment_status !== 'paid' ? `<p style="font-size:14px;background:#fef9c3;padding:10px 12px;border-radius:8px">${c.payOffline}</p>` : ''}
    ${confirmation ? `<p style="font-size:14px;white-space:pre-line">${escapeHtml(confirmation)}</p>` : ''}
    <div style="text-align:center;margin:24px 0 8px">
      <p style="font-size:14px;margin:0 0 10px">${c.qr}</p>
      <img src="cid:registro-qr" alt="QR" width="200" height="200" style="border:1px solid #e2e8f0;border-radius:8px"/>
      <p style="font-size:12px;color:#64748b;margin:8px 0 0">${c.code}: <code>${escapeHtml(r.public_code)}</code></p>
    </div>
    <div style="text-align:center;margin-top:20px">
      <a href="${escapeHtml(url)}" style="background:${escapeHtml(color)};color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${c.view}</a>
    </div>
  </div>
  <p style="text-align:center;font-size:12px;color:#94a3b8;margin-top:24px">${c.footer}</p>
</div>`;

    const text = [
        c.subject(eventName), '', c.hello(r.first_name), `${c.when}: ${when}`, r.venue ? `${c.where}: ${r.venue}` : '',
        ...lines.map(l => `- ${fromJson<I18nText>(l.name)[locale]}${l.variant_label ? ` (${fromJson<I18nText>(l.variant_label)[locale]})` : ''}`),
        showPrices ? `${c.total}: ${money(r.total_cents, r.currency, locale)}` : '',
        confirmation ?? '', '', `${c.code}: ${r.public_code}`, url,
    ].filter(line => line !== '').join('\n');

    return {
        to: r.email,
        subject: c.subject(eventName),
        html,
        text,
        fromName: brand?.fromName ?? brand?.name,
        replyTo: brand?.replyTo,
        attachments: [{ filename: 'registro-qr.png', content: qr, contentType: 'image/png', cid: 'registro-qr' }],
    };
}
