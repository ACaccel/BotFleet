/**
 * The column composer and the column-aware blocks: columns sit side by
 * side at their widths; the canvas is as tall as the tallest column, and
 * with `maxAspect` never wider than that ratio; a growing column is rebuilt with the
 * spare height, and other columns spread it over their section gaps only
 * while the gaps stay close; a legend too wide for its title line wraps;
 * the heatmap moves its peak caption to its own line when the legend and
 * the caption do not fit side by side; and trend x labels thin out in a
 * narrow column instead of overlapping.
 */
import { describe, expect, it } from 'vitest';

import {
  COLUMN_SPACING,
  EMBED_IMAGE_ASPECT,
  SECTION_GAP,
  canvasWidth,
  renderColumns,
  type ColumnSpec,
} from '../../../../src/handlers/commands/traffic-shared/dashboard/columns';
import {
  PEAK_LINE_HEIGHT,
  heatmapBlocks,
} from '../../../../src/handlers/commands/traffic-shared/dashboard/heatmap';
import {
  TITLE_HEIGHT,
  measureContext,
  sectionTitle,
  type Block,
  type Column,
} from '../../../../src/handlers/commands/traffic-shared/dashboard/layout';
import {
  COLOR,
  PAD,
  SCALE,
} from '../../../../src/handlers/commands/traffic-shared/dashboard/theme';
import { trendBlocks } from '../../../../src/handlers/commands/traffic-shared/dashboard/trend';
import * as fixtures from './dashboard-fixtures';

const BOTTOM_PAD = 14; // columns.ts

interface Drawn {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

const recorder = () => {
  const drawn: Drawn[] = [];
  const block = (id: string, col: Column, height: number): Block => ({
    height,
    draw: (_ctx, y) => drawn.push({ id, x: col.x, y }),
  });
  const yOf = (id: string): number | undefined => drawn.find((d) => d.id === id)?.y;
  return { drawn, block, yOf };
};

const sizeOf = (png: Buffer): { width: number; height: number } => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
});

/** Logical canvas height for a content height. */
const canvasHeight = (content: number): number => PAD + content + BOTTOM_PAD;

describe('renderColumns', () => {
  it('places columns side by side as tall as their content', () => {
    const { block, drawn } = recorder();
    const png = renderColumns([
      { width: 100, sections: (col) => [block('a', col, 40)] },
      { width: 200, sections: (col) => [block('b', col, 40)] },
    ]);
    const width = canvasWidth([100, 200]);
    expect(width).toBe(2 * PAD + 300 + COLUMN_SPACING);
    expect(sizeOf(png)).toEqual({ width: width * SCALE, height: canvasHeight(40) * SCALE });
    expect(drawn.map((d) => d.x)).toEqual([PAD, PAD + 100 + COLUMN_SPACING]);
    expect(drawn.map((d) => d.y)).toEqual([PAD, PAD]);
  });

  it('grows the canvas taller rather than wider than maxAspect', () => {
    const { block } = recorder();
    const specs: ColumnSpec[] = [{ width: 300, sections: (col) => [block('a', col, 40)] }];
    const width = canvasWidth([300]);
    const png = renderColumns(specs, { maxAspect: EMBED_IMAGE_ASPECT });
    expect(EMBED_IMAGE_ASPECT).toBeCloseTo(4 / 3);
    expect(sizeOf(png).height).toBe(Math.ceil(width / EMBED_IMAGE_ASPECT) * SCALE);
    // Content taller than the floor sets the height itself.
    const tall = renderColumns([{ width: 300, sections: (col) => [block('t', col, 900)] }], {
      maxAspect: EMBED_IMAGE_ASPECT,
    });
    expect(sizeOf(tall).height).toBe(canvasHeight(900) * SCALE);
  });

  it('grows the canvas to the tallest column', () => {
    const { block } = recorder();
    const png = renderColumns([
      { width: 100, sections: (col) => [block('tall', col, 600)] },
      { width: 100, sections: (col) => [block('short', col, 40)] },
    ]);
    expect(sizeOf(png).height).toBe(canvasHeight(600) * SCALE);
  });

  it('rebuilds a growing column with the spare height', () => {
    const { block, yOf } = recorder();
    const extras: number[] = [];
    const growing: ColumnSpec = {
      width: 100,
      grows: true,
      sections: (col, _measure, extra) => {
        extras.push(extra);
        return [block('top', col, 50), block('chart', col, 100 + extra)];
      },
    };
    renderColumns([growing, { width: 100, sections: (col) => [block('tall', col, 500)] }]);
    expect(extras).toEqual([0, 500 - (50 + SECTION_GAP + 100)]);
    expect(yOf('chart')).toBe(PAD + 50 + SECTION_GAP);
  });

  it('spreads close spare height over section gaps and leaves a large one below', () => {
    const { block, yOf } = recorder();
    renderColumns([
      { width: 100, sections: (col) => [block('tall', col, 500)] },
      // 400 + 22 + 40 = 462: 38 spare, spread into the one gap.
      { width: 100, sections: (col) => [block('b1', col, 400), block('b2', col, 40)] },
      // 50 + 22 + 50 = 122: too much spare to spread, so the gap stays standard.
      { width: 100, sections: (col) => [block('c1', col, 50), block('c2', col, 50)] },
    ]);
    expect(yOf('b2')).toBe(PAD + 500 - 40);
    expect(yOf('c2')).toBe(PAD + 50 + SECTION_GAP);
  });

  it('skips absent sections and draws a divider between columns', async () => {
    const { block, drawn } = recorder();
    const png = renderColumns([
      { width: 100, sections: (col) => [undefined, block('a', col, 40), undefined] },
      { width: 100, sections: (col) => [[block('b1', col, 10), block('b2', col, 10)]] },
    ]);
    expect(drawn.map((d) => [d.id, d.y])).toEqual([
      ['a', PAD],
      ['b1', PAD],
      ['b2', PAD + 10],
    ]);
    const { loadImage, createCanvas } = await import('canvas');
    const image = await loadImage(png);
    const ctx = createCanvas(image.width, image.height).getContext('2d');
    ctx.drawImage(image, 0, 0);
    const dividerX = Math.floor((PAD + 100 + COLUMN_SPACING / 2) * SCALE) - 1;
    const [r, g, b] = ctx.getImageData(dividerX, (PAD + 20) * SCALE, 1, 1).data;
    const grid = Number.parseInt(COLOR.grid.slice(1), 16);
    expect([r, g, b]).toEqual([(grid >> 16) & 255, (grid >> 8) & 255, grid & 255]);
  });
});

