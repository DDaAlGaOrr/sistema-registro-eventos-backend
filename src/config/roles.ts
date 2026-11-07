export const ROLES = ['developer', 'superadmin', 'finanzas', 'staff', 'admin', 'vicePresident'] as const;
export type Role = typeof ROLES[number];

/**
 * Qué roles pueden hacer cada acción. La API es la que decide;
 * el Front solo oculta botones.
 *   developer / superadmin : todo
 *   finanzas               : pagos
 *   staff                  : datos de registrados y check-in
 *   admin / vicePresident  : solo lectura
 */
export const PERMISSIONS = {
    read: ROLES,
    editRegister: ['developer', 'superadmin', 'staff', 'finanzas'],
    deleteRegister: ['developer', 'superadmin', 'staff'],
    checkIn: ['developer', 'superadmin', 'staff'],
    payments: ['developer', 'superadmin', 'finanzas'],
    viewLogs: ['developer'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Campos de un registro que se pueden editar desde el panel. */
export const PAYMENT_FIELDS = ['pago_camiseta', 'pago_lunchtime'] as const;

export const DATA_FIELDS = [
    'nombre', 'apellidos', 'correo', 'telefono', 'fecha_nacimiento', 'genero',
    'estado_id', 'conferencia_id', 'ciudad', 'iglesia', 'es_chaperon',
    'tipo_alimento', 'alimento_especial_nota', 'talla_camiseta_id',
] as const;

export const CHECKIN_FIELDS = ['checkin_at'] as const;

export type EditableField =
    | typeof PAYMENT_FIELDS[number]
    | typeof DATA_FIELDS[number]
    | typeof CHECKIN_FIELDS[number];

const ALL_FIELDS: readonly EditableField[] = [...DATA_FIELDS, ...PAYMENT_FIELDS, ...CHECKIN_FIELDS];

/** Campos que cada rol puede modificar en "editar registro". */
export const EDITABLE_FIELDS_BY_ROLE: Partial<Record<Role, readonly EditableField[]>> = {
    developer: ALL_FIELDS,
    superadmin: ALL_FIELDS,
    staff: [...DATA_FIELDS, ...CHECKIN_FIELDS],
    // Igual que el Front actual: finanzas edita pagos, talla y tipo de alimento
    finanzas: [...PAYMENT_FIELDS, 'talla_camiseta_id', 'tipo_alimento'],
};

export const hasPermission = (role: string | undefined, permission: Permission): boolean =>
    !!role && (PERMISSIONS[permission] as readonly string[]).includes(role);
