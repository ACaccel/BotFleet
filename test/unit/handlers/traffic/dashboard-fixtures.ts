/**
 * Fake view models for the /traffic dashboard renderer tests, shaped
 * after the approved style-B mockups. Every export is a factory that
 * returns fresh objects. Labels are Traditional Chinese like the
 * production translator output, so the fixtures also exercise the CJK
 * font path.
 */
import { createCanvas, Image } from 'canvas';

import type {
  AppSingleDashboard,
  AppsDashboard,
  ChannelDashboard,
  EmojiDashboard,
  HeatmapSection,
  HeroMetric,
  HeroTile,
  OverviewDashboard,
  PersonDashboard,
  RankingColumn,
  RankRow,
  StickerDashboard,
  TrendSection,
} from '../../../../src/handlers/commands/traffic-shared/dashboard';
import type { ActivityDashboardBase } from '../../../../src/handlers/commands/traffic-shared/dashboard/types';

const WEEKDAYS = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];

/** A solid-colour picture decoded into a canvas `Image`, like a CDN download. */
export const solidImage = (color: string, width = 32, height = width): Image => {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  const image = new Image();
  image.src = canvas.toBuffer('image/png');
  return image;
};

/** Deterministic 7 x 24 grid whose single peak is Sunday 23:00. */
export const fakeGrid = (scale = 1): number[][] =>
  WEEKDAYS.map((_, d) =>
    Array.from({ length: 24 }, (_, h) => Math.round(scale * (4 + d + (h >= 18 ? 3 * h : h)))),
  );

export const heatmap = (grid: number[][] = fakeGrid()): HeatmapSection => ({
  title: '活動熱度 · 星期 × 時段',
  grid,
  weekdayLabels: [...WEEKDAYS],
  lessLabel: '少',
  moreLabel: (max) => `多（每格最高 ${max} 則）`,
  peakLabel: (weekday, hour) => `高峰 ${weekday} ${hour} 時 · UTC+8`,
});

const series = (n: number, base: number, seed: number): number[] =>
  Array.from({ length: n }, (_, i) => Math.max(0, Math.round(base + ((i * seed) % 17) - 8)));

export const trend = (n: number, title = '每日訊息'): TrendSection => ({
  title,
  currentLabel: '本期',
  current: series(n, 40, 7),
  previous: { label: '前期 08/11 – 09/09', values: series(n, 36, 5) },
  xLabels: Array.from({ length: n }, (_, i) => `D${i + 1}`),
  xLabelEvery: n > 8 ? 7 : 1,
});

const heroMetrics = (): HeroMetric[] => [
  { label: '日均', value: '1,764' },
  { label: '活躍成員', value: '213' },
  { label: '活躍頻道', value: '37' },
];

const hero = (value: string, direction: 'up' | 'down'): HeroTile => ({
  label: '訊息',
  value,
  delta: { direction, text: direction === 'up' ? '8.2%' : '3.0%', sub: '較前期 11,410' },
  metrics: heroMetrics(),
});

