import { z } from 'zod';
import {
  CommonBoardValidation,
  SizeValidator,
} from './common-board-validation.js';

const text = z.object({
  ...CommonBoardValidation,
  ...SizeValidator,
  text: z.string(),
  rotation: z.number(),
});

export const patchText = text.partial();

export const newText = text;
