/** Turns a failed Dhan REST response into one readable line. Dhan errors look like {errorType, errorCode, errorMessage}. */

import type { GatewayResponse } from './DhanRestGateway';

export interface DhanErrorInfo {
  message: string;
  code: string | null;
}

export function parseDhanError(res: Pick<GatewayResponse, 'status' | 'errorText'>): DhanErrorInfo {
  if (res.status === 401) {
    return { message: 'Access token expired or not authorised (HTTP 401).', code: 'DH-901' };
  }
  const text = (res.errorText || '').trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      const msg = parsed?.errorMessage ?? parsed?.message ?? parsed?.remarks;
      const code = typeof parsed?.errorCode === 'string' ? parsed.errorCode : null;
      if (typeof msg === 'string' && msg) return { message: `${msg} (HTTP ${res.status})`, code };
      if (code) return { message: `Dhan error ${code} (HTTP ${res.status})`, code };
    } catch {
      // Plain-text body: fall through to the raw text.
    }
    return { message: `${text.slice(0, 200)} (HTTP ${res.status})`, code: null };
  }
  return { message: `Dhan returned HTTP ${res.status}.`, code: null };
}
