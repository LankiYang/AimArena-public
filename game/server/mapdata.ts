import type { MapId } from '../shared/catalog.ts';
import { getPublicMapData } from '../shared/public-map.ts';
export { sitePoint, inSite } from '../shared/mapdata.ts';
export const getMapData = (map: MapId) => getPublicMapData(map);
