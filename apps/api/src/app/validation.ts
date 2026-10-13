import {
  normalizeVoteActions,
  StateActions,
  TuNode,
} from '@tapiz/board-commons';
import { Validators } from '@tapiz/board-commons/validators/index.js';

import { PERSONAL_TOKEN_VALIDATOR } from '@tapiz/board-commons/validators/token.validator.js';
import { ESTIMATION_VALIDATORS } from '@tapiz/board-commons/validators/estimation.validator.js';
import { POLL_VALIDATORS } from '@tapiz/board-commons/validators/poll.validator.js';
import { COMMENTS_VALIDATORS } from '@tapiz/board-commons/validators/comments.validator.js';
import { SETTINGS_VALIDATOR } from '@tapiz/board-commons/validators/settings.validators.js';
import { TIMER_VALIDATORS } from '@tapiz/board-commons/validators/timer.validators.js';

import { NOTE_VALIDATORS } from '@tapiz/board-commons/validators/note.validator.js';
import { GROUP_VALIDATORS } from '@tapiz/board-commons/validators/group.validator.js';
import { syncNodeBox } from '@tapiz/sync-node-box';
import { sanitizeStateActions } from './rich-text.js';

const validations = {
  custom: {
    user: Validators.userValidator,
  },
  new: {
    panel: Validators.newPanel,
    image: Validators.newImage,
    vector: Validators.newVector,
    text: Validators.newText,
    arrow: Validators.newArrow,
  },
  patch: {
    panel: Validators.patchPanel,
    image: Validators.patchImage,
    vector: Validators.patchVector,
    text: Validators.patchText,
    arrow: Validators.patchArrow,
  },
  newValidators: [
    {
      type: 'token',
      validator: PERSONAL_TOKEN_VALIDATOR,
    },
    {
      type: 'settings',
      validator: SETTINGS_VALIDATOR,
    },
    ...ESTIMATION_VALIDATORS,
    ...POLL_VALIDATORS,
    ...COMMENTS_VALIDATORS,
    ...NOTE_VALIDATORS,
    ...GROUP_VALIDATORS,
    ...TIMER_VALIDATORS,
  ],
};

export type RejectionCode =
  | 'invalid_shape'
  | 'layer_admin_only'
  | 'node_not_found'
  | 'type_mismatch'
  | 'schema'
  | 'notes_hidden_owner'
  | 'masked_note'
  | 'parent_invalid'
  | 'forbidden'
  | 'unsupported_type'
  | 'duplicate_id'
  | 'depends_on_rejected'
  | 'read_only'
  | 'board_unavailable'
  | 'batch_aborted';

export interface RejectionIssue {
  path: (string | number)[];
  message: string;
  code: string;
}

export interface ActionRejection {
  // index in the submitted batch
  index: number;
  op?: string;
  id?: string;
  type?: string;
  code: RejectionCode;
  message: string;
  hint?: string;
  issues?: RejectionIssue[];
  // index of the rejected action this one relied on
  dependsOn?: number;
}

export type ActionResult =
  | { ok: true; action: StateActions }
  | {
      ok: false;
      code: RejectionCode;
      message: string;
      issues?: RejectionIssue[];
    };

const reject = (
  code: RejectionCode,
  message: string,
  issues?: RejectionIssue[],
): ActionResult => ({
  ok: false,
  code,
  message,
  ...(issues ? { issues } : {}),
});

const zodIssues = (
  issues: { path: PropertyKey[]; message: string; code: string }[],
): RejectionIssue[] =>
  issues.map((err) => ({
    path: err.path.filter((p): p is string | number => typeof p !== 'symbol'),
    message: err.message,
    code: err.code,
  }));

