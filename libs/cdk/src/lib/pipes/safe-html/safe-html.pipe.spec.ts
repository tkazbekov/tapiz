// @vitest-environment jsdom
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { SafeHtmlPipe } from './safe-html.pipe';

describe('SafeHtmlPipe', () => {
  const trusted: string[] = [];
  const injector = Injector.create({
    providers: [
      {
        provide: DomSanitizer,
        useValue: {
          bypassSecurityTrustHtml: (html: string) => {
            trusted.push(html);

            return html;
          },
        },
      },
    ],
  });
  const pipe = runInInjectionContext(injector, () => new SafeHtmlPipe());

  beforeEach(() => {
    trusted.length = 0;
  });

  it('sanitizes before trusting the html', () => {
    pipe.transform(
      '<img src=x onerror="alert(document.domain)"><p onclick="alert(1)">hi <a href="javascript:alert(1)">x</a></p>',
    );

    expect(trusted).toEqual(['<p>hi <a>x</a></p>']);
  });

  it('keeps editor formatting and mentions', () => {
    const html =
      '<p style="text-align: center"><span style="color: #ff0000; font-size: 24px">red</span> ' +
      '<span data-type="mention" data-id="u1" data-label="Ana" data-mention-suggestion-char="@">@Ana</span> ' +
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">link</a></p>';

    pipe.transform(html);

    expect(trusted).toEqual([html]);
  });

  it('handles empty values', () => {
    pipe.transform(null);

    expect(trusted).toEqual(['']);
  });
});
