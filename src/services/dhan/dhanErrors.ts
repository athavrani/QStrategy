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
      // Dhan uses {errorType, errorCode, errorMessage}; older responses nest the same fields under `remarks`.
      const remarks = parsed?.remarks && typeof parsed.remarks === 'object' ? parsed.remarks : null;
      const pick = (...vals: unknown[]): string | null => {
        const hit = vals.find((v) => typeof v === 'string' && v !== '');
        return typeof hit === 'string' ? hit : null;
      };
      const msg = pick(
        parsed?.errorMessage,
        parsed?.error_message,
        remarks?.error_message,
        remarks?.errorMessage,
        parsed?.message,
        parsed?.remarks
      );
      const code = pick(parsed?.errorCode, parsed?.error_code, remarks?.error_code, remarks?.errorCode);
      if (msg) return { message: `${msg} (HTTP ${res.status})`, code };
      if (code) return { message: `Dhan error ${code} (HTTP ${res.status})`, code };
    } catch {
      // Plain-text body: fall through to the raw text.
    }
    return { message: `${text.slice(0, 200)} (HTTP ${res.status})`, code: null };
  }
  return { message: `Dhan returned HTTP ${res.status}.`, code: null };
}