export const validateActionDetailed = async (
  msg: StateActions,
  nodes: TuNode[],
  userId: string,
  isAdmin: boolean,
  boardId: string,
  userPrivateId: string,
): Promise<ActionResult> => {
  const customValidators = msg.data.type in validations.custom;

  const validatorConfig = validations.newValidators.find(
    (it) => it.type === msg.data.type,
  );

  const findNode = (id: string, parentId?: string) => {
    if (parentId) {
      const parent = nodes.find((it) => it.id === parentId);

      if (!parent || !parent.children) {
        return;
      }

      return parent.children.find((it) => it.id === id);
    } else {
      return nodes.find((it) => it.id === id);
    }
  };

  // validators and the rich-text sanitizer pick their rules from the claimed
  // type, so a patch or remove must name the type of the node it targets
  const matchesType = (node: TuNode | undefined): node is TuNode =>
    !!node && node.type === msg.data.type;

  const missingTarget = (node: TuNode | undefined) =>
    node
      ? reject(
          'type_mismatch',
          `node ${msg.data.id} is a ${node.type}, not a ${msg.data.type}`,
        )
      : reject('node_not_found', `node ${msg.data.id} does not exist`);

  // layer 1 is the board edit mode, which only board admins can change
  const layerOf = (content: unknown) =>
    (content as { layer?: unknown } | undefined)?.layer;
  const target =
    msg.op === 'add' ? undefined : findNode(msg.data.id, msg.parent);
  const incoming = msg.op === 'remove' ? undefined : msg.data.content;

  if (
    !isAdmin &&
    (layerOf(incoming) === 1 || (target && layerOf(target.content) === 1))
  ) {
    return reject(
      'layer_admin_only',
      'only board admins can add, change or remove layer-1 nodes',
    );
  }

  let parentNode: TuNode | undefined;

  if (msg.parent) {
    parentNode = nodes.find((it) => it.id === msg.parent);
  }

  if (validatorConfig) {
    let failure: Extract<
      Awaited<ReturnType<typeof validatorConfig.validator.remove>>,
      { success: false }
    > | null = null;

    if (msg.op === 'add') {
      const result = await validatorConfig.validator.add(msg.data, {
        userId,
        nodes: nodes,
        isAdmin,
        boardId,
        userPrivateId,
        parentNode,
      });

      if (result.success) {
        return {
          ok: true,
          action: {
            op: 'add',
            data: result.data,
            parent: msg.parent,
            position: msg.position,
          },
        };
      }

      if (result.error) {
        console.error('[Node Validation Failed]', {
          nodeType: msg.data.type,
          operation: 'add',
          nodeId: msg.data.id,
          userId,
          errors: result.error.issues,
        });
      }

      failure = result;
    } else if (msg.op === 'patch') {
      const node = findNode(msg.data.id, msg.parent);

      if (!matchesType(node)) {
        return missingTarget(node);
      }

      const result = await validatorConfig.validator.patch(msg.data, {
        userId,
        nodes,
        node,
        isAdmin,
        boardId,
        userPrivateId,
        parentNode,
      });

      if (result.success) {
        return {
          ok: true,
          action: {
            op: 'patch',
            data: result.data,
            parent: msg.parent,
            position: msg.position,
          },
        };
      }

      if (result.error) {
        console.error('[Node Validation Failed]', {
          nodeType: msg.data.type,
          operation: 'patch',
          nodeId: msg.data.id,
          userId,
          errors: result.error.issues,
        });
      }

      failure = result;
    } else if (msg.op === 'remove') {
      const node = findNode(msg.data.id, msg.parent);

      if (!matchesType(node)) {
        return missingTarget(node);
      }

      const result = await validatorConfig.validator.remove(msg.data, {
        userId,
        nodes,
        node,
        isAdmin,
        boardId,
        userPrivateId,
        parentNode,
      });

      if (result.success) {
        return {
          ok: true,
          action: {
            op: 'remove',
            data: result.data,
            parent: msg.parent,
          },
        };
      }

      failure = result;
    }

    if (failure?.error) {
      return reject(
        'schema',
        `invalid ${msg.data.type} content`,
        failure.error.issues,
      );
    }

    if (failure?.reason) {
      return reject(failure.reason.code, failure.reason.message);
    }

    return reject(
      'forbidden',
      `this ${msg.op} of a ${msg.data.type} is not allowed for this user`,
    );
  }

  if (customValidators) {
    const action = validations.custom[
      msg.data.type as keyof typeof validations.custom
    ](msg, nodes, userId);

    return action
      ? { ok: true, action }
      : reject(
          'forbidden',
          `this ${msg.op} of a ${msg.data.type} is not allowed for this user`,
        );
  } else {
    if (msg.op === 'patch' || msg.op === 'remove') {
      const validator =
        validations['patch'][msg.data.type as keyof typeof validations.patch];

      // check if the element present in the state
      const node = nodes.find((it) => it.id === msg.data.id);

      if (!matchesType(node)) {
        return missingTarget(node);
      }

      if (msg.op === 'remove') {
        return {
          ok: true,
          action: {
            op: msg.op,
            data: {
              id: msg.data.id,
              type: msg.data.type,
            },
          },
        };
      } else if (msg.op === 'patch') {
        if (validator) {
          const validatorResult = validator.safeParse(msg.data.content);

          if (!validatorResult.success) {
            console.error('[Node Validation Failed]', {
              nodeType: msg.data.type,
              operation: 'patch',
              nodeId: msg.data.id,
              userId,
              errors: validatorResult.error.issues.map((err) => ({
                path: err.path.join('.'),
                message: err.message,
                code: err.code,
              })),
            });
            return reject(
              'schema',
              `invalid ${msg.data.type} content`,
              zodIssues(validatorResult.error.issues),
            );
          }

          return {
            ok: true,
            action: {
              op: msg.op,
              data: {
                id: msg.data.id,
                type: msg.data.type,
                content: validatorResult.data,
              },
              parent: msg.parent,
              position: msg.position,
            },
          };
        }
      }
    } else if (msg.op === 'add') {
      const validator =
        validations['new'][msg.data.type as keyof typeof validations.new];

      if (validator) {
        const validatorResult = validator.safeParse(msg.data.content);

        if (!validatorResult.success) {
          console.error('[Node Validation Failed]', {
            nodeType: msg.data.type,
            operation: 'add',
            nodeId: msg.data.id,
            userId,
            errors: validatorResult.error.issues.map((err) => ({
              path: err.path.join('.'),
              message: err.message,
              code: err.code,
            })),
          });
          return reject(
            'schema',
            `invalid ${msg.data.type} content`,
            zodIssues(validatorResult.error.issues),
          );
        }

        return {
          ok: true,
          action: {
            op: msg.op,
            data: {
              id: msg.data.id,
              type: msg.data.type,
              content: validatorResult.data,
            },
            parent: msg.parent,
            position: msg.position,
          },
        };
      }
    }
  }

  return reject(
    'unsupported_type',
    `${msg.op} is not supported for node type ${msg.data.type}`,
  );
};

