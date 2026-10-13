import { z } from 'zod';

import type { NodeValidator } from '../models/node.model.js';
import {
  CommonBoardValidation,
  SizeValidator,
} from './common-board-validation.js';

const group = z.object({
  ...CommonBoardValidation,
  ...SizeValidator,
  title: z.string().max(1000),
  votes: z.array(
    z.object({
      userId: z.string().max(255),
      vote: z.number().int().min(0),
    }),
  ),
  unLocked: z.boolean().optional(),
});

export const patchGroup = group.partial();

export const newGroup = group.partial().required({
  position: true,
  width: true,
  height: true,
});

const validationError = (error: z.ZodError) => ({
  success: false as const,
  error: {
    issues: error.issues.map((err) => ({
      path: err.path.filter((p): p is string | number => typeof p !== 'symbol'),
      message: err.message,
      code: err.code,
    })),
  },
});

const GROUP_VALIDATOR: NodeValidator = {
  add: async (data) => {
    const validation = newGroup.safeParse(data.content);

    if (!validation.success) {
      return validationError(validation.error);
    }

    return {
      success: true,
      data: { id: data.id, type: data.type, content: validation.data },
    };
  },
  patch: async (data) => {
    const validation = patchGroup.safeParse(data.content);

    if (!validation.success) {
      return validationError(validation.error);
    }

    return {
      success: true,
      data: { id: data.id, type: data.type, content: validation.data },
    };
  },
  remove: async (data) => {
    return {
      success: true,
      data: { id: data.id, type: data.type },
    };
  },
};

export const GROUP_VALIDATORS = [
  {
    type: 'group',
    validator: GROUP_VALIDATOR,
  },
] as const;
