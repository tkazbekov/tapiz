import { z } from 'zod';
import { NodeValidator } from '../models/node.model.js';
import { colorValidator } from './color.validator.js';

// No defaults here: zod 4 fills defaults of .partial() fields, which would
// reset unrelated settings on every patch.
const settingsBase = z.object({
  readOnly: z.boolean(),
  anonymousMode: z.boolean(),
  hideNoteAuthor: z.boolean(),
  allowPublicPosts: z.boolean(),
  // other users' notes show as blank cards until an admin reveals them
  notesHidden: z.boolean(),
  // votes each user can spend on the board; null or 0 is unlimited
  votesPerUser: z.number().int().min(0).max(999).nullable().optional(),
  backgroundColor: z.string().refine(colorValidator).optional(),
  dotsColor: z.string().refine(colorValidator).optional(),
  boardStartingView: z
    .object({
      x: z.number(),
      y: z.number(),
      zoom: z.number(),
    })
    .optional(),
});

export const settingsValidator = settingsBase.extend({
  readOnly: z.boolean().default(false),
  anonymousMode: z.boolean().default(false),
  hideNoteAuthor: z.boolean().default(false),
  allowPublicPosts: z.boolean().default(false),
  notesHidden: z.boolean().default(false),
});

// anonymous notes have no owner, so nobody could see or edit them while hidden
const hidesAnonymousNotes = (settings: {
  anonymousMode?: boolean;
  notesHidden?: boolean;
}) => !!settings.anonymousMode && !!settings.notesHidden;

export const SETTINGS_VALIDATOR: NodeValidator = {
  add: async (data, state) => {
    if (!state.isAdmin) {
      return {
        success: false,
      };
    }

    const setting = state.nodes.find((it) => it.type === 'settings');

    if (setting) {
      return {
        success: false,
      };
    }

    const validation = settingsValidator.safeParse(data.content);

    if (validation.success && hidesAnonymousNotes(validation.data)) {
      return {
        success: false,
      };
    }

    if (validation.success) {
      return {
        success: true,
        data: {
          ...data,
          content: validation.data,
        },
      };
    }

    return {
      success: false,
      error: {
        issues: validation.error.issues.map((err) => ({
          path: err.path.filter(
            (p): p is string | number => typeof p !== 'symbol',
          ),
          message: err.message,
          code: err.code,
        })),
      },
    };
  },
  patch: async (data, state) => {
    if (!state.isAdmin) {
      return {
        success: false,
      };
    }

    const validation = settingsBase.partial().safeParse(data.content);

    if (
      validation.success &&
      hidesAnonymousNotes({ ...state.node.content, ...validation.data })
    ) {
      return {
        success: false,
      };
    }

    if (validation.success) {
      return {
        success: true,
        data: {
          ...data,
          content: validation.data,
        },
      };
    }

    return {
      success: false,
      error: {
        issues: validation.error.issues.map((err) => ({
          path: err.path.filter(
            (p): p is string | number => typeof p !== 'symbol',
          ),
          message: err.message,
          code: err.code,
        })),
      },
    };
  },
  remove: async (data, state) => {
    if (!state.isAdmin) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      data,
    };
  },
};
