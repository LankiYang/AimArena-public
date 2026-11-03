import type { AgentId, Difficulty, MapId, Mode, Team } from './catalog.ts';
import type { CombatUpdate, WeaponId } from './combat.ts';
import type { BuyCommand, BuyResult } from './protocol.ts';
import type { InfectionState } from './infection.ts';
import type { TdmReason } from './tdm.ts';

export interface RoomSettings { mode: Mode; map: MapId; teamSize: number; scoreLimit: number; fillBots: boolean; botDifficulty: Difficulty }
export const DEFAULT_SETTINGS: RoomSettings = { mode: 'tdm', map: 'ascent', teamSize: 5, scoreLimit: 50, fillBots: true, botDifficulty: 'normal' };
export const SCORE_LIMITS: Record<Mode, number[]> = { tdm: [30, 50, 80, 100], snd: [5, 7, 13], infection: [1] };
export interface Member { id: number; name: string; bot: boolean; team: Team | -1; agent: AgentId; ready: boolean; difficulty?: Difficulty; offline?: boolean }
export type RoomState = 'waiting' | 'loading' | 'playing' | 'ended';
export function hasMatchSeat(members: Member[], teamSize: number): boolean {
  const counts = [0, 0];
  for (const member of members) {
    if (member.team === -1) continue;
    if (member.bot) return true;
    counts[member.team]++;
  }
  return counts[0] < teamSize || counts[1] < teamSize;
}
export interface RoomInfo { id: string; name: string; hostId: number; priv: boolean; settings: RoomSettings; members: Member[]; state: RoomState }
export interface RoomSummary { id: string; name: string; mode: Mode; map: MapId; humans: number; bots: number; max: number; state: RoomState; host: string; joinable: boolean }
export interface MatchStats { t: 'matchStats'; matchId: string; you: number; kills: number; deaths: number; final?: boolean }
export interface MatchScoreRow { id: number; name: string; agent: AgentId; team: Team; bot: boolean; kills: number; deaths: number; assists: number; alive: boolean }
export interface MatchBoard { t: 'matchBoard'; matchId: string; tick: number; teamKills: [number, number]; rounds?: [number, number]; players: MatchScoreRow[] }
export interface SndMatchSummary { wins: [number, number]; rounds: number }
export interface TdmMatchSummary { target: number; kills: [number, number]; reason: TdmReason }
export type C2S =
  | { t: 'hello'; name: string; agent: AgentId; session?: string; build?: string; mapRopeRevision?: number }
  | { t: 'latencyPing'; token: number }
  | { t: 'profile'; name?: string; agent?: AgentId }
  | { t: 'socialRegister'; code: string }
  | { t: 'socialRequest'; code: string }
  | { t: 'socialAccept'; code: string }
  | { t: 'socialPresence'; codes: string[] }
  | { t: 'socialInvite'; code: string }
  | { t: 'listRooms' }
  | { t: 'createRoom'; name: string; priv?: boolean; settings: Partial<RoomSettings> }
  | { t: 'joinRoom'; id: string }
  | { t: 'leaveRoom' }
  | { t: 'setTeam'; team: Team | -1 }
  | { t: 'setReady'; ready: boolean }
  | { t: 'addBot'; team: Team; difficulty?: Difficulty }
  | { t: 'setBot'; id: number; team?: Team; difficulty?: Difficulty }
  | { t: 'fillBots'; team?: Team }
  | { t: 'kick'; id: number }
  | { t: 'settings'; settings: Partial<RoomSettings> }
  | { t: 'start' }
  | { t: 'quickPlay'; settings: Partial<RoomSettings> }
  | { t: 'chat'; text: string }
  | { t: 'loaded' }
  | { t: 'leaveMatch' }
  | { t: 'joinMatch' }
  | { t: 'transferHost'; id: number }
  | { t: 'selectWeapon'; weapon: WeaponId }
  | { t: 'spectateNext' } | { t: 'spectatePrev' } | { t: 'spectate-next' } | { t: 'spectate-prev' }
  | BuyCommand;
export type S2C =
  | { t: 'welcome'; id: number; name: string; version: number; build?: string; latencyProbe?: boolean; mapRopeRevision?: number }
  | { t: 'latencyPong'; token: number }
  | { t: 'rooms'; rooms: RoomSummary[] }
  | { t: 'room'; room: RoomInfo | null }
  | { t: 'error'; msg: string }
  | { t: 'socialRegistered'; code: string }
  | { t: 'socialRequest'; code: string; name: string }
  | { t: 'socialRequestCancelled'; code: string }
  | { t: 'socialAccepted'; code: string; name: string }
  | { t: 'socialPresence'; online: string[] }
  | { t: 'socialInvite'; code: string; name: string; roomId: string }
  | { t: 'socialError'; message: string }
  | { t: 'chat'; from: number; name: string; text: string; sys?: boolean }
  | { t: 'matchLoad'; matchId: string; settings: RoomSettings; you: number; team: Team | -1 }
  | { t: 'queue'; map: MapId; position: number; total: number; residentBytes: number; budgetBytes: number }
  | { t: 'matchEnd'; winner: Team | -1; summary: SndMatchSummary | TdmMatchSummary | null }
  | InfectionState | MatchStats | MatchBoard | BuyResult | CombatUpdate;
export const PROTOCOL_VERSION = 5;
export const CLIENT_VERSION = '1.2.4';
