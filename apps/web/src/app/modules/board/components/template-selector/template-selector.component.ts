import {
  ChangeDetectionStrategy,
  Component,
  inject,
  output,
} from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { TuNode, fromLegacyTemplate } from '@tapiz/board-commons';
import { TemplaNode } from './template-node.model';
import { TemplateInsertService } from './template-insert.service';
import { SavedTemplatesComponent } from './saved-templates.component';

interface Template {
  title: string;
  image: string;
  width: number;
  height: number;
  load: () => Promise<{ getTemplate: () => TuNode<TemplaNode>[] }>;
}

@Component({
  selector: 'tapiz-template-selector',
  imports: [NgOptimizedImage, SavedTemplatesComponent],
  template: `<div class="templates">
      @for (template of elements; track template.title) {
        <button
          class="template"
          type="button"
          [disabled]="busy()"
          (click)="create(template)">
          <img
            [ngSrc]="template.image"
            [width]="template.width"
            [height]="template.height" />
          <p>{{ template.title }}</p>
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

  elements: Template[] = [
    {
      title: 'Stop, Start, Continue',
      image: 'assets/templates/stop-start-continue.webp',
      width: 300,
      height: 142,
      load: () => {
        return import('./templates/stop-start-continue');
      },
    },
    {
      title: 'Sailboat',
      image: 'assets/templates/sailboat.webp',
      width: 300,
      height: 183,
      load: () => {
        return import('./templates/sailboat');
      },
    },
    {
      title: 'Mad, Sad, Glad',
      image: 'assets/templates/mad-sad-glad.webp',
      width: 300,
      height: 204,
      load: () => {
        return import('./templates/mad-sad-glad');
      },
    },
    {
      title: 'Starfish',
      image: 'assets/templates/starfish.webp',
      width: 300,
      height: 244,
      load: () => {
        return import('./templates/starfish');
      },
    },
  ];

  async create(template: Template) {
    const inserted = await this.#templateInsert.insertFrom(async () =>
      fromLegacyTemplate((await template.load()).getTemplate()),
    );

    if (inserted) {
      this.selected.emit();
    }
  }
}
