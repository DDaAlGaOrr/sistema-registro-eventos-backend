import { describe, expect, it } from 'vitest';
import { diff } from '../src/core/audit';
import { ipToBuffer } from '../src/core/ip';
import { permissionsFor, PERMISSIONS } from '../src/core/permissions';
import { matchHost } from '../src/modules/tenants/tenant.resolver';
import { isAllowedOrigin } from '../src/app';

describe('diff (auditoría)', () => {
    it('solo reporta lo que cambió, con antes y después', () => {
        const before = { first_name: 'Ana', email: 'a@x.com', checked_in_at: null };
        const after = { first_name: 'Ana', email: 'b@x.com', checked_in_at: new Date('2027-01-01T00:00:00Z') };
        expect(diff(before, after)).toEqual({
            email: { from: 'a@x.com', to: 'b@x.com' },
            checked_in_at: { from: null, to: '2027-01-01T00:00:00.000Z' },
        });
    });

    it('devuelve null si nada cambió', () => {
        expect(diff({ a: 1, b: { x: 1 } }, { a: 1, b: { x: 1 } })).toBeNull();
    });
});

describe('ipToBuffer', () => {
    const hex = (ip: string) => ipToBuffer(ip)?.toString('hex');
    it('IPv4 como IPv4-mapped', () => {
        expect(hex('192.168.1.10')).toBe('00000000000000000000ffffc0a8010a');
        expect(hex('::ffff:192.168.1.10')).toBe('00000000000000000000ffffc0a8010a');
    });
    it('IPv6 completa y abreviada', () => {
        expect(hex('::1')).toBe('00000000000000000000000000000001');
        expect(hex('2001:db8::8a2e:370:7334')).toBe('20010db80000000000008a2e03707334');
    });
    it('basura → null', () => {
        expect(ipToBuffer('no-es-ip')).toBeNull();
        expect(ipToBuffer(undefined)).toBeNull();
    });
});

describe('permisos por rol', () => {
    it('owner y admin de plataforma tienen todo', () => {
        expect(permissionsFor('owner', false).size).toBe(PERMISSIONS.length);
        expect(permissionsFor(null, true).size).toBe(PERMISSIONS.length);
    });
    it('finanzas: pagos sí, editar datos no', () => {
        const p = permissionsFor('finance', false);
        expect(p.has('payments.write')).toBe(true);
        expect(p.has('registrations.update')).toBe(false);
    });
    it('staff: editar y check-in sí, pagos no', () => {
        const p = permissionsFor('staff', false);
        expect(p.has('checkin.write')).toBe(true);
        expect(p.has('payments.write')).toBe(false);
    });
    it('viewer: solo lectura', () => {
        expect([...permissionsFor('viewer', false)]).toEqual(['registrations.read']);
    });
});

describe('subdominios y CORS', () => {
    it('reconoce cliente, plataforma o nada', () => {
        expect(matchHost('pacific.localhost')).toEqual({ kind: 'tenant', slug: 'pacific' });
        expect(matchHost('app.localhost')).toEqual({ kind: 'platform' });
        expect(matchHost('localhost')).toEqual({ kind: 'none' });
        expect(matchHost('a.b.localhost')).toEqual({ kind: 'none' });
    });
    it('CORS: subdominios del dominio base sí; http fuera de localhost no', () => {
        expect(isAllowedOrigin('http://pacific.localhost:4200')).toBe(true);
        expect(isAllowedOrigin('http://localhost:4200')).toBe(true);
        expect(isAllowedOrigin('https://evil.example')).toBe(false);
        expect(isAllowedOrigin(undefined)).toBe(true);
    });
});
