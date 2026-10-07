import {
  archiveManifestCategoryExpression,
  type ArchiveManifestCategory,
} from '../../core/archive/manifest-summary';
import type { ArchiveManifestGroupFilter } from '../../core/archive/manifest-target';

export const MANIFEST_QUERY_TIMEOUT_MS = 5000;
const expressionString = (value: unknown): Record<string, unknown> => ({
  $cond: [{ $eq: [{ $type: value }, 'string'] }, value, ''],
});
const validId = (value: unknown): Record<string, unknown> => ({
  $regexMatch: { input: expressionString(value), regex: '^\\d{1,20}$' },
});
const firstId = (values: string[]): Record<string, unknown> => ({
  $reduce: {
    input: values,
    initialValue: null,
    in: { $cond: [{ $and: [{ $eq: ['$$value', null] }, validId('$$this')] }, '$$this', '$$value'] },
  },
});
const imagePaths = ['after', 'before', 'after.snapshot', 'before.snapshot'];
const paths = (...fields: string[]): string[] =>
  imagePaths.flatMap((image) => fields.map((field) => `$${image}.${field}`));

/** Legacy cursor IDs and quarantine snapshot IDs share one validated source namespace. */
export const archiveOperationSourceExpression = (): Record<string, unknown> => ({
  $let: {
    vars: { source: firstId(paths('channelId', 'channelID')) },
    in: {
      $cond: [
        {
          $anyElementTrue: [
            {
              $map: {
                input: paths('channelId', 'channelID'),
                as: 'candidate',
                in: { $and: [validId('$$candidate'), { $ne: ['$$candidate', '$$source'] }] },
              },
            },
          ],
        },
        null,
        '$$source',
      ],
    },
  },
});

export const archiveOperationImpactExpression = (): Record<string, unknown> => ({
  $switch: {
    branches: [
      ['insert', 'null', 'object'],
      ['update', 'object', 'object'],
      ['delete', 'object', 'null'],
    ].map(([impact, before, after]) => ({
      case: {
        $and: [{ $eq: [{ $type: '$before' }, before] }, { $eq: [{ $type: '$after' }, after] }],
      },
      then: impact,
    })),
    default: 'unknown',
  },
});
const archiveSafeReferenceExpression = (
  value: string,
  fallback: string,
): Record<string, unknown> => ({
  $cond: [
    { $regexMatch: { input: expressionString(value), regex: '^[A-Za-z0-9:_-]{1,160}$' } },
    value,
    fallback,
  ],
});
export const archiveOperationStateExpression = (): Record<string, unknown> => ({
  $cond: [
    { $in: ['$state', ['planned', 'journaled', 'applied', 'verified', 'rolled-back', 'conflict']] },
    '$state',
    'unknown',
  ],
});
const firstString = (values: string[]): Record<string, unknown> => ({
  $reduce: {
    input: values,
    initialValue: '',
    in: {
      $cond: [
        { $and: [{ $eq: ['$$value', ''] }, { $ne: [expressionString('$$this'), ''] }] },
        { $substrCP: [expressionString('$$this'), 0, 100] },
        '$$value',
      ],
    },
  },
});

const safeScalar = (value: unknown, regex: string): Record<string, unknown> => ({
  $switch: {
    branches: [
      { case: { $eq: [{ $type: value }, 'null'] }, then: null },
      { case: { $in: [{ $type: value }, ['int', 'long', 'double']] }, then: value },
      { case: { $regexMatch: { input: expressionString(value), regex } }, then: value },
    ],
    default: '$$REMOVE',
  },
});
const cursorValue = (image: string): Record<string, unknown> => ({
  $let: {
    vars: {
      candidate: {
        $cond: [
          { $eq: [{ $type: `$${image}.lastMessageID` }, 'missing'] },
          `$${image}.lastMessageId`,
          `$${image}.lastMessageID`,
        ],
      },
    },
    in: safeScalar('$$candidate', '^\\d{0,20}$'),
  },
});
const documentReference = (field: string): Record<string, unknown> => ({
  $cond: [
    { $in: [{ $type: field }, ['string', 'objectId', 'int', 'long', 'double']] },
    field,
    '$$REMOVE',
  ],
});
const exclusionReasons = [
  'bot-not-allowlisted',
  'webhook-not-allowlisted',
  'rule-exclude',
  'guild-out-of-scope',
];
const exclusionEvidence = (
  policyHash: string | undefined,
  rule: boolean,
): Record<string, unknown> | string =>
  policyHash === undefined
    ? '$$REMOVE'
    : {
        $reduce: {
          input: imagePaths.map((image) => `$${image}.archiveSourceDecision`),
          initialValue: '',
          in: {
            $cond: [
              {
                $and: [
                  { $eq: ['$$value', ''] },
                  { $eq: ['$$this.admitted', false] },
                  { $eq: ['$$this.policyHash', policyHash] },
                  { $in: ['$$this.reason', rule ? ['rule-exclude'] : exclusionReasons] },
                ],
              },
              rule ? archiveSafeReferenceExpression('$$this.ruleId', '') : '$$this.reason',
              '$$value',
            ],
          },
        },
      };
