/**
 * 30 oct 2026 -- Fase 1 del plan de integración de Harvey
 * (github.com/ethanplusai/harvey, MIT): descubrimiento de negocios vía
 * OpenStreetMap (Overpass API), gratis, sin cuenta, sin API key, sin proxy.
 * Puerto del patrón real de `harvey/collectors/discover.py`'s `OpenStreetMap`
 * provider -- mismo diseño (varios espejos de Overpass con backoff, mapa de
 * tags curado a mano en vez de un fallback genérico), reescrito en
 * TypeScript/fetch nativo (sin dependencias nuevas).
 *
 * Por qué esto importa hoy: es la única fuente de negocios locales de este
 * proyecto que NO depende del proxy residencial ni de que Google muestre el
 * Local Pack -- ambos demostraron ser poco confiables hoy mismo (ver
 * google/parse.ts y shared/setup.ts).
 *
 * Cobertura real (confirmado contra taginfo.openstreetmap.org, no supuesta):
 * OSM mapea locales físicos, así que rubros con poca presencia de local
 * (ej. "nutritionist" -- `healthcare=nutrition_counselling`, solo 290 usos
 * en TODO el mundo) van a dar muy pocos o cero resultados. Rubros con
 * tradición de mapeo ciudadano (dentist: 162.347, lawyer, electrician,
 * plumber, roofer, hvac, contractor) tienen cobertura real y útil. El
 * TAG_MAP de abajo es deliberadamente angosto -- un rubro no mapeado tira
 * error en vez de inventar resultados con un tag genérico (mismo criterio
 * que Harvey, ver el comentario de `_tags()` en su código real).
 */

export interface OsmBusiness {
    name: string;
    phone?: string;
    website?: string;
    address?: string;
    city?: string;
    category?: string;
    osmUrl: string;
    source: 'osm';
}

/** Un término amigable -> los tags reales de OSM que lo cubren. Ampliable. */
const TAG_MAP: Record<string, string[]> = {
    dentist: ['amenity=dentist'],
    lawyer: ['office=lawyer'],
    attorney: ['office=lawyer'],
    roof: ['craft=roofer', 'shop=roofing'],
    plumb: ['craft=plumber'],
    hvac: ['craft=hvac'],
    electric: ['craft=electrician'],
    contractor: ['craft=builder', 'office=construction_company'],
    landscap: ['craft=gardener', 'shop=garden_centre'],
    // Cobertura real confirmada MUY baja (290 usos mundiales en taginfo) --
    // probado en vivo contra LA real: 0 resultados con este tag puntual.
    // Deliberadamente NO se agrega `office=therapist` como fallback -- se
    // probó en vivo (30 oct 2026) y devuelve terapeutas de salud mental
    // (psicólogos, terapia familiar), rubro distinto, no nutricionistas.
    // Mismo criterio que Harvey: mejor 0 resultados honestos que leads del
    // rubro equivocado. Para volumen real de este rubro, usar el proveedor
    // de Google (Local Pack), no OSM.
    nutrition: ['healthcare=nutrition_counselling'],
    dietitian: ['healthcare=nutrition_counselling'],
    veterinar: ['amenity=veterinary'],
    chiroprac: ['healthcare=chiropractor'],
    physical_therap: ['healthcare=physiotherapist'],
    physiotherap: ['healthcare=physiotherapist'],
};

export const SUPPORTED_TERMS = Object.keys(TAG_MAP);

function tagsFor(term: string): string[] {
    const low = term.toLowerCase();
    for (const [needle, tags] of Object.entries(TAG_MAP)) {
        if (low.includes(needle)) return tags;
    }
    return [];
}

/** Geocodifica "Los Angeles, CA" -> {lat, lng} vía Nominatim (gratis, 1 req/seg, requiere User-Agent real). */
async function geocode(location: string): Promise<{ lat: number; lng: number } | null> {
    const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: location, format: 'json', limit: '1' })}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Sandalphon/0.1 (ALEX IO prospecting tool)' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { lat: string; lon: string }[];
    if (!data.length) return null;
    return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
}

// Mismos 3 espejos públicos que usa Harvey -- el principal se satura seguido.
const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
];
const BACKOFF_MS = 5000;

async function queryOverpass(body: string): Promise<{ elements: Record<string, any>[] }> {
    for (let i = 0; i < ENDPOINTS.length; i++) {
        if (i) await new Promise((r) => setTimeout(r, BACKOFF_MS));
        let res: Response;
        try {
            res = await fetch(ENDPOINTS[i], {
                method: 'POST',
                body,
                headers: { 'User-Agent': 'Sandalphon/0.1 (ALEX IO prospecting tool; +https://github.com/vibecloudonline-gif/Sandalphon)' },
            });
        } catch {
            continue; // espejo inalcanzable, probar el siguiente
        }
        if (res.status === 429 || res.status === 504) continue; // saturado, probar el siguiente
        if (!res.ok) throw new Error(`Overpass respondió ${res.status}`);
        return (await res.json()) as { elements: Record<string, any>[] };
    }
    throw new Error('Los 3 espejos públicos de Overpass están saturados ahora mismo -- es infraestructura gratuita de voluntarios, reintentar en unos minutos.');
}

export interface OsmSearchOptions {
    term: string;
    location: string;
    radiusKm?: number;
    maxResults?: number;
}

export async function searchOsm({ term, location, radiusKm = 25, maxResults = 50 }: OsmSearchOptions): Promise<OsmBusiness[]> {
    const tags = tagsFor(term);
    if (!tags.length) {
        throw new Error(
            `OpenStreetMap no tiene un rubro mapeado para "${term}". Rubros soportados: ${SUPPORTED_TERMS.join(', ')}. Usá el proveedor de Google para este rubro.`,
        );
    }
    const coord = await geocode(location);
    if (!coord) throw new Error(`No se pudo geocodificar "${location}" (Nominatim no encontró esa ubicación).`);

    const radiusM = Math.round(radiusKm * 1000);
    const clauses = tags
        .map((tag) => {
            const [k, v] = tag.split('=');
            return `node[${k}=${v}](around:${radiusM},${coord.lat},${coord.lng});way[${k}=${v}](around:${radiusM},${coord.lat},${coord.lng});`;
        })
        .join('');
    const body = `[out:json][timeout:40];(${clauses});out center ${maxResults};`;

    const { elements } = await queryOverpass(body);
    const out: OsmBusiness[] = [];
    for (const el of elements) {
        const t = el.tags || {};
        if (!t.name) continue; // mismo criterio que Harvey: sin nombre, no sirve como lead
        const city = [t['addr:city'], t['addr:state']].filter(Boolean).join(', ');
        const address = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
        out.push({
            name: t.name,
            phone: t.phone || t['contact:phone'] || undefined,
            website: t.website || t['contact:website'] || undefined,
            address: address || undefined,
            city: city || location,
            category: t.craft || t.shop || t.office || t.healthcare || t.amenity || undefined,
            osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
            source: 'osm',
        });
    }
    return out;
}
