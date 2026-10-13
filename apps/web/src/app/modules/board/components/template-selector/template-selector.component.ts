import {
  ChangeDetectionStrategy,
  Component,
  inject,
  output,
} from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { BUILTIN_TEMPLATES, type BuiltinTemplate } from '@tapiz/board-commons';
import { TemplateInsertService } from './template-insert.service';
import { SavedTemplatesComponent } from './saved-templates.component';

interface Preview {
  image: string;
  width: number;
  height: number;
}

type Template = BuiltinTemplate & Preview;

// previews stay in the web assets; the template data lives in board-commons
const PREVIEWS: Record<string, Preview> = {
  'movie-retrospective': {
    image: 'assets/templates/movie-retrospective/thumbnail-v1.webp',
    width: 360,
    height: 280,
  },
  'stop-start-continue': {
    image: 'assets/templates/stop-start-continue.webp',
    width: 300,
    height: 142,
  },
  sailboat: {
    image: 'assets/templates/sailboat.webp',
    width: 300,
    height: 183,
  },
  'mad-sad-glad': {
    image: 'assets/templates/mad-sad-glad.webp',
    width: 300,
    height: 204,
  },
  starfish: {
    image: 'assets/templates/starfish.webp',
    width: 300,
    height: 244,
  },
};

@Component({
  selector: 'tapiz-template-selector',
  imports: [NgOptimizedImage, SavedTemplatesComponent],
  template: `<div class="templates">
      @for (template of elements; track template.id) {
        <button
          class="template"
          type="button"
          [disabled]="busy()"
          (click)="create(template)">
          <img
            [ngSrc]="template.image"
            [width]="template.width"
            [height]="template.height" />
          <p>{{ template.name }}</p>
        </button>
      }
    </div>
    <tapiz-saved-templates (selected)="selected.emit()" />`,
  styleUrl: './template-selector.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplateSelectorComponent {
  #templateInsert = inject(TemplateInsertService);

  selected = output();
  busy = this.#templateInsert.busy;

  elements: Template[] = BUILTIN_TEMPLATES.map((template) => ({
    ...template,
    ...PREVIEWS[template.slug],
  }));

  async create(template: Template) {
    const inserted = await this.#templateInsert.insertFrom(() =>
      template.load(),
    );

    if (inserted) {
      this.selected.emit();
    }
  }
}
