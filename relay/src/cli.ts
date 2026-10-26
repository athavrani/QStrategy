import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { RelayDb } from './db.js';
import { createUpstream } from './upstream.js';

const USAGE = `Usage: relay-cli <command>
  egress                          Print the public IP Dhan sees (whitelist this in Dhan)
  invite [--label X] [--hours 24] [--client-id N]
                                  Create a single-use invite code for one phone
  tenants                         List Dhan accounts
  devices                         List registered phones
  audit [--client-id N] [--limit 50]
                                  Show recent requests (no tokens or bodies are stored)
  revoke <deviceId>               Block a phone
  restore <deviceId>              Unblock a phone
  suspend <dhanClientId>          Block every phone of an account
  resume <dhanClientId>           Unblock an account`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    label: { type: 'string' },
    hours: { type: 'string', default: '24' },
    'client-id': { type: 'string' },
    limit: { type: 'string', default: '50' },
  },
});
const [command, arg] = positionals;
const config = loadConfig();

async function main(): Promise<void> {
  if (command === 'egress') {
    const ip = await createUpstream(config).egressIp();
    console.log(ip ?? 'Could not determine the egress IP.');
    process.exitCode = ip ? 0 : 1;
    return;
  }

  const db = new RelayDb(config.dbPath);
  try {
    switch (command) {
      case 'invite': {
        const hours = Number(values.hours);
        if (!Number.isFinite(hours) || hours <= 0) throw new Error('--hours must be a positive number.');
        const code = db.createInvite({ label: values.label, hours, dhanClientId: values['client-id'], now: Date.now() });
        console.log(`Invite code (single use, valid ${hours}h):\n  ${code}`);
        break;
      }
      case 'tenants':
        console.table(db.listTenants());
        break;
      case 'devices':
        console.table(db.listDevices().map(({ public_key, ...rest }) => rest));
        break;
      case 'audit': {
        const limit = Math.min(1000, Math.max(1, Number(values.limit) || 50));
        console.table(db.recentAudit(limit, values['client-id']));
        break;
      }
      case 'revoke':
      case 'restore':
        if (!arg) throw new Error('Device id required.');
        console.log(db.setDeviceStatus(arg, command === 'revoke' ? 'revoked' : 'active') ? 'Done.' : 'No such device.');
        break;
      case 'suspend':
      case 'resume':
        if (!arg) throw new Error('Dhan client id required.');
        console.log(db.setTenantStatus(arg, command === 'suspend' ? 'suspended' : 'active') ? 'Done.' : 'No such account.');
        break;
      default:
        console.log(USAGE);
        process.exitCode = command ? 1 : 0;
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
