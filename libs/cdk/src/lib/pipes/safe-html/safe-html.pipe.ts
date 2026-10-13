import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { sanitizeRichText } from '../../utils/sanitize-rich-text';

// Renders user rich text: DOMPurify removes anything outside the editor
// allowlist, then Angular is told not to strip the remaining inline styles.
@Pipe({
  name: 'safeHtml',
})
export class SafeHtmlPipe implements PipeTransform {
  private sanitizer = inject(DomSanitizer);

  public transform(html: string | null | undefined) {
    return this.sanitizer.bypassSecurityTrustHtml(sanitizeRichText(html));
  }
}
