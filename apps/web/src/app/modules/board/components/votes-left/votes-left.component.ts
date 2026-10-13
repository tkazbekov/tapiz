import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { VotesService } from '../../services/votes.service';

@Component({
  selector: 'tapiz-votes-left',
  imports: [MatIconModule],
  template: `
    <mat-icon>how_to_vote</mat-icon>
    {{ label() }}
  `,
  styleUrl: './votes-left.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.empty]': 'votesLeft() === 0',
  },
})
export class VotesLeftComponent {
  #votesService = inject(VotesService);

  votesLeft = this.#votesService.votesLeft;

  label = computed(() => {
    const budget = this.#votesService.budget();

    if (budget === null) {
      return 'Unlimited votes';
    }

    return `${this.votesLeft()} of ${budget} votes left`;
  });
}
