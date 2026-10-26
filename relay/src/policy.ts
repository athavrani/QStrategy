export interface Route {
  /** Changes state at Dhan (places, modifies or cancels something). */
  write: boolean;
  /** Carries a correlationId, so a repeat of the same request must not create a second order. */
  idempotent: boolean;
}

const ID = '[A-Za-z0-9-]{1,40}';
const DATE = '\\d{4}-\\d{2}-\\d{2}';
const LEG = '(?:ENTRY_LEG|TARGET_LEG|STOP_LOSS_LEG)';

const R = (write: boolean, idempotent = false): Route => ({ write, idempotent });

// Only these Dhan endpoints can be reached through the relay; everything else is refused.
const RULES: Array<[string, RegExp, Route]> = [
  ['POST', /^\/orders$/, R(true, true)],
  ['POST', /^\/orders\/slicing$/, R(true)],
  ['GET', /^\/orders$/, R(false)],
  ['GET', /^\/orders\/external\/[A-Za-z0-9_.-]{1,30}$/, R(false)],
  ['GET', new RegExp(`^/orders/${ID}$`), R(false)],
  ['PUT', new RegExp(`^/orders/${ID}$`), R(true)],
  ['DELETE', new RegExp(`^/orders/${ID}$`), R(true)],

  ['POST', /^\/super\/orders$/, R(true, true)],
  ['GET', /^\/super\/orders$/, R(false)],
  ['PUT', new RegExp(`^/super/orders/${ID}$`), R(true)],
  ['DELETE', new RegExp(`^/super/orders/${ID}/${LEG}$`), R(true)],

  ['GET', /^\/trades$/, R(false)],
  ['GET', new RegExp(`^/trades/${ID}$`), R(false)],
  ['GET', new RegExp(`^/trades/${DATE}/${DATE}/\\d{1,5}$`), R(false)],

  ['GET', /^\/positions$/, R(false)],
  ['DELETE', /^\/positions$/, R(true)],
  ['POST', /^\/positions\/convert$/, R(true)],
  ['GET', /^\/holdings$/, R(false)],
  ['GET', /^\/fundlimit$/, R(false)],

  ['GET', /^\/killswitch$/, R(false)],
  ['POST', /^\/killswitch$/, R(true)],
  ['GET', /^\/pnlExit$/, R(false)],
  ['POST', /^\/pnlExit$/, R(true)],
  ['DELETE', /^\/pnlExit$/, R(true)],

  ['POST', /^\/margincalculator$/, R(false)],
  ['POST', /^\/margincalculator\/multi$/, R(false)],

  ['GET', /^\/alerts\/orders$/, R(false)],
  ['POST', /^\/alerts\/orders$/, R(true)],
  ['POST', /^\/alerts\/multi\/orders$/, R(true)],
  ['GET', new RegExp(`^/alerts/orders/${ID}$`), R(false)],
  ['PUT', new RegExp(`^/alerts/orders/${ID}$`), R(true)],
  ['DELETE', new RegExp(`^/alerts/orders/${ID}$`), R(true)],
];

export function matchRoute(method: string, path: string): Route | null {
  const m = method.toUpperCase();
  for (const [verb, re, route] of RULES) {
    if (verb === m && re.test(path)) return route;
  }
  return null;
}

/** Rejects anything that could change which host or path the request reaches. */
export function isSafeTarget(path: string, query: string): boolean {
  if (!/^(\/[A-Za-z0-9_.-]+)+$/.test(path)) return false;
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  return query === '' || /^\?[A-Za-z0-9_=&.,:-]{0,200}$/.test(query);
}
