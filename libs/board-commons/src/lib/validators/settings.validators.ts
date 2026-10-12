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
});

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
