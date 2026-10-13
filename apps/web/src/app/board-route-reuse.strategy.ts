import { Injectable } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  BaseRouteReuseStrategy,
} from '@angular/router';

// BoardComponent loads its board once, so moving from one board to another
// (notifications, back/forward) must create a new component.
@Injectable()
export class BoardRouteReuseStrategy extends BaseRouteReuseStrategy {
  override shouldReuseRoute(
    future: ActivatedRouteSnapshot,
    curr: ActivatedRouteSnapshot,
  ): boolean {
    if (
      future.routeConfig === curr.routeConfig &&
      future.routeConfig?.path === 'board/:id'
    ) {
      return future.params['id'] === curr.params['id'];
    }

    return super.shouldReuseRoute(future, curr);
  }
}
