import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LiveReactionStore } from './live-reaction.store';

const EMOJI_SIZE = 200 as const;

@Component({
  selector: 'tapiz-live-reaction-wall',
  imports: [],
  template: `
    @for (emoji of emojis(); track $index) {
      <div
        animate.enter="fade-in"
        animate.leave="fade-out"
        class="emoji"
        [style.left.px]="emoji.position.x - EMOJI_SIZE / 2"
        [style.top.px]="emoji.position.y - EMOJI_SIZE / 2">
        <img
          [width]="EMOJI_SIZE"
          [height]="EMOJI_SIZE"
          [src]="emoji.url" />
      </div>
    }
  `,
  host: {
    '[style.--emoji-size]': `'${EMOJI_SIZE}px'`,
  },
  styleUrls: ['./live-reaction-wall.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveReactionWallComponent {
  #liveReactionStore = inject(LiveReactionStore);
  EMOJI_SIZE = EMOJI_SIZE;

  emojis = this.#liveReactionStore.emojis;
}
