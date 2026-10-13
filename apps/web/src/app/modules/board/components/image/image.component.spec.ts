import { Input, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Store } from '@ngrx/store';
import type { Image, TuNode } from '@tapiz/board-commons';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../../../services/config.service';
import { ImageComponent } from './image.component';

// JIT specs skip the compiler step that marks signal inputs, so it's done here
for (const name of ['node', 'pasted', 'focus']) {
  Input({ alias: name, required: true, isSignal: true } as Input)(
    ImageComponent.prototype,
    name,
  );
}

describe('ImageComponent url', () => {
  const apiUrl = 'https://api.example.test';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: Store, useValue: { dispatch: () => undefined } },
        { provide: ConfigService, useValue: { config: { API_URL: apiUrl } } },
      ],
    });
    TestBed.overrideComponent(ImageComponent, {
      set: {
        template: '',
        styleUrls: [],
        imports: [],
        providers: [],
      },
    });
  });

  const urlOf = (url: string) => {
    const fixture = TestBed.createComponent(ImageComponent);
    const node: TuNode<Image> = {
      id: 'image-1',
      type: 'image',
      content: {
        url,
        position: { x: 0, y: 0 },
        width: 100,
        height: 100,
        layer: 0,
        rotation: 0,
      },
    };

    fixture.componentRef.setInput('node', node);
    fixture.componentRef.setInput('pasted', false);
    fixture.componentRef.setInput('focus', false);
    fixture.detectChanges();

    return fixture.componentInstance.url();
  };

  it('keeps template art shipped with the web app as a same-origin path', () => {
    expect(urlOf('assets/templates/x/a.webp')).toBe(
      'assets/templates/x/a.webp',
    );
  });

  it('serves bare file names from the board uploads', () => {
    expect(urlOf('a1b2.webp')).toBe(`${apiUrl}/uploads/a1b2.webp`);
  });

  it('does not treat a traversal out of the template art as app art', () => {
    expect(urlOf('assets/templates/../a.webp')).toBe(
      `${apiUrl}/uploads/assets/templates/../a.webp`,
    );
  });

  it('keeps absolute and data urls', () => {
    expect(urlOf('https://cdn.example.test/a.png')).toBe(
      'https://cdn.example.test/a.png',
    );
    expect(urlOf('data:image/png;base64,AAAA')).toBe(
      'data:image/png;base64,AAAA',
    );
  });
});
