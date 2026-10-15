export interface PanelId {
  sessionId: string;
  action: string;
  detail: string;
  nonce?: string;
}
export const panelId = (sessionId: string, action: string, detail = '', nonce?: string): string => {
  const value = `settings|${sessionId}|${action}|${detail}${nonce === undefined ? '' : `|${nonce}`}`;
  if (!parsePanelId(value)) throw new Error('Invalid settings component identifier');
  return value;
};
export const parsePanelId = (value: string): PanelId | undefined => {
  if (value.length > 100) return undefined;
  const parts = value.split('|');
  const [prefix, sessionId, action, detail, nonce] = parts;
  if (
    (parts.length !== 4 && parts.length !== 5) ||
    prefix !== 'settings' ||
    !sessionId ||
    !/^[\w-]+$/.test(sessionId) ||
    !action ||
    !/^[\w-]+$/.test(action) ||
    detail === undefined ||
    !/^[\w-]*$/.test(detail) ||
    (nonce !== undefined && (!/^[\w-]+$/.test(nonce) || action !== 'modal')) ||
    (action === 'modal' && nonce === undefined)
  )
    return undefined;
  return { sessionId, action, detail, ...(nonce === undefined ? {} : { nonce }) };
};
