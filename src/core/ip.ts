import { isIPv4, isIPv6 } from 'node:net';

/**
 * IP → 16 bytes (VARBINARY(16)). IPv4 se guarda como IPv4-mapped
 * (::ffff:a.b.c.d), igual que INET6_ATON en MySQL.
 */
export function ipToBuffer(ip: string | undefined | null): Buffer | null {
    if (!ip) return null;
    let value = ip.trim().split('%')[0];

    if (isIPv4(value)) value = `::ffff:${value}`;
    if (!isIPv6(value)) return null;

    // Último bloque en notación IPv4 (::ffff:1.2.3.4) → dos grupos hex
    const lastColon = value.lastIndexOf(':');
    const last = value.slice(lastColon + 1);
    if (isIPv4(last)) {
        const [a, b, c, d] = last.split('.').map(Number);
        value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }

    const toGroups = (s: string) => (s ? s.split(':').map(h => parseInt(h, 16)) : []);
    let groups: number[];
    if (value.includes('::')) {
        const [head, tail] = value.split('::');
        const h = toGroups(head);
        const t = toGroups(tail);
        groups = [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
    } else {
        groups = toGroups(value);
    }
    if (groups.length !== 8 || groups.some(g => Number.isNaN(g))) return null;

    const buf = Buffer.alloc(16);
    groups.forEach((g, i) => buf.writeUInt16BE(g, i * 2));
    return buf;
}