export const validateAction = async (
  ...args: Parameters<typeof validateActionDetailed>
): Promise<StateActions | false> => {
  const result = await validateActionDetailed(...args);

  return result.ok ? result.action : false;
};

export const validation = async (
  msg: StateActions[],
  state: TuNode[],
  userId: string,
  isAdmin: boolean,
  boardId: string,
  privateId: string,
) => {
  if (Array.isArray(msg)) {
    msg = msg.filter((it) => {
      const result = Validators.stateAction.safeParse(it);
      if (!result.success) {
        console.error('[Node Validation Failed]', {
          nodeType: it?.data?.type || 'unknown',
          operation: it?.op || 'unknown',
          nodeId: it?.data?.id,
          userId,
          errors: result.error.issues.map((err) => ({
            path: err.path.join('.'),
            message: err.message,
            code: err.code,
          })),
        });
      }
      return result.success;
    });

    const actions = await Promise.all(
      msg.map((it) => {
        return validateAction(it, state, userId, isAdmin, boardId, privateId);
      }),
    );

    if (actions.every((it): it is StateActions => !!it)) {
      // rich text is rendered as HTML by every client, so it is stored clean
      return sanitizeStateActions(normalizeVoteActions(actions, state, userId));
    }
  }

  return [];
};

const HINTS: Partial<Record<RejectionCode, string>> = {
  invalid_shape:
    'each action needs op (add|patch|remove) and data { id, type, content? }',
  layer_admin_only:
    'the API token user is not a board admin: use content.layer 0 for every node it adds, changes or removes',
  node_not_found:
    'call get_board for current ids; nodes added earlier in the same batch are visible to later actions',
  type_mismatch:
    'data.type must be the type of the stored node; call get_board to check it',
  schema:
    'fix the content fields listed in issues; an add needs every required field of its type',
  parent_invalid:
    'set parent to the id of an existing note, or of a note added earlier in the same batch',
  masked_note:
    'notes of other users are hidden: only move or resize them until a board admin reveals notes',
  forbidden: 'this user is not allowed to make this change',
  unsupported_type:
    'use a supported node type and op; call get_board to see the types in use',
  duplicate_id: 'ids must be new; omit or replace the id',
  depends_on_rejected:
    'this action targets a node whose add was rejected; fix the action named in dependsOn',
  read_only:
    'the board is read-only for users who are not board admins; ask a board admin to turn read-only off',
  board_unavailable: 'the board could not be loaded; call get_board and retry',
  batch_aborted:
    'nothing was applied; fix the rejected actions and resend the whole batch',
};

