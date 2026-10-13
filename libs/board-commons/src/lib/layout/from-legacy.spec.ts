import { fromLegacyTemplate, type LegacyTemplateNode } from './from-legacy.js';
import { parseBoardTemplate } from './template-format.js';

// shaped like the web's stop-start-continue built-in
const lane = (x: number, title: string): LegacyTemplateNode => ({
  id: '',
  type: 'panel',
  content: {
    position: { x, y: 50 },
    layer: 1,
    text: `<h3>${title}</h3>`,
    width: 1250,
    height: 2600,
    rotation: 0,
    drawing: [],
  },
});

const lanes = [lane(0, 'Stop'), lane(1300, 'Start'), lane(2600, 'Continue')];

describe('fromLegacyTemplate', () => {
  it('normalises to the bounding box and keeps the array order', () => {
    const data = fromLegacyTemplate(lanes);

    expect(data.version).toBe(1);
    expect(data.size).toEqual({ width: 3850, height: 2600 });
    expect(data.nodes.map((node) => node.ref)).toEqual(['n0', 'n1', 'n2']);
    expect(data.nodes.map((node) => node.content.position)).toEqual([
      { x: 0, y: 0 },
      { x: 1300, y: 0 },
      { x: 2600, y: 0 },
    ]);
    expect(data.nodes.map((node) => node.content['text'])).toEqual([
      '<h3>Stop</h3>',
      '<h3>Start</h3>',
      '<h3>Continue</h3>',
    ]);
  });

  it('parses as template data', () => {
    expect(parseBoardTemplate(fromLegacyTemplate(lanes)).ok).toBe(true);
  });

  it('keeps the stored layer and defaults a missing one to 0', () => {
    const noLayer = lane(0, 'No layer');
    delete noLayer.content.layer;

    const data = fromLegacyTemplate([lanes[0], noLayer]);

    expect(data.nodes.map((node) => node.content.layer)).toEqual([1, 0]);
  });

  it('leaves the input untouched', () => {
    const input = [lane(10, 'A')];

    fromLegacyTemplate(input);

    expect(input[0].content.position).toEqual({ x: 10, y: 50 });
  });
});
