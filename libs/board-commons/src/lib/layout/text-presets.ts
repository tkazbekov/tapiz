export type TextPreset =
  'display' | 'title' | 'heading' | 'subheading' | 'body' | 'label' | 'caption';

export interface TextPresetStyle {
  // null keeps the editor default (24px)
  fontSize: number | null;
  lineHeight: number;
  bold?: boolean;
  color?: string;
}

// every size is in the editor's font-size dropdown, so it shows after an edit
export const TEXT_PRESETS: Record<TextPreset, TextPresetStyle> = {
  display: { fontSize: 96, lineHeight: 1.1, bold: true },
  title: { fontSize: 64, lineHeight: 1.15, bold: true },
  heading: { fontSize: 40, lineHeight: 1.2, bold: true },
  subheading: { fontSize: 28, lineHeight: 1.25, bold: true },
  body: { fontSize: null, lineHeight: 1.3 },
  label: { fontSize: 20, lineHeight: 1.3, bold: true },
  caption: { fontSize: 18, lineHeight: 1.3, color: '#868e96' },
};

export const DEFAULT_FONT_SIZE = 24;

export interface TextBlock {
  preset: TextPreset;
  text: string;
  align?: 'left' | 'center' | 'right';
}

// the sanitizer serialises text with only these escaped (and nbsp as &nbsp;)
export function escapeHtmlText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\u00a0', '&nbsp;');
}

const lines = (text: string) => text.split(/\r\n?|\n/);

/**
 * Rich text in the sanitizer's normalised form (bold through <strong>, since
 * font-weight is not an allowed style). One paragraph per line, never h1-h3.
 */
export function presetHtml(blocks: TextBlock | TextBlock[]): string {
  return (Array.isArray(blocks) ? blocks : [blocks])
    .flatMap((block) => {
      const preset = TEXT_PRESETS[block.preset];
      const pStyle = block.align ? ` style="text-align: ${block.align}"` : '';
      const spanStyle = [
        preset.color ? `color: ${preset.color}` : '',
        preset.fontSize ? `font-size: ${preset.fontSize}px` : '',
        `line-height: ${preset.lineHeight}`,
      ]
        .filter(Boolean)
        .join('; ');

      return lines(block.text).map((line) => {
        if (!line) {
          return `<p${pStyle}></p>`;
        }

        const text = preset.bold
          ? `<strong>${escapeHtmlText(line)}</strong>`
          : escapeHtmlText(line);

        return `<p${pStyle}><span style="${spanStyle}">${text}</span></p>`;
      });
    })
    .join('');
}

// unstyled paragraphs, e.g. for notes, which size their own text
export function plainHtml(text: string): string {
  return lines(text)
    .map((line) => `<p>${escapeHtmlText(line)}</p>`)
    .join('');
}
