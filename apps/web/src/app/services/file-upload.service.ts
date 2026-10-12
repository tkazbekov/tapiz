import { Injectable, inject } from '@angular/core';
import { ConfigService } from './config.service';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { EMPTY, Observable, catchError, map, switchMap, take, zip } from 'rxjs';
import { boardPageFeature } from '../modules/board/reducers/boardPage.reducer';
import { appFeature } from '../+state/app.reducer';
import { authErrorCode } from '../modules/auth/auth-errors';
import { Store } from '@ngrx/store';
import { getImageDimensions } from '@tapiz/cdk/utils/image-dimensions';
import { BoardActions } from '../modules/board/actions/board.actions';
import { NodesActions } from '../modules/board/services/nodes-actions';
import { Image } from '@tapiz/board-commons';
import { BoardPageActions } from '../modules/board/actions/board-page.actions';

@Injectable({
  providedIn: 'root',
})
export class FileUploadService {
  #configService = inject(ConfigService);
  #http = inject(HttpClient);
  #store = inject(Store);
  #nodesActions = inject(NodesActions);
  #snackBar = inject(MatSnackBar);
  #router = inject(Router);
  #isGuest = this.#store.selectSignal(appFeature.selectIsGuest);

  upload(boardId: string, file: File): Observable<{ url: string }> {
    if (this.#configService.config.DEMO) {
      return new Observable((subscriber) => {
        const reader = new FileReader();

        reader.onloadend = () => {
          subscriber.next({ url: reader.result as string });
          subscriber.complete();
        };

        reader.readAsDataURL(file);
      });
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('boardId', boardId);

    return this.#http.post<{ url: string }>(
      `${this.#configService.config.API_URL}/upload-file-board`,
      formData,
    );
  }

  addFilesToBoard(
    files: File[],
    initialPosition?: {
      x: number;
      y: number;
    },
  ): void {
    const images = files.filter((file) => file.type.startsWith('image'));

    if (!images.length) {
      return;
    }

    // the api refuses guest uploads too, this saves the round trip
    if (this.#isGuest()) {
      this.#accountRequired();
      return;
    }

    this.#store.dispatch(BoardPageActions.setLoadingBar({ loadingBar: true }));

    zip(
      this.#store.select(boardPageFeature.selectZoom),
      this.#store.select(boardPageFeature.selectPosition),
      this.#store.select(boardPageFeature.selectBoardId),
      this.#store.select(boardPageFeature.selectBoardMode),
    )
      .pipe(take(1))
      .subscribe(([zoom, position, boardId, layer]) => {
        images.forEach((image) => {
          this.upload(boardId, image)
            .pipe(
              switchMap(({ url }) => {
                const fullUrl =
                  this.#configService.config.API_URL + '/uploads/' + url;

                return getImageDimensions(fullUrl).pipe(
                  map(({ width, height }) => {
                    return {
                      url,
                      width,
                      height,
                    };
                  }),
                );
              }),
              catchError((error) => {
                this.#store.dispatch(
                  BoardPageActions.setLoadingBar({ loadingBar: false }),
                );

                if (authErrorCode(error) === 'ACCOUNT_REQUIRED') {
                  this.#accountRequired();
                } else {
                  this.#snackBar.open('Could not upload the image', 'Close', {
                    duration: 4000,
                  });
                }

                return EMPTY;
              }),
            )
            .subscribe(({ url, width, height }) => {
              if (!initialPosition) {
                initialPosition = {
                  x: document.body.clientWidth / 2,
                  y: document.body.clientHeight / 2,
                };
              }

              this.#store.dispatch(
                BoardPageActions.setLoadingBar({ loadingBar: false }),
              );

              this.#store.dispatch(
                BoardActions.batchNodeActions({
                  history: true,
                  actions: [
                    this.#nodesActions.add<Image>('image', {
                      url,
                      width,
                      height,
                      position: {
                        x:
                          -position.x / zoom +
                          initialPosition.x / zoom -
                          width / 2,
                        y:
                          -position.y / zoom +
                          initialPosition.y / zoom -
                          height / 2,
                      },
                      layer,
                      rotation: 0,
                    }),
                  ],
                }),
              );
            });
        });
      });
  }

  #accountRequired() {
    this.#snackBar
      .open('Create an account to upload images', 'Create account', {
        duration: 6000,
      })
      .onAction()
      .subscribe(() => {
        void this.#router.navigate(['/register'], {
          queryParams: { returnUrl: this.#router.url, from: 'guest' },
        });
      });
  }
}
