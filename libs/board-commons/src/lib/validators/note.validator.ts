import { z } from 'zod';

import type { NodeValidator } from '../models/node.model.js';
import { isNoteMaskedFor, isNotesHidden } from '../note-visibility.js';
import {
  CommonBoardValidation,
  SizeValidator,
} from './common-board-validation.js';
import { colorSchema, nullableOptionalColorSchema } from './color.validator.js';

const note = z.object({
  ...CommonBoardValidation,
  ...SizeValidator,
  text: z.string(),
  votes: z.array(
    z.object({
      userId: z.string().max(255),
      vote: z.number().int().min(0),
    }),
  ),
  emojis: z.array(
    z.object({
      unicode: z.string().max(255),
      position: z.object({
        x: z.number(),
        y: z.number(),
      }),
    }),
  ),
  drawing: z.array(
    z.object({
      color: colorSchema,
      size: z.number().positive().safe(),
      points: z.array(
        z.object({
          x: z.number(),
          y: z.number(),
        }),
      ),
    }),
  ),
  ownerId: z.string().max(255),
  width: z.number().positive(),
  height: z.number().positive(),
  color: nullableOptionalColorSchema,
  textHidden: z.boolean().nullable().optional(),
});

export const patchNote = note.partial();

export const newNote = note;

// while notes are hidden, others can only move or resize a note
const MOVE_KEYS = new Set(['position', 'width', 'height', 'layer']);

const NOTE_VALIDATOR: NodeValidator = {
  add: async (data, state) => {
    const validation = newNote.safeParse(data.content);

    // ownership decides who sees a hidden note, so nobody adds notes for others
    if (
      validation.success &&
      isNotesHidden(state.nodes) &&
      validation.data.ownerId !== state.userId
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
          content: {
            ...validation.data,
          },
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
    const validation = patchNote.safeParse(data.content);

    if (
      validation.success &&
      isNoteMaskedFor(state.node, state.nodes, state.userId) &&
      Object.entries(validation.data).some(
        ([key, value]) => value !== undefined && !MOVE_KEYS.has(key),
      )
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
          content: {
            ...validation.data,
          },
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
    if (isNoteMaskedFor(state.node, state.nodes, state.userId)) {
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

export const NOTE_VALIDATORS = [
  {
    type: 'note',
    validator: NOTE_VALIDATOR,
  },
] as const;
