import type { ServerWorld } from './world.ts';
// Ordered room execution protocol. Only data crosses the thread boundary; sockets stay in net.ts.
import type { AgentId } from '../shared/catalog.ts';
import type { BuyItem } from '../shared/economy.ts';
import type { Member, RoomInfo, S2C } from '../shared/lobby.ts';
import type { WeaponId } from '../shared/combat.ts';

export interface RoomClientData {
  id: number; name: string; agent: AgentId; build: string;
  mapRopeRevision?: number; parked: boolean; epoch: number;
}
export interface RoomData {
  info: RoomInfo;
  clients: RoomClientData[];
}
export type RoomCommand =
  | { t: 'create'; data: RoomData; world: ServerWorld }
  | { t: 'sync'; data: RoomData }
  | { t: 'input'; id: number; epoch: number; data: Uint8Array }
  | { t: 'loaded'; id: number }
  | { t: 'left'; id: number }
  | { t: 'join'; member: Member; replaceBotId: number | null }
  | { t: 'resume'; id: number; epoch: number }
  | { t: 'weapon'; id: number; weapon: WeaponId }
  | { t: 'buy'; id: number; item: BuyItem }
  | { t: 'spectate'; id: number; dir: 1 | -1 }
  | { t: 'dispose' };
export type ToRoomWorker =
  | { t: 'commands'; seq: number; commands: { key: number; command: RoomCommand }[] }
  | { t: 'outputAck'; seq: number };
export type RoomEvent =
  | { t: 'json'; id: number; epoch: number; message: S2C }
  | { t: 'binary'; id: number; epoch: number; data: Uint8Array }
  | { t: 'state'; state: RoomInfo['state'] }
  | { t: 'end' }
  | { t: 'disposed' };
export type FromRoomWorker =
  | { t: 'ack'; seq: number }
  | { t: 'event'; key: number; seq: number; event: RoomEvent };
