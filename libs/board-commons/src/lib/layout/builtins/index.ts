import { fromLegacyTemplate, type LegacyTemplateNode } from '../from-legacy.js';
import type { BoardTemplateData } from '../template-format.js';

export interface BuiltinTemplate {
  id: `builtin:${string}`;
  slug: string;
  name: string;
  description: string;
  load(): Promise<BoardTemplateData>;
}

const builtin = (
  slug: string,
  name: string,
  description: string,
  // dynamic import so the web keeps each template in its own chunk
  data: () => Promise<{ nodes: LegacyTemplateNode[] }>,
): BuiltinTemplate => ({
  id: `builtin:${slug}`,
  slug,
  name,
  description,
  load: async () => fromLegacyTemplate((await data()).nodes),
});

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  builtin(
    'movie-retrospective',
    'Movie Retrospective',
    'Movie-themed sprint retro on one illustrated cinema backdrop (red curtains, a marquee title "The Sprint Premiere", film strips): a 3x2 grid of six ticket-shaped frameless panels, 01 Opening Scene (the sprint as a movie title), 02 Blockbusters (wins worth a standing ovation), 03 Plot Twists (surprises, blockers, cliffhangers), 04 Blooper Reel (what went off-script, no blame), 05 Cast & Crew (shout-outs) and 06 The Sequel (1-2 experiments with owner and date); each ticket has a prompt and two starter notes, and a footer holds the run of show (timings), the ground rules and a director\'s note',
    () => import('./movie-retrospective.js'),
  ),
  builtin(
    'stop-start-continue',
    'Stop, Start, Continue',
    'Stop / start / continue retro: three tall side-by-side column panels (Stop, Start, Continue), then an arrow pointing to a fourth "Actions" column for next steps; notes go inside the columns',
    () => import('./stop-start-continue.js'),
  ),
  builtin(
    'sailboat',
    'Sailboat',
    'Sailboat retro: a large backdrop panel with a sailboat on the sea, wind clouds, rocks, an anchor and an island illustration, labelled Island (goals), Rocks (risks), Anchor (what holds us back) and Wind (what propels us); notes are placed freely over the art',
    () => import('./sailboat.js'),
  ),
  builtin(
    'mad-sad-glad',
    'Mad, Sad, Glad',
    'Mad / sad / glad retro: three tall side-by-side column panels (Mad: frustrations, Sad: disappointments, Glad: successes); notes go inside the columns',
    () => import('./mad-sad-glad.js'),
  ),
  builtin(
    'starfish',
    'Starfish',
    'Starfish retro: a large starfish illustration with five labelled arms (keep doing, start doing, stop doing, more of, less of) and arrows; notes are placed freely around it',
    () => import('./starfish.js'),
  ),
];

export function findBuiltinTemplate(id: string): BuiltinTemplate | undefined {
  return BUILTIN_TEMPLATES.find((template) => template.id === id);
}