export const rejectionHint = (code: RejectionCode, userId: string) =>
  code === 'notes_hidden_owner'
    ? `ownerId must be ${userId} while notes are hidden`
    : HINTS[code];

export const toRejection = (
  index: number,
  action: Partial<StateActions> | undefined,
  rejection: {
    code: RejectionCode;
    message: string;
    issues?: RejectionIssue[];
    dependsOn?: number;
  },
  userId: string,
): ActionRejection => {
  const hint = rejectionHint(rejection.code, userId);
  const data = action?.data as Partial<TuNode> | undefined;

  return {
    index,
    ...(action?.op ? { op: action.op } : {}),
    ...(data?.id !== undefined ? { id: data.id } : {}),
    ...(data?.type !== undefined ? { type: data.type } : {}),
    code: rejection.code,
    message: rejection.message,
    ...(hint ? { hint } : {}),
    ...(rejection.issues ? { issues: rejection.issues } : {}),
    ...(rejection.dependsOn !== undefined
      ? { dependsOn: rejection.dependsOn }
      : {}),
  };
};

export interface BatchValidationOptions {
  // validate each action against the board as the earlier actions left it,
  // so a batch can patch, remove or comment on nodes it added
  sequential?: boolean;
  // an add whose id already exists is rejected instead of ignored
  rejectDuplicateIds?: boolean;
}

export interface BatchValidationResult {
  actions: StateActions[];
  // the batch index of each entry of actions
  indices: number[];
  rejected: ActionRejection[];
}

/*
 * Like validation(), but reports why actions were rejected. Used by MCP only;
 * the websocket path keeps calling validation().
 */
