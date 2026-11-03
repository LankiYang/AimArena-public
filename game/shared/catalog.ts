// Identifiers remain stable on the wire; presentation is local to this catalog.
export type MapId = 'ascent' | 'bonsai' | 'infinity' | 'jam' | 'plummet' | 'triad';
export type Mode = 'tdm' | 'snd' | 'infection';
export type Difficulty = 'easy' | 'normal' | 'hard' | 'expert';
export type AgentId = 'jett' | 'neon' | 'omen' | 'skye' | 'cypher' | 'chamber';
export type Team = 0 | 1;

export interface MapInfo { id: MapId; name: string; en: string; art: string; cover: boolean; sites: string[] }
export const MAPS: MapInfo[] = [
  { id: 'ascent', name: '中央竞技场', en: 'CENTRAL ARENA', art: 'ascent', cover: false, sites: ['A', 'B'] },
  { id: 'bonsai', name: '交错走廊', en: 'CROSSING', art: 'bonsai', cover: false, sites: ['A', 'B'] },
  { id: 'infinity', name: '双环', en: 'TWIN RINGS', art: 'infinity', cover: false, sites: ['A', 'B'] },
  { id: 'jam', name: '三路', en: 'THREE LANES', art: 'jam', cover: false, sites: ['A', 'B', 'C'] },
  { id: 'plummet', name: '前哨', en: 'OUTPOST', art: 'plummet', cover: false, sites: ['A', 'B'] },
  { id: 'triad', name: '三角阵地', en: 'TRIANGLE', art: 'triad', cover: false, sites: ['A', 'B', 'C'] },
];
export const MAP_BY_ID = Object.fromEntries(MAPS.map(m => [m.id, m])) as Record<MapId, MapInfo>;
export interface AgentInfo { id: AgentId; name: string; en: string; role: string; model: string; color: string }
export const AGENTS: AgentInfo[] = [
  { id: 'jett', name: '队员一', en: 'SCOUT', role: '突击', model: 'scout', color: '#8ecae6' },
  { id: 'neon', name: '队员二', en: 'RUNNER', role: '突击', model: 'runner', color: '#729de0' },
  { id: 'skye', name: '队员三', en: 'RANGER', role: '支援', model: 'ranger', color: '#83bd8b' },
  { id: 'omen', name: '队员四', en: 'WARDEN', role: '支援', model: 'warden', color: '#9186bb' },
  { id: 'cypher', name: '队员五', en: 'WATCHER', role: '防守', model: 'watcher', color: '#c5b9a3' },
  { id: 'chamber', name: '队员六', en: 'GUARD', role: '防守', model: 'guard', color: '#c9ad73' },
];
export const AGENT_BY_ID = Object.fromEntries(AGENTS.map(a => [a.id, a])) as Record<AgentId, AgentInfo>;
export const MODES: Record<Mode, { name: string; en: string; desc: string }> = {
  tdm: { name: '团队对抗', en: 'TEAM MATCH', desc: '双方争夺击杀，阵亡后重新加入。' },
  snd: { name: '攻防', en: 'ATTACK AND DEFEND', desc: '进攻方安放装置，防守方阻止或拆除。' },
  infection: { name: '感染', en: 'INFECTION', desc: '感染者追击人类，存活至时限决定胜负。' },
};
export const DIFFICULTIES: Record<Difficulty, { name: string }> = {
  easy: { name: '简单' }, normal: { name: '普通' }, hard: { name: '困难' }, expert: { name: '专家' },
};
export const TEAM_NAMES = { tdm: ['红队', '蓝队'], snd: ['进攻方', '防守方'], infection: ['人类', '感染者'] } as const;
export const MAX_TEAM_SIZE = 5;
export const isMapId = (v: unknown): v is MapId => typeof v === 'string' && Object.prototype.hasOwnProperty.call(MAP_BY_ID, v);
export const isAgentId = (v: unknown): v is AgentId => typeof v === 'string' && Object.prototype.hasOwnProperty.call(AGENT_BY_ID, v);
export const isMode = (v: unknown): v is Mode => v === 'tdm' || v === 'snd' || v === 'infection';
export const isDifficulty = (v: unknown): v is Difficulty => typeof v === 'string' && Object.prototype.hasOwnProperty.call(DIFFICULTIES, v);
