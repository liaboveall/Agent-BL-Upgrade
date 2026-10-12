// Least-privilege signing keys for the long-running server.
//
// DEPLOYER_PRIVATE_KEY is the contract OWNER key. The server used to sign
// PaymentOracle attestations and RiskPricingOracle updates with it, so a web-server
// compromise meant losing every contract. Both contracts already have a scoped role
// for this (PaymentOracle.setAttestor, RiskPricingOracle.setUpdater), so each runtime
// role now has its own key. The owner key is only a deprecated fallback.
//
// SIGNER_KEYS_STRICT=true refuses the fallback altogether (recommended in production).

export const SIGNER_ROLES = Object.freeze({
  PAYMENT_ATTESTOR: Object.freeze({
    env: 'PAYMENT_ATTESTOR_PRIVATE_KEY',
    contractRole: 'PaymentOracle.setAttestor(address,true)'
  }),
  PRICING_UPDATER: Object.freeze({
    env: 'PRICING_UPDATER_PRIVATE_KEY',
    contractRole: 'RiskPricingOracle.setUpdater(address,true)'
  }),
  // OPTIONAL (docs/agent-implementation-plan.md D2). Only when this key is set can the server itself send
  // markInTransit / recordImporterPayment / recordCargoArrival / settle; otherwise an operator signs them
  // with the owner key through `npm run agent:approve`. It never falls back to the owner key.
  AGENT_EXECUTOR: Object.freeze({
    env: 'AGENT_EXECUTOR_PRIVATE_KEY',
    contractRole: 'RWAOfferingPool.setAgentExecutor(address,true)',
    optional: true,
    noOwnerFallback: true
  })
});

export const OWNER_KEY_ENV = 'DEPLOYER_PRIVATE_KEY';

const warned = new Set();

function strictMode(env) {
  return ['true', '1', 'yes'].includes(String(env.SIGNER_KEYS_STRICT ?? '').toLowerCase());
}

/**
 * Resolve the private key for a server role.
 * @returns {{ privateKey: string, source: string, dedicated: boolean } | null}
 *          null when no usable key is configured (or the fallback is forbidden).
 */
export function resolveSignerKey(roleName, env = process.env, { warn = console.warn } = {}) {
  const role = SIGNER_ROLES[roleName];
  if (!role) throw new TypeError(`Unknown signer role: ${roleName}`);

  const dedicated = env[role.env]?.trim();
  if (dedicated) return { privateKey: dedicated, source: role.env, dedicated: true };
  if (role.noOwnerFallback) return null;

  const owner = env[OWNER_KEY_ENV]?.trim();
  if (!owner || strictMode(env)) return null;

  if (!warned.has(roleName)) {
    warned.add(roleName);
    warn(
      `[agentbl] WARNING: ${role.env} is not set, so ${roleName} signs with ${OWNER_KEY_ENV} (the contract OWNER key). ` +
      `Create a dedicated key, authorise it with ${role.contractRole}, and set ${role.env}; ` +
      'SIGNER_KEYS_STRICT=true turns this fallback off.'
    );
  }
  return { privateKey: owner, source: OWNER_KEY_ENV, dedicated: false };
}

/** The env vars an operator must set for a role (used in error messages). */
export function signerKeyRequirement(roleName) {
  const role = SIGNER_ROLES[roleName];
  return `${role.env} (authorised via ${role.contractRole})`;
}

/** Test hook: forget which fallback warnings were already printed. */
export function resetSignerKeyWarnings() {
  warned.clear();
}
