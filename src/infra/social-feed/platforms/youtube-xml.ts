import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface YouTubeXmlNode {
  readonly namespace: string;
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: YouTubeXmlNode[];
  text: string;
}

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const QUALIFIED_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
const validCharacter = (value: number): boolean =>
  value === 9 ||
  value === 10 ||
  value === 13 ||
  (value >= 0x20 && value <= 0xd7ff) ||
  (value >= 0xe000 && value <= 0xfffd) ||
  (value >= 0x10000 && value <= 0x10ffff);

const decodeText = (raw: string): string => {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    lt: '<',
    gt: '>',
    apos: "'",
    quot: '"',
  };
  if (raw.includes(']]>')) throw new Error('Invalid XML text');
  return raw.replace(/&([^;]*);|&/g, (_match: string, entity: string | undefined): string => {
    if (entity === undefined) throw new Error('Unterminated XML entity');
    if (Object.hasOwn(named, entity)) return named[entity]!;
    if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) throw new Error('Unknown XML entity');
    const value = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number(entity.slice(1));
    if (!validCharacter(value)) throw new Error('Invalid XML numeric entity');
    return String.fromCodePoint(value);
  });
};

/** Disable declarations before invoking a parser that otherwise supports DOCTYPE entities. */
const validateSpecialMarkup = (body: string): void => {
  const markers = /<!|<\?/g;
  let marker: RegExpExecArray | null;
  while ((marker = markers.exec(body)) !== null) {
    const start = marker.index;
    if (body.startsWith('<!--', start)) {
      const end = body.indexOf('-->', start + 4);
      const content = body.slice(start + 4, end);
      if (end < 0 || content.includes('--') || content.endsWith('-'))
        throw new Error('Invalid XML comment');
      markers.lastIndex = end + 3;
    } else if (body.startsWith('<![CDATA[', start)) {
      const end = body.indexOf(']]>', start + 9);
      if (end < 0) throw new Error('Unterminated XML CDATA');
      markers.lastIndex = end + 3;
    } else if (body.startsWith('<?xml', start) && start === 0) {
      const declaration =
        /^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/.exec(
          body,
        );
      if (declaration === null) throw new Error('Unsupported XML declaration');
      markers.lastIndex = declaration[0].length;
    } else throw new Error('XML declarations and processing instructions are forbidden');
  }
};

const recordOf = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid XML node');
  return value as Record<string, unknown>;
};

/** Use the maintained parser for XML structure and retain namespace URIs at the boundary. */
export const parseYouTubeXml = (body: string): YouTubeXmlNode => {
  if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) throw new Error('XML body too large');
  for (const character of body) {
    if (!validCharacter(character.codePointAt(0)!)) throw new Error('Invalid XML character');
  }
  const input = body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  validateSpecialMarkup(input);
  if (XMLValidator.validate(input) !== true) throw new Error('Malformed XML document');
  let nodeCount = 0;
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: false,
    ignoreDeclaration: true,
    cdataPropName: '#cdata',
    commentPropName: '#comment',
    maxNestedTags: 32,
    updateTag: (name: string): string => {
      if (++nodeCount > 10_000) throw new Error('XML complexity limit exceeded');
      if (!QUALIFIED_NAME.test(name)) throw new Error('Unsupported XML qualified name');
      return name;
    },
    onDangerousProperty: (): never => {
      throw new Error('Forbidden XML property name');
    },
  });
  const parsed: unknown = parser.parse(input);
  const convert = (
    items: unknown,
    inherited: ReadonlyMap<string, string>,
    depth: number,
  ): YouTubeXmlNode[] => {
    if (!Array.isArray(items) || depth > 32) throw new Error('XML complexity limit exceeded');
    const result: YouTubeXmlNode[] = [];
    for (const item of items) {
      const record = recordOf(item);
      const keys = Object.keys(record).filter((key) => key !== ':@');
      if (keys.length !== 1) throw new Error('Invalid XML node shape');
      const qualifiedName = keys[0]!;
      if (qualifiedName === '#comment') continue;
      if (qualifiedName.startsWith('#') || qualifiedName.startsWith('?'))
        throw new Error('Unexpected XML document content');
      const attributes = new Map<string, string>();
      if (record[':@'] !== undefined) {
        for (const [name, value] of Object.entries(recordOf(record[':@']))) {
          if (!QUALIFIED_NAME.test(name) || typeof value !== 'string' || value.includes('<'))
            throw new Error('Invalid XML attribute');
          attributes.set(name, decodeText(value.replace(/[\t\n]/g, ' ')));
        }
      }
      const namespaces = new Map(inherited);
      for (const [name, value] of attributes) {
        if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
        const prefix = name === 'xmlns' ? '' : name.slice(6);
        if (
          prefix === 'xmlns' ||
          value === XMLNS_NAMESPACE ||
          (prefix === 'xml') !== (value === XML_NAMESPACE) ||
          (prefix !== '' && value === '')
        )
          throw new Error('Invalid XML namespace binding');
        namespaces.set(prefix, value);
      }
      const expand = (name: string, isAttribute: boolean): [string, string] => {
        const parts = name.split(':');
        if (parts.length === 1) return [isAttribute ? '' : (namespaces.get('') ?? ''), name];
        const namespace = namespaces.get(parts[0]!);
        if (
          parts.length !== 2 ||
          namespace === undefined ||
          parts[0] === 'xmlns' ||
          parts[1] === ''
        )
          throw new Error('Unbound XML namespace');
        return [namespace, parts[1]!];
      };
      const expandedAttributes = new Map<string, string>();
      for (const [name, value] of attributes) {
        if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
        const [namespace, local] = expand(name, true);
        const key = namespace === '' ? local : '{' + namespace + '}' + local;
        if (expandedAttributes.has(key)) throw new Error('Duplicate expanded XML attribute');
        expandedAttributes.set(key, value);
      }
      const [namespace, name] = expand(qualifiedName, false);
      const node: YouTubeXmlNode = {
        namespace,
        name,
        attributes: expandedAttributes,
        children: [],
        text: '',
      };
      const contents = record[qualifiedName];
      if (!Array.isArray(contents)) throw new Error('Invalid XML element contents');
      for (const child of contents) {
        const content = recordOf(child);
        if (Object.hasOwn(content, '#text')) {
          if (typeof content['#text'] !== 'string') throw new Error('Invalid XML text');
          node.text += decodeText(content['#text']);
        } else if (Object.hasOwn(content, '#cdata')) {
          const value = content['#cdata'];
          if (
            !Array.isArray(value) ||
            value.length !== 1 ||
            typeof recordOf(value[0])['#text'] !== 'string'
          )
            throw new Error('Invalid XML CDATA');
          node.text += recordOf(value[0])['#text'];
        } else node.children.push(...convert([child], namespaces, depth + 1));
      }
      result.push(node);
    }
    return result;
  };
  const roots = convert(parsed, new Map([['xml', XML_NAMESPACE]]), 0);
  if (roots.length !== 1) throw new Error('Expected one XML document root');
  return roots[0]!;
};