const quarantineReason = (): Record<string, unknown> => ({
  $switch: {
    branches: [
      ['conflicting channelId', 'conflicting-channel-id'],
      ['conflicting userId', 'conflicting-user-id'],
      ['conflicting timestamp', 'conflicting-timestamp'],
      ...['content', 'attachments', 'reactions', 'stickers', 'embeds'].map((field) => [
        `conflicting ${field}`,
        'conflicting-message-data',
      ]),
    ].map(([stored, display]) => ({ case: { $eq: ['$after.reason', stored] }, then: display })),
    default: archiveSafeReferenceExpression('$after.reason', 'unknown'),
  },
});
/** The projection never returns recovery images, content, author identities or attachment URLs. */
export const archiveOperationProjection = (policyHash?: string): Record<string, unknown> => ({
  _id: 1,
  sequence: 1,
  collection: archiveSafeReferenceExpression('$collection', 'unknown'),
  documentId: {
    $cond: [
      { $in: [{ $type: '$documentId' }, ['string', 'objectId', 'int', 'long', 'double']] },
      '$documentId',
      '$$REMOVE',
    ],
  },
  state: archiveOperationStateExpression(),
  reason: archiveSafeReferenceExpression('$reason', 'other'),
  dependencyCount: { $cond: [{ $isArray: '$dependencies' }, { $size: '$dependencies' }, 0] },
  dependencies: {
    $slice: [
      {
        $filter: {
          input: { $cond: [{ $isArray: '$dependencies' }, '$dependencies', []] },
          as: 'dependency',
          cond: {
            $regexMatch: {
              input: expressionString('$$dependency'),
              regex: '^[A-Za-z0-9:_-]{1,160}$',
            },
          },
        },
      },
      100,
    ],
  },
  beforeHash: archiveSafeReferenceExpression('$beforeHash', ''),
  afterHash: archiveSafeReferenceExpression('$afterHash', ''),
  impact: archiveOperationImpactExpression(),
  sourceId: archiveOperationSourceExpression(),
  messageId: firstId(paths('messageId', 'messageID')),
  parentId: firstId(paths('parentId', 'parentID')),
  historicalName: firstString(paths('channelName', 'channel')),
  sourceType: {
    $reduce: {
      input: paths('channelType', 'sourceType'),
      initialValue: null,
      in: {
        $cond: [
          {
            $and: [
              { $eq: ['$$value', null] },
              { $in: [{ $type: '$$this' }, ['int', 'long', 'double']] },
            ],
          },
          '$$this',
          '$$value',
        ],
      },
    },
  },
  beforeLastMessageId: cursorValue('before'),
  afterLastMessageId: cursorValue('after'),
  beforeTimestamp: safeScalar('$before.timestamp', '^\\d{1,16}$'),
  afterTimestamp: safeScalar('$after.timestamp', '^\\d{1,16}$'),
  policyRuleId: exclusionEvidence(policyHash, true),
  policyReason: exclusionEvidence(policyHash, false),
  quarantineReason: quarantineReason(),
  quarantineSourceDocumentId: documentReference('$after.sourceId'),
  quarantineSnapshotDocumentId: documentReference('$after.snapshot._id'),
  quarantineSourceCollection: {
    $cond: [
      { $in: ['$after.sourceCollection', ['fetches', 'messages']] },
      '$after.sourceCollection',
      {
        // Legacy message evidence omitted sourceCollection but retained message identity in its snapshot.
        $cond: [
          {
            $and: [
              { $eq: [{ $type: '$after.sourceCollection' }, 'missing'] },
              validId('$after.snapshot.channelId'),
              validId('$after.snapshot.messageId'),
            ],
          },
          'messages',
          'unknown',
        ],
      },
    ],
  },
});

export const archiveManifestFilter = (options: {
  category?: ArchiveManifestCategory;
  group?: ArchiveManifestGroupFilter;
  sourceId?: string;
}): Record<string, unknown> => {
  const expressions: Record<string, unknown>[] = [];
  if (options.category !== undefined)
    expressions.push({ $eq: [archiveManifestCategoryExpression(), options.category] });
  if (options.group !== undefined) {
    expressions.push(
      { $eq: [archiveSafeReferenceExpression('$reason', 'other'), options.group.reason] },
      { $eq: [archiveSafeReferenceExpression('$collection', 'unknown'), options.group.collection] },
      { $eq: [archiveOperationImpactExpression(), options.group.impact] },
    );
  }
  if (options.sourceId !== undefined)
    expressions.push({
      $eq: [
        archiveOperationSourceExpression(),
        options.sourceId === 'unknown' ? null : options.sourceId,
      ],
    });
  return expressions.length === 0 ? {} : { $expr: { $and: expressions } };
};
