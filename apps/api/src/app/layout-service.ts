import { randomUUID } from 'node:crypto';
import {
  assignInsertPositions,
  type BoardTemplateData,
  instantiateTemplate,
  type InstantiateResult,
  isSettings,
  type LayerPolicy,
  lintNodes,
  type LintIssue,
  maskNodesForViewer,
  type Placement,
  type Point,
  type Rect,
  resolveOrigin,
  type TuNode,
} from '@tapiz/board-commons';
import db from './db/index.js';
import { type McpUser, runAsMcpBoardClient } from './mcp.js';
import type { Server } from './server.js';
import { rejectionHint, type ActionRejection } from './validation.js';

export interface InsertOptions {
  // board coordinates of the template's top-left; default: next to the
  // existing content, see placement
  origin?: Point;
  placement?: Placement;
  layer?: LayerPolicy;
  // compute everything but write nothing (and don't join the board)
  dryRun?: boolean;
}

export interface InsertedNodeSummary {
  ref: string;
  id: string;
  type: string;
  layer: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface InsertResult {
  status: 'applied' | 'dry_run' | 'rejected';
  origin: Point;
  bounds: Rect;
  nodeCount: number;
  layerCoerced: boolean;
  // template ref -> node id; provisional in a dry run, empty when rejected
  refs: Record<string, string>;
  lint: LintIssue[];
  rejected: ActionRejection[];
  // dry run only: where each node would go
  nodes?: InsertedNodeSummary[];
}

const LAYER_ADMIN_ONLY_HINT =
  'the API token user is not a board admin: pass layer "auto" to put every node on layer 0, or ask a board admin to insert it';

function rejection(
  code: 'read_only' | 'layer_admin_only',
  message: string,
  userId: string,
): ActionRejection {
  return {
    index: -1,
    code,
    message,
    hint:
      code === 'layer_admin_only'
        ? LAYER_ADMIN_ONLY_HINT
        : rejectionHint(code, userId),
  };
}

function summarize(ref: string, node: TuNode): InsertedNodeSummary {
  const content = node.content as {
    layer: number;
    position: Point;
    width?: number;
    height?: number;
  };

  return {
    ref,
    id: node.id,
    type: node.type,
    layer: content.layer,
    x: content.position.x,
    y: content.position.y,
    ...(content.width !== undefined ? { width: content.width } : {}),
    ...(content.height !== undefined ? { height: content.height } : {}),
  };
}

type Plan =
  | { ok: false; result: InsertResult }
  | { ok: true; result: InsertResult; instance: InstantiateResult };

// everything an insert decides before it writes; `existing` is the raw board
function planInsert(
  user: McpUser,
  existing: TuNode[],
  isAdmin: boolean,
  template: BoardTemplateData,
  options: InsertOptions,
): Plan {
  const visible = maskNodesForViewer(existing, user.id);
  const origin =
    options.origin ?? resolveOrigin(visible, options.placement ?? 'right');
  const base: InsertResult = {
    status: 'rejected',
    origin,
    bounds: { ...origin, ...template.size },
    nodeCount: template.nodes.length,
    layerCoerced: false,
    refs: {},
    lint: [],
    rejected: [],
  };
  const settings = existing.find(isSettings)?.content;

  if (!isAdmin && settings?.readOnly) {
    return {
      ok: false,
      result: {
        ...base,
        rejected: [
          rejection(
            'read_only',
            'the board is read-only for users who are not admins',
            user.id,
          ),
        ],
      },
    };
  }

  const instance = instantiateTemplate(template, {
    origin,
    newId: randomUUID,
    ownerId: user.id,
    isAdmin,
    layer: options.layer ?? 'auto',
  });

  if ('error' in instance) {
    return {
      ok: false,
      result: {
        ...base,
        rejected: [
          rejection(
            'layer_admin_only',
            'the template has layer-1 nodes and layer "asStored" keeps them there, which only board admins may do',
            user.id,
          ),
        ],
      },
    };
  }

  const added = instance.actions.map((action) => action.data);
  const lint = lintNodes([...visible, ...added], {
    scopeIds: added.map((node) => node.id),
    isAdmin,
    existingIds: visible.map((node) => node.id),
  });

  return {
    ok: true,
    instance,
    result: {
      ...base,
      bounds: instance.bounds,
      layerCoerced: instance.layerCoerced,
      refs: instance.refToId,
      lint,
    },
  };
}

/**
 * Inserts a parsed template as the MCP user, with fresh ids, at `origin` or
 * next to the existing content. Non-admins get layer 0 under layer "auto".
 * A dry run checks access without joining the board, so it writes nothing,
 * not even a membership row.
 */
export async function insertTemplateAsMcpUser(
  server: Server,
  user: McpUser,
  boardId: string,
  template: BoardTemplateData,
  options: InsertOptions = {},
): Promise<InsertResult> {
  if (options.dryRun) {
    if (!(await db.board.haveAccess(boardId, user.id))) {
      throw new Error('Unable to read board with this API token');
    }

    const isAdmin = (await db.board.getBoardAdmins(boardId)).includes(user.id);
    const existing = (await server.readBoard(boardId)) ?? [];
    const plan = planInsert(user, existing, isAdmin, template, options);

    if (!plan.ok) {
      return plan.result;
    }

    return {
      ...plan.result,
      status: 'dry_run',
      nodes: plan.instance.actions.map((action, index) =>
        summarize(template.nodes[index].ref, action.data),
      ),
    };
  }

  return runAsMcpBoardClient(server, user, boardId, async (client) => {
    const existing = server.getBoard(boardId) ?? [];
    const plan = planInsert(user, existing, client.isAdmin, template, options);

    if (!plan.ok) {
      return plan.result;
    }

    // panels and groups keep their template order behind existing content;
    // a concurrent websocket add can still shift them by one slot
    const { rejected } = await client.applyStateActions(
      assignInsertPositions(existing, plan.instance.actions),
      { sequential: true, rejectDuplicateIds: true },
    );

    if (rejected.length) {
      return { ...plan.result, status: 'rejected', refs: {}, rejected };
    }

    return { ...plan.result, status: 'applied' };
  });
}
