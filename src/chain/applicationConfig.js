/** Public configuration shared by browser, payment and research services. */
export const APPLICATION_SCHEMA = 'agentbl-application-v1';
export function resolveApplicationConfig(registry, requestedNetwork) {
  if (registry?.schema !== APPLICATION_SCHEMA || registry.scope !== 'research_test_assets_only') {
    throw new Error('Expected the current research application configuration');
  }
  const key = requestedNetwork ?? registry.defaultNetwork;
  const network = registry.networks?.[key];
  if (!network || Number(network.chainIdDecimal) !== 1439 || Number(network.chainId) !== 1439 || !network.rpcUrls?.length || network.protocolVersion !== 5 || network.accessModel !== 'compliance-gated') {
    throw new Error('Only the controlled Injective testnet application is supported');
  }
  const contracts = network.contracts ?? {};
  if (Object.keys(contracts).some(name => ['AgentBLRWA', 'EBLRegistry', 'RiskPricingOracle'].includes(name))) {
    throw new Error('Retired financing contracts cannot be configured');
  }
  return {
    ...network,
    key,
    defaultNetwork: registry.defaultNetwork,
    contracts: {
      ...contracts,
      RWAOfferingPool: contracts.RWAOfferingPoolV5,
      RWAToken: contracts.ControlledRWAToken
    },
    paymentOracle: contracts.PaymentOracle ? {
      address: contracts.PaymentOracle,
      ...network.deployments?.PaymentOracle,
      abi: network.abis?.PaymentOracle ?? []
    } : null
  };
}
