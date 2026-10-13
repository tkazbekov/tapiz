import { z } from 'zod';
import type { NodeValidator, TuNode } from '../models/node.model.js';
import { isNoteMaskedFor } from '../note-visibility.js';

const comment = z.object({
  text: z.string(),
  userId: z.string(),
  date: z.number(),
});

const commentPatch = comment.pick({ text: true }).partial();

// the comments of a hidden note are as secret as its text
const onHiddenNote = (state: {
  nodes: TuNode[];
  userId: string;
  parentNode?: TuNode;
}) =>
  !!state.parentNode &&
  isNoteMaskedFor(state.parentNode, state.nodes, state.userId);

const COMMENT_VALIDATOR: NodeValidator = {
  add: async (data, state) => {
    if (state.parentNode?.type !== 'note') {
      return {
        success: false,
        reason: {
          code: 'parent_invalid',
          message: 'a comment needs a parent note',
        },
      };
    }

    if (onHiddenNote(state)) {
      return {
        success: false,
        reason: {
          code: 'masked_note',
          message: "another user's note is hidden: it cannot be commented on",
        },
      };
    }

    const validation = comment.safeParse(data.content);

    if (validation.success) {
      return {
        success: true,
        data: {
          ...data,
          content: {
            ...validation.data,
            userId: state.userId,
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
  // only the author edits a comment, and only its text
  patch: async (data, state) => {
    if (onHiddenNote(state)) {
      return {
        success: false,
        reason: {
          code: 'masked_note',
          message: "another user's note is hidden: its comments are locked",
        },
      };
    }

    if (
      !('userId' in state.node.content) ||
      state.node.content.userId !== state.userId
    ) {
      return {
        success: false,
      };
    }

    const validation = commentPatch.safeParse(data.content);

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
    if (onHiddenNote(state)) {
      return {
        success: false,
        reason: {
          code: 'masked_note',
          message: "another user's note is hidden: its comments are locked",
        },
      };
    }

    if (
      'userId' in state.node.content &&
      state.node.content.userId !== state.userId
    ) {
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

export const COMMENTS_VALIDATORS = [
  {
    type: 'comment',
    validator: COMMENT_VALIDATOR,
  },
] as const;
