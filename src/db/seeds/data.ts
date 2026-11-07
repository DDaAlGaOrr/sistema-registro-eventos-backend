/** Datos base del catálogo global. */

export const US_STATES: ReadonlyArray<[code: string, name: string]> = [
    ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
    ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
    ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
    ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
    ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'],
    ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
    ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
    ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
    ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
    ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
    ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'],
    ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
    ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];

export interface ConferenceSeed {
    name: string;
    shortName: string;
    states: string[];
}

export interface UnionSeed {
    name: string;
    shortName: string;
    conferences: ConferenceSeed[];
}

/**
 * Uniones conocidas. Por ahora solo la Pacific Union (primer cliente, FEJA 2026).
 * Los códigos cortos de las asociaciones son los mismos que usaba V1
 * (tabla conferencias.codigo), para poder cruzar los datos al migrar.
 */
export const UNIONS: UnionSeed[] = [
    {
        name: 'Pacific Union Conference',
        shortName: 'PUC',
        conferences: [
            { name: 'Arizona Conference', shortName: 'AZ', states: ['AZ'] },
            { name: 'Central California Conference', shortName: 'CCC', states: ['CA'] },
            { name: 'Hawaii Conference', shortName: 'HIC', states: ['HI'] },
            { name: 'Nevada-Utah Conference', shortName: 'NUC', states: ['NV', 'UT'] },
            { name: 'Northern California Conference', shortName: 'NCC', states: ['CA'] },
            { name: 'Southeastern California Conference', shortName: 'SECC', states: ['CA'] },
            { name: 'Southern California Conference', shortName: 'SCC', states: ['CA'] },
        ],
    },
];