/** `n` rows with strictly decreasing, always positive values. */
export const rankRows = (prefix: string, n: number): RankRow[] =>
  Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i + 1}`, value: 900 - i * 30 }));

const activityBase = (): Omit<ActivityDashboardBase, 'hero'> => ({
  tileRows: [
    [
      { label: '成員留存', value: '72%', sub: '前期 198 人中 143 人', flex: 1.45 },
      { label: '回流與新成員', value: '70', sub: '佔活躍成員 33%', flex: 1.1 },
      { label: '最活躍成員佔比', value: '6.1%', sub: '阿華 753 則', flex: 1.1 },
      { label: '最忙', value: '10/08', sub: '週四 · 2,108 則', flex: 1.2 },
    ],
  ],
  trend: trend(7),
  interactions: {
    title: '互動',
    rows: [
      { label: '回覆比例', value: '31%' },
      { label: 'Reaction', value: '8,901' },
      {
        label: ['最熱門 ', { image: null, fallback: ':thumbsup:' }],
        value: '1,203',
        secondary: true,
      },
      { label: '轉發', value: '88' },
      { label: '已編輯', value: '6.5%' },
    ],
  },
  content: {
    title: '內容類型',
    rows: [
      { label: '圖片與影片', value: 1820 },
      { label: '連結', value: 960 },
      { label: '貼圖', value: 410 },
      { label: '檔案', value: 75 },
      { label: '語音', value: 12 },
      { label: '投票', value: 6 },
    ],
  },
  heatmap: heatmap(),
});

export const overview = (): OverviewDashboard => ({
  ...activityBase(),
  hero: hero('12,345', 'up'),
  members: {
    title: '成員排行 · 前 10',
    rows: rankRows('成員', 10),
    note: '其他 203 位成員 6,980 則',
  },
  channels: {
    title: '頻道排行 · 前 10',
    rows: [
      ...rankRows('頻道', 6),
      { name: '每週心得', tag: '#創作論壇', value: 596 },
      ...rankRows('頻道', 3),
    ],
    note: '其他 27 個頻道 2,611 則',
  },
});

export const channel = (): ChannelDashboard => {
  const base = activityBase();
  return {
    ...base,
    hero: { ...hero('4,210', 'down'), metrics: heroMetrics().slice(0, 2) },
    tileRows: [(base.tileRows[0] ?? []).slice(0, 3)],
    trend: trend(30),
    members: { title: '成員排行 · 前 10', rows: rankRows('成員', 10) },
    breakdown: {
      title: '頻道與討論串排行 · 前 10',
      rows: [{ name: '#閒聊（頻道本身）', value: 1640 }, ...rankRows('討論串', 9)],
      note: '其他 7 個討論串 152 則',
    },
  };
};

export const person = (): PersonDashboard => ({
  ...activityBase(),
  hero: hero('820', 'up'),
  tileRows: [
    [
      { label: '活躍頻道', value: '13' },
      { label: '最忙', value: '10/02', sub: '週五 · 61 則' },
      { label: '活躍天數', value: '24', unit: '/ 30 天', sub: '最長連續 11 天' },
    ],
    [
      {
        label: '收到 reaction',
        value: '1,402',
        sub: ['最常收到 ', { image: null, fallback: ':joy:' }, ' 210'],
      },
      { label: '給出 reaction', value: '936', sub: '最常用 :thumbsup: 300' },
      { label: '使用指令', value: '33' },
    ],
  ],
  trend: trend(30),
  partners: {
    title: '最常互動的成員 · 前 10',
    rows: Array.from({ length: 10 }, (_, i) => ({
      name: `夥伴${i + 1}`,
      segments: [58 - i * 5, 14 - i],
    })),
  },
  partnerLegend: ['回覆往來', '提及往來'],
  channels: { title: '頻道分布 · 前 10', rows: rankRows('頻道', 10), note: '其他 3 個頻道 20 則' },
});

const members = (): RankingColumn => ({
  title: '最常使用的成員 · 前 10',
  rows: rankRows('成員', 10),
});

export const appRows = (n: number): AppsDashboard['ranking']['rows'] =>
  Array.from({ length: n }, (_, i) => ({
    name: `Bot ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? i : ''}`,
    icon: null,
    segments: [1050 / (i + 1), i % 2 === 0 ? 154 / (i + 1) : 0, i === 2 ? 8 : 0],
    users: `${Math.max(1, 88 - i * 6)} 人`,
    breakdown: '指令 1,050 · 元件 154',
  }));

export const apps = (): AppsDashboard => ({
  hero: { ...hero('1,690', 'up'), label: '互動' },
  ranking: {
    title: '應用程式排行',
    legend: ['指令', '元件（按鈕、選單）', '表單'],
    rows: appRows(5),
  },
  trend: trend(30, '每日互動'),
  members: members(),
});

export const appSingle = (): AppSingleDashboard => ({
  hero: { ...hero('1,204', 'up'), label: '互動' },
  types: {
    title: '互動類型',
    rows: [
      { label: '指令', value: 1050, valueText: '1,050（87.2%）' },
      { label: '元件（按鈕、選單）', value: 154, valueText: '154（12.8%）' },
      { label: '表單', value: 0, valueText: '0（0.0%）' },
    ],
  },
  trend: trend(30, '每日互動'),
  members: members(),
  heatmap: heatmap(fakeGrid(0.5)),
});

export const emojiRows = (n: number): EmojiDashboard['ranking']['rows'] =>
  Array.from({ length: n }, (_, i) => ({
    label: `:emoji_${i + 1}:`,
    image: null,
    animated: i % 4 === 2,
    inContent: Math.max(1, 300 - i * 10),
    inReactions: Math.max(1, 320 - i * 12),
  }));

export const emoji = (): EmojiDashboard => ({
  tiles: [
    { label: '伺服器表情', value: '48', unit: '個' },
    { label: '總使用', value: '6,320', unit: '次' },
    { label: '內文', value: '2,410' },
    { label: 'reaction', value: '3,910' },
    { label: '0 次', value: '7', unit: '個' },
  ],
  ranking: {
    title: '使用排行 · 前 20',
    contentLabel: '內文',
    reactionLabel: 'reaction',
    animatedTag: 'GIF',
    rows: emojiRows(20),
    note: '其餘 21 個合計 865 次（內文 330 · reaction 535）',
  },
  unused: {
    title: '沒有人用的表情',
    note: '共 7 個',
    zeroLabel: '0',
    names: [
      'old_logo',
      'april_fools',
      'event_2024',
      'test_emoji',
      'wip_blob',
      'retired_cat',
      'beta',
    ].map((n) => `:${n}:`),
  },
});

export const stickerRows = (n: number): StickerDashboard['ranking']['rows'] =>
  Array.from({ length: n }, (_, i) => ({
    name: `貼圖${i + 1}`,
    image: null,
    count: Math.max(1, 92 - i * 5),
  }));

export const sticker = (): StickerDashboard => ({
  tiles: [
    { label: '伺服器貼圖', value: '15', unit: '個' },
    { label: '總使用', value: '410', unit: '次' },
    { label: '0 次', value: '3', unit: '個' },
  ],
  ranking: {
    title: '使用排行',
    totalUses: 410,
    countCaption: (_count, percent) => `次 · ${percent}`,
    rows: stickerRows(12),
  },
  unused: {
    title: '沒有人用的貼圖',
    note: '共 3 個',
    zeroLabel: '0',
    names: ['舊版歡迎', '愚人節限定', '活動紀念'],
  },
});
