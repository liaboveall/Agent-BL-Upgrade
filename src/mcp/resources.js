import fs from 'node:fs/promises';
import { listHarnessCaseFiles } from '../core/scenarioRunner.js';
import {loadApplicationConfig} from '../chain/loadApplicationConfig.js';
import { publicAgentPolicy, externalDecision } from './agentTools.js';
import { callAgentBackend } from './agentClient.js';
import { HttpError } from '../app/http.js';
import { publicCaseFilter } from '../app/workspaceAccess.js';


export const MCP_RESOURCES = Object.freeze([
  Object.freeze({ uri: 'agentbl://agent/policy', name: 'Agent Policy',
    description: 'Current public policy, autonomy and operator-event boundaries', mimeType: 'application/json' }),
  Object.freeze({ uri: 'agentbl://agent/decisions/recent', name: 'Recent Agent Decisions',
    description: 'Latest 20 redacted decisions from the existing application runtime', mimeType: 'application/json' }),
  Object.freeze({
    uri: 'agentbl://cases/catalog',
    name: 'Trade Case Catalog',
    description: 'Redacted catalog of available eBL-backed financing cases',
    mimeType: 'application/json'
  }),
  Object.freeze({
    uri: 'agentbl://risk/methodology',
    name: 'Risk Pricing Methodology',
    description: 'Public risk dimensions, pricing boundaries, and non-guarantee policy',
    mimeType: 'application/json'
  }),
  Object.freeze({
    uri: 'agentbl://contracts/deployments',
    name: 'Injective Contract Deployments',
    description: 'Public Injective network, contract addresses, ABIs, and explorer evidence',
    mimeType: 'application/json'
  })
]);

function content(uri, value) {
  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(value, null, 2)
    }]
  };
}

async function caseCatalog() {
  const cases = [];
  for (const file of await listHarnessCaseFiles({ includeDemo: true })) {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      const bill = value.bill_of_lading ?? {};
      cases.push({
        case_id: value.case_id,
        cargo: bill.cargo ?? value.cargo?.commodity ?? null,
        route: [bill.port_of_loading, bill.port_of_discharge].filter(Boolean).join(' -> '),
        payout_speed: value.financing?.payout_speed ?? null
      });
    } catch {
      // Invalid fixtures are rejected by the normal case/schema path; do not
      // expose partial document content through a resource.
    }
  }
  return { count: cases.length, cases };
}

async function deploymentEvidence() {
 const config=loadApplicationConfig();
 return {network:config.network,chainId:config.chainId,chainIdDecimal:config.chainIdDecimal,protocolVersion:5,scope:'research_test_assets_only',explorerBase:config.explorerBase,contracts:config.contracts,deployments:config.deployments,rightsConfig:config.rightsConfig};
}

function riskMethodology() {
  return {
    version: 'agentbl-risk-v1',
    dimensions: [
      'document_integrity',
      'route_and_geopolitical',
      'cargo_and_market',
      'counterparty_and_country',
      'insurance_and_coverage',
      'shipment_events'
    ],
    pricing: {
      unit: 'basis_points',
      output: ['risk_level', 'risk_discount_bps', 'final_issue_price_usd', 'pricing_action'],
      evidenceRequired: true
    },
    boundaries: {
      targetRedemptionGuaranteed: false,
      paidIntelChangesProtocolStateAutomatically: false,
      chainWritesRequirePolicyApproval: true
    }
  };
}

export async function readMcpResource(uri, context) {
  if (typeof uri !== 'string' || !uri.startsWith('agentbl://')) {
    throw Object.assign(new Error('Resource URI must use the agentbl:// scheme'), { code: -32602 });
  }
  if (uri === 'agentbl://cases/catalog') return content(uri, await caseCatalog());
  if (uri === 'agentbl://risk/methodology') return content(uri, riskMethodology());
  if (uri === 'agentbl://contracts/deployments') return content(uri, await deploymentEvidence());
  if (['agentbl://agent/policy', 'agentbl://agent/decisions/recent'].includes(uri)) {
    try {
      if (uri === 'agentbl://agent/policy') {
        const policy = context ? await publicAgentPolicy(context.getService())
          : (await callAgentBackend('get_agent_policy')).result;
        return content(uri, policy);
      }
      const result = context ? await context.getService().listDecisions({ limit: 20, caseFilter: publicCaseFilter(context.getService()) })
        : (await callAgentBackend('list_agent_decisions', { limit: 20 })).result;
      return content(uri, { ...result, decisions: result.decisions.map(externalDecision) });
    } catch (error) {
      throw Object.assign(new Error(error instanceof HttpError ? error.message : 'Agent runtime resource is unavailable'), { code: -32603 });
    }
  }
  throw Object.assign(new Error(`Unknown resource URI: ${uri}`), { code: -32002 });
}
