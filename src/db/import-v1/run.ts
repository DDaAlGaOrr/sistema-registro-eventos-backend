/**
 * npm run import:v1 -- --dry-run   → hace todo, verifica y revierte (no escribe)
 * npm run import:v1                → migra FEJA 2026 de V1 a V2
 */
import { db, destroyDb } from '../client';
import { env } from '../../config/env';
import { importV1 } from './import';

const dryRun = process.argv.includes('--dry-run');
const log = (m: string) => console.log(`  ${m}`);

console.log(`[import:v1] BD: ${env.DB_NAME} @ ${env.DB_HOST}${dryRun ? '  (modo prueba)' : ''}`);

importV1(db, { dryRun, log })
    .then((r) => {
        const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
        console.log(`
  ✔ Verificación contra V1: todo cuadra
    Tenant ${r.tenantId} / evento ${r.eventId}
    Usuarios: ${r.users} (${r.platformAdmins} admins de plataforma, ${r.memberships} membresías)
    Iglesias en catálogo: ${r.churches}
    Registros: ${r.registrations} · check-ins: ${r.checkedIn}
    Playeras: ${r.tshirts.total} (${r.tshirts.paid} pagadas) · Comidas: ${r.lunches.total} (${r.lunches.paid} pagadas)
    Pagos: ${r.payments} por ${usd(r.paidCents)}
    Logs de auditoría migrados: ${r.auditLogs}`);
        if (r.viewersWithoutScope.length) {
            console.log(`\n  ⚠ Lectores sin asociación asignada (ven toda la unión, como en V1):\n    ${r.viewersWithoutScope.join('\n    ')}`);
        }
    })
    .catch((err) => {
        console.error(`[import:v1] ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
    })
    .finally(() => destroyDb());
