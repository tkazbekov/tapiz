import { ActivatedRouteSnapshot, Route } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { BoardRouteReuseStrategy } from './board-route-reuse.strategy';

const snapshot = (routeConfig: Route, params: Record<string, string>) =>
  ({ routeConfig, params }) as unknown as ActivatedRouteSnapshot;

describe('BoardRouteReuseStrategy', () => {
  const strategy = new BoardRouteReuseStrategy();
  const board: Route = { path: 'board/:id' };
  const team: Route = { path: 'team/:teamId' };

  it('recreates the board component for another board', () => {
    expect(
      strategy.shouldReuseRoute(
        snapshot(board, { id: 'b' }),
        snapshot(board, { id: 'a' }),
      ),
    ).toBe(false);
  });

  it('reuses the board component for the same board', () => {
    expect(
      strategy.shouldReuseRoute(
        snapshot(board, { id: 'a' }),
        snapshot(board, { id: 'a' }),
      ),
    ).toBe(true);
  });

  it('keeps the default reuse for other routes', () => {
    expect(
      strategy.shouldReuseRoute(
        snapshot(team, { teamId: 'b' }),
        snapshot(team, { teamId: 'a' }),
      ),
    ).toBe(true);
  });
});
