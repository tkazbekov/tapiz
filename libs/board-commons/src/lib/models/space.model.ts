import { Board } from './board.model.js';

export type SpaceBoard = Pick<Board, 'id' | 'name'>;

export interface Space {
  id: string;
  teamId: string;
  name: string;
  boards: SpaceBoard[];
}