export const validateBatch = async (
  msg: StateActions[],
  state: TuNode[],
  userId: string,
  isAdmin: boolean,
  boardId: string,
  privateId: string,
  opts: BatchValidationOptions = {},
): Promise<BatchValidationResult> => {
  const empty: BatchValidationResult = {
    actions: [],
    indices: [],
    rejected: [],
  };

  if (!Array.isArray(msg)) {
    return empty;
  }

  const rejected: ActionRejection[] = [];
  const shaped: { index: number; action: StateActions }[] = [];

  msg.forEach((it, index) => {
    const result = Validators.stateAction.safeParse(it);

    if (!result.success) {
      console.error('[Node Validation Failed]', {
        nodeType: it?.data?.type || 'unknown',
        operation: it?.op || 'unknown',
        nodeId: it?.data?.id,
        userId,
        errors: result.error.issues.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
          code: err.code,
        })),
      });

      rejected.push(
        toRejection(
          index,
          it,
          {
            code: 'invalid_shape',
            message: 'the action does not match the StateAction shape',
            issues: zodIssues(result.error.issues),
          },
          userId,
        ),
      );

      return;
    }

    shaped.push({ index, action: it });
  });

  // like validation(), a malformed action is dropped without failing the
  // rest; sequential batches are all-or-nothing
  const shapeRejections = opts.sequential ? 0 : rejected.length;
  const passed: { index: number; action: StateActions }[] = [];

  if (opts.sequential) {
    const box = syncNodeBox({ history: 0, log: false });
    // index of the rejected action that added each id
    const rejectedAdds = new Map<string, number>();

    box.update(() => state);

    for (const { index, action } of shaped) {
      const fail = (rejection: Parameters<typeof toRejection>[2]) => {
        rejected.push(toRejection(index, action, rejection, userId));

        // a duplicate add leaves the existing node, which later actions
        // may still target
        if (
          action.op === 'add' &&
          rejection.code !== 'duplicate_id' &&
          !rejectedAdds.has(action.data.id)
        ) {
          rejectedAdds.set(action.data.id, index);
        }
      };

      const scope = action.parent
        ? (box.getNode(action.parent)?.children ?? [])
        : box.get();

      if (
        opts.rejectDuplicateIds &&
        action.op === 'add' &&
        scope.some((it) => it.id === action.data.id)
      ) {
        fail({
          code: 'duplicate_id',
          message: `a node with id ${action.data.id} already exists`,
        });
        continue;
      }

      // the action depends on its own id, unless it adds it, and on its parent
      const dependsOnId = [
        action.op !== 'add' ? action.data.id : undefined,
        action.parent,
      ].find((id) => id !== undefined && rejectedAdds.has(id));

      if (dependsOnId !== undefined) {
        const dependsOn = rejectedAdds.get(dependsOnId);

        fail({
          code: 'depends_on_rejected',
          message: `action ${dependsOn} that adds ${dependsOnId} was rejected`,
          dependsOn,
        });
        continue;
      }

      // the working copy, like the server, drops a child of a missing parent
      // without an error, so it would be reported as applied
      if (action.op === 'add' && action.parent && !box.getNode(action.parent)) {
        fail({
          code: 'parent_invalid',
          message: `parent ${action.parent} does not exist`,
        });
        continue;
      }

      const result = await validateActionDetailed(
        action,
        box.get(),
        userId,
        isAdmin,
        boardId,
        privateId,
      );

      if (!result.ok) {
        fail(result);
        continue;
      }

      box.actions([result.action]);
      passed.push({ index, action: result.action });

      // a later valid add of the same id replaces the rejected one
      if (result.action.op === 'add') {
        rejectedAdds.delete(result.action.data.id);
      }
    }
  } else {
    const results = await Promise.all(
      shaped.map(({ action }) =>
        validateActionDetailed(
          action,
          state,
          userId,
          isAdmin,
          boardId,
          privateId,
        ),
      ),
    );

    results.forEach((result, i) => {
      const { index, action } = shaped[i];

      if (result.ok) {
        passed.push({ index, action: result.action });
      } else {
        rejected.push(toRejection(index, action, result, userId));
      }
    });
  }

  if (rejected.length > shapeRejections) {
    for (const { index, action } of passed) {
      rejected.push(
        toRejection(
          index,
          action,
          {
            code: 'batch_aborted',
            message: 'not applied because another action of the batch failed',
          },
          userId,
        ),
      );
    }

    rejected.sort((a, b) => a.index - b.index);

    return { ...empty, rejected };
  }

  const actions = passed.map((it) => it.action);

  return {
    // rich text is rendered as HTML by every client, so it is stored clean
    actions: sanitizeStateActions(normalizeVoteActions(actions, state, userId)),
    indices: passed.map((it) => it.index),
    rejected,
  };
};