describe('column-aware blocks', () => {
  const legend = [
    { name: 'current', color: COLOR.current, kind: 'line' as const },
    { name: 'previous 08/11 – 09/09', color: COLOR.previous, kind: 'line' as const },
  ];

  it('wraps a legend that does not fit beside its title onto a line of its own', () => {
    const measure = measureContext();
    const wide = sectionTitle(measure, { x: PAD, w: 600 }, 'Daily messages', { legend });
    const narrow = sectionTitle(measure, { x: PAD, w: 200 }, 'Daily messages', { legend });
    expect(wide.height).toBe(TITLE_HEIGHT);
    expect(narrow.height).toBeGreaterThan(TITLE_HEIGHT);
  });

  it('puts the heatmap peak caption on its own line only in a narrow column', () => {
    const measure = measureContext();
    const gridHeight = (w: number): number =>
      heatmapBlocks(measure, fixtures.heatmap(), { x: PAD, w })[1]?.height ?? 0;
    expect(gridHeight(268) - gridHeight(560)).toBe(PEAK_LINE_HEIGHT);
    // Without a peak there is no caption, so no extra line either.
    const empty = heatmapBlocks(measure, fixtures.heatmap(fixtures.fakeGrid(0)), {
      x: PAD,
      w: 268,
    });
    expect(empty[1]?.height).toBe(gridHeight(560));
  });

  it('thins trend x labels that would overlap in a narrow column', () => {
    const labels = [
      '10/06 二',
      '10/07 三',
      '10/08 四',
      '10/09 五',
      '10/10 六',
      '10/11 日',
      '10/12 一',
    ];
    const render = (xLabels: string[], width: number): Buffer =>
      renderColumns([
        {
          width,
          sections: (col, measure) => [
            trendBlocks(measure, { ...fixtures.trend(7), xLabels }, col),
          ],
        },
      ]);
    // A 256 px column fits every other label (the last one included).
    const hidden = labels.map((label, i) => (i % 2 === 0 ? label : 'xx/xx'));
    expect(render(hidden, 256).equals(render(labels, 256))).toBe(true);
    expect(render(hidden, 640).equals(render(labels, 640))).toBe(false);
  });
});
