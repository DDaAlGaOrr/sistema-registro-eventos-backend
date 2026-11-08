import type { Locale } from '../../db/types';
import { escapeHtml, OutgoingMail } from '../../core/mailer';

export interface Branding {
    name: string;
    logoUrl: string | null;
    primaryColor: string | null;
    fromName: string | null;
    replyTo: string | null;
}

const PLATFORM_BRANDING: Branding = {
    name: 'Registro de eventos', logoUrl: null, primaryColor: null, fromName: null, replyTo: null,
};

/** Correo sencillo con la marca del cliente; mismo diseño para todos los avisos. */
function layout(brand: Branding, title: string, paragraphs: string[], button: { label: string; url: string }, footer: string) {
    const color = brand.primaryColor ?? '#0f172a';
    const logo = brand.logoUrl
        ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" style="max-height:56px;margin-bottom:12px" />`
        : '';
    return `
<div style="font-family:'Segoe UI',Tahoma,Verdana,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;background:#f8fafc;color:#334155">
  <div style="text-align:center;margin-bottom:20px">${logo}
    <div style="font-size:14px;color:#64748b">${escapeHtml(brand.name)}</div>
  </div>
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <h1 style="font-size:22px;color:#0f172a;margin:0 0 16px">${escapeHtml(title)}</h1>
    ${paragraphs.map(p => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${p}</p>`).join('')}
    <div style="text-align:center;margin:28px 0 8px">
      <a href="${escapeHtml(button.url)}" style="background:${escapeHtml(color)};color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(button.label)}</a>
    </div>
    <p style="font-size:12px;color:#94a3b8;word-break:break-all;margin-top:20px">${escapeHtml(button.url)}</p>
  </div>
  <p style="text-align:center;font-size:12px;color:#94a3b8;margin-top:24px">${escapeHtml(footer)}</p>
</div>`;
}

const mail = (brand: Branding, to: string, subject: string, html: string, text: string): OutgoingMail => ({
    to, subject, html, text, fromName: brand.fromName ?? brand.name, replyTo: brand.replyTo,
});

export function invitationEmail(opts: {
    brand: Branding | null; locale: Locale; to: string; name: string; inviterName: string; url: string; days: number;
}): OutgoingMail {
    const brand = opts.brand ?? PLATFORM_BRANDING;
    const es = opts.locale === 'es';
    const subject = es ? `Invitación a ${brand.name}` : `Invitation to ${brand.name}`;
    const intro = es
        ? `Hola ${escapeHtml(opts.name)}, ${escapeHtml(opts.inviterName)} te invitó a administrar los registros de <strong>${escapeHtml(brand.name)}</strong>.`
        : `Hi ${escapeHtml(opts.name)}, ${escapeHtml(opts.inviterName)} invited you to manage registrations for <strong>${escapeHtml(brand.name)}</strong>.`;
    const action = es ? 'Para activar tu cuenta, crea tu contraseña:' : 'To activate your account, create your password:';
    const footer = es
        ? `El enlace vence en ${opts.days} días. Si no esperabas este correo, ignóralo.`
        : `The link expires in ${opts.days} days. If you weren't expecting this email, ignore it.`;
    const label = es ? 'Crear mi contraseña' : 'Create my password';
    return mail(brand, opts.to, subject,
        layout(brand, subject, [intro, action], { label, url: opts.url }, footer),
        `${subject}\n\n${intro.replace(/<[^>]+>/g, '')}\n${action}\n${opts.url}\n\n${footer}`);
}

export function addedToTenantEmail(opts: {
    brand: Branding | null; locale: Locale; to: string; name: string; inviterName: string; url: string;
}): OutgoingMail {
    const brand = opts.brand ?? PLATFORM_BRANDING;
    const es = opts.locale === 'es';
    const subject = es ? `Ahora tienes acceso a ${brand.name}` : `You now have access to ${brand.name}`;
    const intro = es
        ? `Hola ${escapeHtml(opts.name)}, ${escapeHtml(opts.inviterName)} te dio acceso a <strong>${escapeHtml(brand.name)}</strong>. Entra con tu correo y tu contraseña de siempre.`
        : `Hi ${escapeHtml(opts.name)}, ${escapeHtml(opts.inviterName)} gave you access to <strong>${escapeHtml(brand.name)}</strong>. Sign in with your usual email and password.`;
    const label = es ? 'Iniciar sesión' : 'Sign in';
    const footer = es ? 'Si no esperabas este correo, avísale a quien te invitó.' : 'If you weren\'t expecting this email, let the person who invited you know.';
    return mail(brand, opts.to, subject,
        layout(brand, subject, [intro], { label, url: opts.url }, footer),
        `${subject}\n\n${intro.replace(/<[^>]+>/g, '')}\n${opts.url}`);
}

export function passwordResetEmail(opts: {
    brand: Branding | null; locale: Locale; to: string; name: string; url: string; minutes: number;
}): OutgoingMail {
    const brand = opts.brand ?? PLATFORM_BRANDING;
    const es = opts.locale === 'es';
    const subject = es ? 'Restablecer tu contraseña' : 'Reset your password';
    const intro = es
        ? `Hola ${escapeHtml(opts.name)}, recibimos una solicitud para cambiar tu contraseña de <strong>${escapeHtml(brand.name)}</strong>.`
        : `Hi ${escapeHtml(opts.name)}, we received a request to change your <strong>${escapeHtml(brand.name)}</strong> password.`;
    const footer = es
        ? `El enlace vence en ${opts.minutes} minutos. Si no lo pediste, ignora este correo: tu contraseña no cambia.`
        : `The link expires in ${opts.minutes} minutes. If you didn't ask for this, ignore this email: your password stays the same.`;
    const label = es ? 'Cambiar contraseña' : 'Change password';
    return mail(brand, opts.to, subject,
        layout(brand, subject, [intro], { label, url: opts.url }, footer),
        `${subject}\n\n${intro.replace(/<[^>]+>/g, '')}\n${opts.url}\n\n${footer}`);
}
