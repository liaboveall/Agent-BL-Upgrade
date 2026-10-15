import { z } from 'zod';
import { MCP_TOOLS_MANIFEST } from '../mcp/mcpServer.js';
import { discoveryCatalog } from '../x402/discovery.js';

export const A2A_VERSION = '1.0';
export const INTEROP_EXTENSION = 'urn:agentbl:interop:v1';

// AgentCard 1.0 uses supportedInterfaces, with protocolVersion on each interface.
// The old top-level url/protocolVersion/preferredTransport fields are deliberately absent.
export const agentCardSchema = z.object({
  name: z.string().min(1), description: z.string().min(1), version: z.string().min(1),
  supportedInterfaces: z.array(z.object({ url: z.url(), protocolBinding: z.literal('JSONRPC'), protocolVersion: z.literal(A2A_VERSION) }).strict()).min(1),
  capabilities: z.object({ streaming: z.literal(false), pushNotifications: z.literal(false),
    extendedAgentCard: z.literal(false), extensions: z.array(z.object({ uri: z.string(), description: z.string(), required: z.boolean(), params: z.record(z.string(), z.unknown()) }).strict()) }).strict(),
  defaultInputModes: z.array(z.string()).min(1), defaultOutputModes: z.array(z.string()).min(1),
  skills: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string().min(1),
    tags: z.array(z.string()).min(1), examples: z.array(z.string()), inputModes: z.array(z.string()), outputModes: z.array(z.string()) }).strict()).min(1)
}).strict();

export function createAgentCard({ origin, env = process.env, mode = 'demo' }) {
  const catalog = discoveryCatalog({ origin, env, mode });
  return agentCardSchema.parse({
    name: 'AgentBL Pricing Agent', version: '3.0.0',
    description: 'Indicative eBL-backed trade pricing with deterministic risk, versioned demo compliance and optional delivered x402 report provenance. No transaction or report purchase is executed by delegation.',
    supportedInterfaces: [{ url: `${origin}/api/a2a`, protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false,
      extensions: [{ uri: INTEROP_EXTENSION, required: false, description: 'AgentBL structured pricing input, MCP tools, runtime reads and paid-service discovery.',
        params: { pricingInput: `${origin}/api/interop/schemas/delegate-pricing`,
          mcp: { transport: 'stdio', command: 'npm run mcp:stdio', backend: origin, tools: MCP_TOOLS_MANIFEST.map(({ name }) => name) },
          status: `${origin}/api/agent/status`, decisions: `${origin}/api/agent/decisions`,
          discovery: `${origin}/api/x402/discovery`, paidServices: catalog.items,
          security: { publicQuotation: true, eventSubmissionRequiresHostToken: true, liveExecutionRequiresSeparateApproval: true }, mode } }]
    },
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: [{ id: 'delegate_pricing', name: 'Delegate trade pricing',
      description: 'Send a ROLE_USER message containing exactly one JSON data part matching the pricingInput schema. Returns a synchronous ROLE_AGENT Message with PricingQuote and assessment. Optional paid_report_ids refer to reports already delivered by this server.',
      tags: ['trade-finance', 'pricing', 'ebl', 'x402-provenance'], examples: ['Quote CASE-EBL-2026-0001 without executing a transaction.'],
      inputModes: ['application/json'], outputModes: ['application/json'] }]
  });
}
