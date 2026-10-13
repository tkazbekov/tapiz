import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/*
 * resvg runs in a short-lived child process. A native panic (resvg aborts on
 * some off-canvas layers) or a slow render then fails one preview instead of
 * stopping or blocking the API.
 */

const RENDER_TIMEOUT_MS = 20_000;
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_RUNNING = 2;
const MAX_WAITING = 8;

// CommonJS, run with `node -e`; argv[1] is the resolved resvg module
const CHILD_SOURCE = `
const { Resvg } = require(process.argv[1]);
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const { svg, options } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(new Resvg(svg, options).render().asPng());
});
`;

let resvgPath: string | undefined;

const resolveResvg = () =>
  (resvgPath ??= createRequire(import.meta.url).resolve('@resvg/resvg-js'));

export class PreviewRenderError extends Error {
  // the renderer died (e.g. a resvg panic) rather than timing out
  constructor(
    message: string,
    readonly crashed = false,
  ) {
    super(message);
  }
}

export interface RenderPngOptions {
  font: {
    loadSystemFonts: boolean;
    defaultFontFamily?: string;
    sansSerifFamily?: string;
  };
}

function runChild(svg: string, options: RenderPngOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NODE_OPTIONS can carry loaders of the parent (vitest, tsx)
    const env = { ...process.env };

    delete env['NODE_OPTIONS'];

    const child = spawn(
      process.execPath,
      ['-e', CHILD_SOURCE, resolveResvg()],
      { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: string | null = null;

    const timer = setTimeout(() => {
      failure = 'The preview took too long to render; preview a smaller region';
      child.kill('SIGKILL');
    }, RENDER_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;

      if (bytes > MAX_PNG_BYTES) {
        failure = 'The preview image is too large';
        child.kill('SIGKILL');
      } else {
        chunks.push(chunk);
      }
    });

    // a fixed message: the spawn error names server paths
    child.on('error', () => {
      clearTimeout(timer);
      reject(new PreviewRenderError('The preview renderer failed to start'));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      if (failure) {
        reject(new PreviewRenderError(failure));
      } else if (code !== 0 || signal) {
        reject(
          new PreviewRenderError('The preview could not be rendered', true),
        );
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    // the child may die before reading everything
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ svg, options }));
  });
}

let running = 0;
const waiting: (() => void)[] = [];

async function acquire() {
  if (running < MAX_RUNNING) {
    running++;

    return;
  }

  if (waiting.length >= MAX_WAITING) {
    throw new PreviewRenderError(
      'Too many previews are rendering; try again in a few seconds',
    );
  }

  // release() hands its slot over, so running stays the same
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();

  if (next) {
    next();
  } else {
    running--;
  }
}

/** A PNG of the SVG at its own width and height, rendered out of process. */
export async function renderSvgToPng(
  svg: string,
  options: RenderPngOptions,
): Promise<Buffer> {
  await acquire();

  try {
    return await runChild(svg, options);
  } finally {
    release();
  }
}
